// ==================== Sendspin 流式音源(滑动窗口) ====================
//
// 动机:默认音源(`streamEngine.defaultSource`)把整曲一次解成内存 F32 ——
// 320 秒 ≈ 122MB,切歌新旧重叠 ×2 ≈ 250MB,超长单曲直接顶爆子进程堆
// (fork 继承 --max-old-space-size=256)。本模块把解码换成滑动窗口:
//
//   - 每首歌一个长命 ffmpeg(`-i <源> -ar 48k -ac 2 -f f32le pipe:1`),
//     后台持续排入窗口;消费(`GroupPump.pushLoop`)按 25ms 切片取数;
//   - 背压:未消费前沿超 30 秒(与 MA 一致)即 `stdout.pause()`,ffmpeg 被管道憋住;
//     低于 20 秒恢复。窗口 ＋ 管道总量有界;
//   - 偏移全是**曲首起算的绝对交错样本**(与整包 `Float32Array` 下标同口径),
//     `pushLoop` 的 `lo = i*frameSamples` 无需换算;
//   - seek 回放点在窗口内只动下标(调用方行为);窗口外由 `seekTo()` 按 `-ss` 重起
//     ffmpeg,绝对偏移保持连续,调用方同样只改 `positionMs`。
//
// 内存上限:窗口 30 秒 ≈ 11.5MB ＋ ffmpeg 常驻 ~15MB,和曲长无关。
// 历史保留:已消费数据保留最近 5 秒(`HISTORY_KEEP_SEC`,后续按房间 DSP 预热用)。
//
// 与整包路径的关系:`GroupAudio` 加可选 `stream` 字段(见 streamEngine),
// 有则走窗口、无则走老路径;announce 的 TTS 短包保持整包解码,不用本模块.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SAMPLE_RATE, CHANNELS, ffmpegBin } from "./encoding.js";
export const BYTES_PER_SAMPLE = 4;
/** 背压高水位(秒):未消费前沿超此即暂停 stdout,ffmpeg 被管道憋住。
 *  2026-09-19 由 60 收到 30 —— 与 MA 的缓冲上限(`sleep_to_limit_buffer(30秒)`)对齐:
 *  窗口收窄后内存上限从 ~23MB 降到 ~11.5MB,代价是 seek 回跳更可能落出窗口、
 *  要按 `-ss` 重起 ffmpeg(越界频率在 240 soak 里继续观察)。 */
export const WINDOW_HIGH_SEC = 30;
/** 背压低水位(秒):低于即恢复读取。 */
export const WINDOW_LOW_SEC = 20;
/** 已消费历史保留(秒):后续 DSP 预热的地基,现在只记不播。 */
export const HISTORY_KEEP_SEC = 5;
/** 起播预缓冲(秒):`ready()` 等到这么多或 EOF。 */
export const PREBUFFER_SEC = 2;
/** `slice()` 等数默认超时(ms):超时调用方按 stall 处理(现有 STALL_GRACE 语义)。 */
export const SLICE_WAIT_MS = 15_000;

export interface WindowSource {
  input: string;
  headers?: Record<string, string>;
  /** 输入格式(缺省按扩展名/协议自动识别);测试可用 `lavfi` 直接合成音频,免固件。 */
  inputFormat?: string;
}

export class WindowEvictedError extends Error {
  constructor() { super("回放点已滑出窗口(需 seekTo 重定位)"); }
}
export class WindowClosedError extends Error {
  constructor() { super("窗口已关闭"); }
}
export class WindowFailedError extends Error {
  constructor(msg: string) { super(msg); }
}

function samplesOfSec(sec: number): number {
  return Math.floor(sec * SAMPLE_RATE * CHANNELS);
}

function ffmpegArgs(source: WindowSource, startSec: number): string[] {
  const args = ["-hide_banner", "-loglevel", "error"];
  if (startSec > 0) args.push("-ss", String(startSec));
  if (source.headers && Object.keys(source.headers).length > 0) {
    const lines = Object.entries(source.headers).map(([k, v]) => `${k}: ${v}`);
    args.push("-headers", lines.join("\r\n"));
  }
  if (source.inputFormat) args.push("-f", source.inputFormat);
  args.push(
    "-i", source.input,
    "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS),
    "-f", "f32le", "pipe:1",
  );
  return args;
}

/**
 * 滑动窗口 PCM 源。偏移口径:曲首起算的绝对交错样本数
 * (Float32Array 下标,F32/48k 立体声 interleaved)。
 *
 * 单消费者假设(pushLoop)＋seek/close 可在任意时刻调;
 * `slice()` 是唯一的等待点。
 */
export class PcmWindow {
  private readonly source: WindowSource;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stderrTail = Buffer.alloc(0);
  /** 上次 stdout 读剩的不足一个 float 的尾巴(0-3B),下次拼接,防跨包拆分错位。 */
  private carry: Uint8Array = new Uint8Array(0);
  /** chunks[0][0] 对应的绝对交错样本下标。 */
  private baseSample = 0;
  private chunks: Uint8Array[] = [];
  private chunksBytes = 0;
  /** 已解出总量(绝对下标,== baseSample ＋ 块内样本数)。 */
  private decodedSamples = 0;
  /** 消费高水位(绝对下标):`slice()` 推进,用于淘汰与背压。 */
  private consumedSamples = 0;
  /** stdout 正常结束时的绝对 EOF 下标;异常退出则 failed。 */
  private eofSample: number | null = null;
  private failed: string | null = null;
  private closed = false;
  private paused = false;
  private waiters: Array<() => void> = [];

  constructor(source: WindowSource, startMs = 0) {
    this.source = source;
    const startSample = Math.max(0, Math.floor((startMs / 1000) * SAMPLE_RATE * CHANNELS));
    this.baseSample = startSample;
    this.decodedSamples = startSample;
    this.consumedSamples = startSample;
    this.spawn(startMs / 1000);
  }

  get decoded(): number { return this.decodedSamples; }
  get eof(): boolean { return this.eofSample !== null; }
  get bufferedBytes(): number { return this.chunksBytes; }
  /** 子进程 pid(测试断言无残留/运维日志用)。 */
  get pid(): number | undefined { return this.proc?.pid; }
  /** 失败原因(测试诊断/运维日志用),无失败为 null。 */
  get failedReason(): string | null { return this.failed; }

  /** 等到预缓冲(2 秒)或 EOF/失败。首帧 latency 的唯一阻塞点,替代整曲解码等待。 */
  async ready(timeoutMs = SLICE_WAIT_MS): Promise<void> {
    const target = this.baseSample + samplesOfSec(PREBUFFER_SEC);
    await this.waitFor(() => this.decodedSamples >= target || this.eofSample !== null, timeoutMs);
    if (this.closed) throw new WindowClosedError();
    if (this.failed) throw new WindowFailedError(this.failed);
  }

  /**
   * 取 [lo, hi) 绝对下标。语义:
   * - 数据就绪 → 返回拷贝(25ms 级);
   * - 未解到 → 等(超时抛错,调用方按 stall 处理);
   * - 范围整体超出 EOF → 返回已有的(可能空,调用方视短片为播完);
   * - lo 已被淘汰 → 抛 WindowEvictedError(调用方 seekTo 重定位);
   * - 关闭/失败 → 抛对应错误。
   */
  async slice(lo: number, hi: number, timeoutMs = SLICE_WAIT_MS): Promise<Float32Array> {
    if (hi <= lo) return new Float32Array(0);
    await this.waitFor(
      () => this.decodedSamples >= hi || this.eofSample !== null,
      timeoutMs,
    );
    if (this.closed) throw new WindowClosedError();
    if (this.failed) throw new WindowFailedError(this.failed);
    if (lo < this.baseSample) throw new WindowEvictedError();
    const end = this.eofSample !== null ? Math.min(hi, this.eofSample) : hi;
    if (end <= lo) return new Float32Array(0);
    const out = this.copyRange(lo, end);
    if (end > this.consumedSamples) this.consumedSamples = end;
    this.maybeResume();
    return out;
  }

  /**
   * 跳转到 ms。窗口内(已解且未淘汰)只动消费水位、返回 false
   * (调用方只改 positionMs 即可);窗口外杀掉 ffmpeg 按 `-ss` 重起,返回 true。
   * 绝对偏移保持"曲首起算"连续,调用方下标算法无需改动。
   */
  async seekTo(ms: number): Promise<boolean> {
    if (this.closed) throw new WindowClosedError();
    const target = Math.max(0, Math.floor((ms / 1000) * SAMPLE_RATE * CHANNELS));
    if (!this.failed && target >= this.baseSample && target <= this.decodedSamples) {
      this.consumedSamples = target;
      this.maybeResume();
      return false;
    }
    this.killProc();
    this.chunks = [];
    this.chunksBytes = 0;
    this.carry = new Uint8Array(0);
    this.baseSample = target;
    this.decodedSamples = target;
    this.consumedSamples = target;
    this.eofSample = null;
    this.failed = null;
    this.paused = false;
    this.spawn(ms / 1000);
    return true;
  }

  /** 关闭:杀 ffmpeg、唤醒等数者(抛 WindowClosedError)、释放缓冲。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.killProc();
    this.chunks = [];
    this.chunksBytes = 0;
    this.carry = new Uint8Array(0);
    this.wakeAll();
  }

  // ==================== 内部 ====================

  private spawn(startSec: number): void {
    const args = ffmpegArgs(this.source, Math.max(0, startSec));
    let proc: ChildProcessWithoutNullStreams;
    try {
      // stdin 用 pipe 占位(与 encoding.pipeThroughFfmpeg 同口径,实际不写)。
      proc = spawn(ffmpegBin(), args, { stdio: ["pipe", "pipe", "pipe"] });
      proc.stdin.end();
    } catch (e: any) {
      this.failed = `ffmpeg 启动失败: ${e?.message || e}`;
      this.wakeAll();
      return;
    }
    this.proc = proc;
    this.paused = false;
    proc.stderr.on("data", (d: Buffer) => {
      this.stderrTail = Buffer.concat([this.stderrTail, d]).subarray(-300);
    });
    proc.stdout.on("data", (d: Buffer) => this.onData(d));
    proc.on("error", (e: Error) => {
      if (this.proc !== proc) return;
      this.failed = `ffmpeg 进程错误: ${e?.message || e}`;
      this.wakeAll();
    });
    proc.on("close", (code) => {
      if (this.proc !== proc) return; // 已被 seekTo/close 替换,忽略旧进程退出
      this.proc = null;
      if (code === 0) {
        this.eofSample = this.decodedSamples;
      } else if (!this.closed) {
        const tail = this.stderrTail.toString().slice(0, 200);
        this.failed = `ffmpeg 异常退出(${code}): ${tail}`;
      }
      this.wakeAll();
    });
  }

  private onData(d: Buffer): void {
    if (this.closed) return;
    // 拼接上次不足一个 float 的尾巴,保证块内 float 不错位。
    const buf: Uint8Array = this.carry.length > 0 ? Buffer.concat([this.carry, d]) : d;
    const whole = buf.length - (buf.length % BYTES_PER_SAMPLE);
    this.carry = whole < buf.length ? buf.subarray(whole) : new Uint8Array(0);
    if (whole > 0) {
      const piece = buf.subarray(0, whole);
      this.chunks.push(piece);
      this.chunksBytes += piece.length;
      this.decodedSamples += Math.floor(piece.length / BYTES_PER_SAMPLE);
    }
    this.evict();
    // 真背压:未消费前沿超高水位即暂停 stdout,ffmpeg 被管道憋住;
    // 只在数据到达时判定,避免定时轮询。
    if (!this.paused && this.bufferedAheadBytes() > samplesOfSec(WINDOW_HIGH_SEC) * BYTES_PER_SAMPLE) {
      this.paused = true;
      try { this.proc?.stdout.pause(); } catch { /* ignore */ }
    }
    this.wakeAll();
  }

  /** 未被消费的前沿字节数(背压/淘汰依据)。 */
  private bufferedAheadBytes(): number {
    const consumedBytes = Math.max(0, (this.consumedSamples - this.baseSample) * BYTES_PER_SAMPLE);
    return Math.max(0, this.chunksBytes - consumedBytes);
  }

  private maybeResume(): void {
    if (this.paused && this.bufferedAheadBytes() < samplesOfSec(WINDOW_LOW_SEC) * BYTES_PER_SAMPLE) {
      this.paused = false;
      try { this.proc?.stdout.resume(); } catch { /* ignore */ }
    }
  }

  /** 淘汰:只保留 [consumed - 5s历史, …),从头删。 */
  private evict(): void {
    const keepFrom = Math.max(
      this.baseSample,
      this.consumedSamples - samplesOfSec(HISTORY_KEEP_SEC),
    );
    while (this.chunks.length > 0) {
      const first = this.chunks[0];
      const firstSamples = Math.floor(first.length / BYTES_PER_SAMPLE);
      if (this.baseSample + firstSamples > keepFrom) break;
      this.chunks.shift();
      this.chunksBytes -= first.length;
      this.baseSample += firstSamples;
    }
  }

  private copyRange(lo: number, hi: number): Float32Array {
    const out = new Float32Array(hi - lo);
    let at = 0;
    let cursor = this.baseSample;
    for (const c of this.chunks) {
      const cSamples = Math.floor(c.length / BYTES_PER_SAMPLE);
      const cEnd = cursor + cSamples;
      if (cEnd <= lo || cursor >= hi) { cursor = cEnd; continue; }
      const from = Math.max(lo, cursor) - cursor;
      const to = Math.min(hi, cEnd) - cursor;
      const view = new DataView(c.buffer, c.byteOffset, c.length);
      for (let i = from; i < to; i++) out[at++] = view.getFloat32(i * BYTES_PER_SAMPLE, true);
      cursor = cEnd;
      if (at >= out.length) break;
    }
    return out.subarray(0, at);
  }

  private waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
    if (cond()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`PcmWindow 等数超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const wake = () => {
        if (cond()) {
          clearTimeout(timer);
          resolve();
        } else if (this.closed || this.failed || this.eofSample !== null) {
          // 终态:唤醒调用方自行区分(抛对应错误或返回短片)
          clearTimeout(timer);
          resolve();
        } else {
          // 条件未满足:挂回等下一次数据,超时计时保持
          this.waiters.push(wake);
        }
      };
      this.waiters.push(wake);
    });
  }

  private wakeAll(): void {
    const ws = this.waiters.splice(0);
    for (const w of ws) {
      try { w(); } catch { /* ignore */ }
    }
  }

  private killProc(): void {
    const p = this.proc;
    this.proc = null;
    // 唤醒等数者重判:seekTo 重定位后旧下标必然 Evicted,主循环 continue 重取;
    // close() 随后也会 wakeAll,重复唤醒无害。
    this.wakeAll();
    if (!p) return;
    try {
      p.stdout.removeAllListeners();
      p.stderr.removeAllListeners();
      p.kill("SIGTERM");
      setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* 已退 */ } }, 2000).unref?.();
    } catch { /* ignore */ }
  }
}
