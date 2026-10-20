// ==================== AirPlay 解码/缓冲层(纯,无主进程依赖) ====================
//
// 从 control.ts 抽出的「ffmpeg 解码 → 有界 PCM 环形队列」这一段:它既被主进程
// (in-proc 会话)使用,也被 airplay 子进程(sessionRuntime)使用 —— 抽成独立模块后,
// 子进程那条路径就不必再经由 control.ts 拖进 DB / DLNA / peer 等主进程态。
//
// Jitter buffer(Music Assistant 风格):ffmpeg 以最快速度解码进缓冲,由 RAOP 发送端
// 按真实时钟拉取**定速** chunk。prefill 保证发送端领先接收端几秒音频,短时解码/网络
// 抖动(云盘 WebDAV、ffmpeg 启动)就不会饿到接收端 ~250ms 的 RAOP 缓冲。
//
// 背压:缓冲超过 MAX_BUFFER_BYTES 就 pause ffmpeg stdout(它随即阻塞在管道写入),
// 掉到低水位再 resume —— 不丢数据、不跳音频,内存被钉在 ~10s 而不是整首歌。
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { PCM_BYTES_PER_CHUNK, SAMPLE_RATE } from "./raop.js";
import { createLogger } from "../../utils/logger.js";
import { resolveFfmpeg } from "../transcode.js";
import { decodeArgs, outputFilters, isLoopbackUrl } from "../audio/pipeline.js";
import { StderrTail } from "../audio/stderrTail.js";

const log = createLogger("AIRPLAY");

const PREFILL_MS = 1500; // target decoded-audio lead before the first packet
export const PREFILL_BYTES = Math.round((PREFILL_MS / 1000) * SAMPLE_RATE * 2 * 2); // 44100×16bit stereo

// Cap ≈ 10s of audio (176.4KB/s) —— 足够扛长停顿,又不至于把整首歌驻留内存。
const MAX_BUFFER_MS = 10_000;
export const MAX_BUFFER_BYTES = Math.round((MAX_BUFFER_MS / 1000) * SAMPLE_RATE * 2 * 2);
export const RESUME_BUFFER_BYTES = Math.round(MAX_BUFFER_BYTES / 2);

/** 音量百分比(0-100) → RAOP SET_PARAMETER 的 dB(0→-30dB … 100→0dB)。 */
export function degreesToDb(volume: number): number {
  const v = Math.max(0, Math.min(100, volume));
  if (v <= 0) return -144;
  return -30 + (v / 100) * 30;
}

/**
 * 回收解码器进程。**必须用 SIGKILL**:
 * ffmpeg 只在主循环里检查 `received_sigterm`,当它卡在「chunked 流断开 ⇒ HTTP 重连
 * 风暴」或阻塞在管道写时根本走不到检查点。2026-10-20 240 实测:对这类进程发 SIGTERM
 * 20 分钟后仍存活(容器内累积 12 个 18MB 僵尸,每个都占着并发与内存)。
 * 解码器是纯读、无落盘写入,强杀不会产生半成品文件。
 *
 * 放在本模块(in-proc 与 airplay 子进程共用)而不是 control.ts:子进程不能经由
 * control.ts(会拖进 DB/DLNA/peer 等主进程态)。
 */
export function killDecoder(ff: { kill?: (sig?: NodeJS.Signals) => boolean } | null | undefined): void {
  try { ff?.kill?.("SIGKILL"); } catch { /* 可能已退出 */ }
}

// ffmpeg 二进制定位统一走 transcode.resolveFfmpeg()(D35):
// FFMPEG_PATH → ffmpeg-static 内置 → PATH。此前此处是「内置优先」的重复实现,
// 导致运维注入 FFMPEG_PATH 想换掉 glibc 静态构建(Alpine/musl 下 NSS/DNS 不可用)
// 时,唯独 AirPlay 这条链路换不掉。

export interface AirplayDecodeOpts {
  /**
   * 分析行 id(= songs.id)。**仅为兼容调用方而保留**(airplay/control.ts 与
   * sessionRuntime.ts 仍在传):解码侧自 2026-10-20 起不再做响度归一,本字段在
   * decoder.ts 内已不参与任何决策(响度归一由出流侧公共链路承担)。
   */
  rowId?: string;
  /** 强制输入格式(测试用 lavfi);生产靠扩展名/协议自动识别。 */
  inputFormat?: string;
}

/**
 * 组装 AirPlay 解码 af —— **只有输出段**(P1-3,2026-10-20 修订,导出供单测):
 *
 * 解码侧**不再**做响度归一:此前这里又调了一遍 resolveLoudnessAf 并挂限制器,而响度归一
 * 已由**出流侧公共链路**(routes/rest/index.ts::resolveRequestAf)承担 —— 同一段音频被归
 * 一**两遍**,且出流侧 DSP 落在归一之后、解码侧归一又落在 DSP 之后,与 pipeline.ts 注释里
 * 「响度 → DSP → 限幅」的顺序契约**相反**。听感上的表现是动态被二次压缩(静默故障)。
 *
 * 保留的部分:`outputFilters()` 生成的输出段 —— 44100Hz / 16bit / stereo 是 **RAOP 协议
 * 硬性要求**(恒定 pin,非过渡;与 sendspin 的 forceRate 不同),删响度不能连输出段一起删。
 * 链中已无 loudnorm,故重采样走 soxr(见 outputFilters)。
 */
export function buildAirplayAf(): string[] {
  // 源位深按 F32 解码口径(恒 dither 到 16bit);采样率恒 pin 44100,声道恒 stereo。
  return outputFilters({
    sourceRate: null,
    sourceBits: 32,
    targetRate: SAMPLE_RATE,
    targetBits: 16,
    hasLoudnorm: false,
    forceRate: SAMPLE_RATE,
    forceChannels: "stereo",
  });
}

/** Spawn ffmpeg decoding `input` to raw stereo s16le 44100 PCM on stdout.
 *
 * P1-3(2026-10-20 修订):参数经统一管道装配(**仅**协议输出段 —— 响度归一由出流侧
 * 公共链路承担,解码侧不再二次归一);输入必须是合规的
 * (SPEC §1.8:本地路径或回环 token URL),否则直接抛错 —— 调用方先过
 * resolvePipelineInput,禁止静默直连远端(Alpine DNS 全坏＋鉴权头泄漏)。
 * 返回的 proc 挂 `stderrText()`(stderr **尾部**,上限 64KB)。⚠️ 解码侧已无 loudnorm,
 * 故 stderr 不再产出测量报告 —— control.ts 的 P0-4 落点(handleAirplaySessionEnded)
 * 从此拿不到 AirPlay 侧的新测量值(归一改由出流侧公共链路承担,详见该函数注释)。
 */
export function spawnDecoder(
  input: string,
  seekSec?: number,
  opts: AirplayDecodeOpts = {},
): ChildProcessWithoutNullStreams {
  if (/^https?:\/\//i.test(input) && !isLoopbackUrl(input)) {
    throw new Error("AirPlay 解码输入必须合规(SPEC §1.8):本地文件路径或回环 token URL,调用方先过 resolvePipelineInput");
  }
  const af = buildAirplayAf();
  const args = decodeArgs({
    input,
    inputFormat: opts.inputFormat,
    timeOffsetSec: seekSec,
    ...(af.length > 0 ? { af } : {}),
    outputFormat: "s16le",
    // ⚠️ **禁用 HTTP 重连**(与其它链路相反,仅 AirPlay):输入恒为本机回环出流地址
    // (`/rest/airplay/stream/:token`),断流必须当场失败。
    // 若保留 `-reconnect_streamed 1`:该响应是**无 Content-Length 的 chunked 流**,
    // ffmpeg 拿不到可续接的位置,重连请求恒为 `Range: bytes=0-` ⇒ **从 0 重读**,
    // 听感就是「一首歌播到一半又从头开始」(2026-10-20 240 实测:20 秒内 19730 次重连、
    // 每次都 bytes=0-);重连风暴期间 SIGTERM 也不生效,每首歌还会遗留一个僵尸解码器。
    reconnect: false,
    // 注:声道 pin 在 af 里的 aformat(见 buildAirplayAf),此处不再重复 -ac。
  });
  const ff = spawn(resolveFfmpeg(), args);
  let errBuf = "";
  // P0-4:loudnorm JSON 打在 stderr **末尾** → 保留尾部(上限 64KB)。旧写法
  // "length < 64KB 才追加"会冻结在流开头,实时播放 >约 5.7 分钟的曲目永远测不到
  // (见 audio/stderrTail.ts;MA `helpers/audio.py:881` parse_loudnorm 同样是 rfind 末尾)。
  const errFull = new StderrTail(64 * 1024);
  ff.stderr.on("data", (d: Buffer) => {
    const s = d.toString();
    errBuf += s;
    if (errBuf.length > 4096) errBuf = errBuf.slice(-4096);
    errFull.push(s);
  });
  (ff as any).stderrText = () => errFull.text();
  ff.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      log.info(`ffmpeg exit code=${code} signal=${signal} stderr=${errBuf.slice(0, 800)}`);
    }
  });
  return ff;
}

/** Build a buffered PCM producer around an ffmpeg decoder.
 *
 *  The producer is *not* paced: it decodes as fast as ffmpeg can and returns a
 *  1408-byte chunk as soon as one is available (resolving on the next stdout
 *  data event, not an 8ms poll). Real-time pacing happens in RaopPlayer.stream()
 *  against the wall clock; the `PREFILL_MS` lead is what absorbs jitter.
 *
 *  Buffering uses an efficient chunk queue: stdout is sliced into fixed
 *  1408-byte chunks right away (O(1) subarray + one small copy each) and pulled
 *  from the front. A single growing `Buffer.concat` accumulator would re-copy
 *  the entire buffered PCM on *every* data event — once decode blasts ahead of
 *  realtime (a fast cloud source decodes a whole track in seconds) that turns
 *  into dozens of MB of copies per second and multi-hundred-ms GC pauses that
 *  stall the sender and make the receiver stutter. */
export function makeProducer(ff: ChildProcessWithoutNullStreams): () => Promise<Buffer | null> {
  const ready: Buffer[] = [];
  let carry = Buffer.alloc(0); // <1408B remainder awaiting the next data event
  let readIdx = 0;
  let ended = false;
  let done = false;
  let prefilled = false;
  let wake: (() => void) | null = null;
  let totalBytes = 0;

  const bufferedBytes = (): number =>
    (ready.length - readIdx) * PCM_BYTES_PER_CHUNK + carry.length;

  ff.stdout.on("data", (d0: Buffer) => {
    totalBytes += d0.length;
    let d = d0;
    if (carry.length) {
      const need = PCM_BYTES_PER_CHUNK - carry.length;
      if (d.length >= need) {
        ready.push(Buffer.from(Buffer.concat([carry, d.subarray(0, need)])));
        d = d.subarray(need);
        carry = Buffer.alloc(0);
      } else {
        carry = Buffer.concat([carry, d]);
        d = Buffer.alloc(0);
      }
    }
    while (d.length >= PCM_BYTES_PER_CHUNK) {
      ready.push(Buffer.from(d.subarray(0, PCM_BYTES_PER_CHUNK)));
      d = d.subarray(PCM_BYTES_PER_CHUNK);
    }
    if ((d as Buffer).length) carry = Buffer.from(d as Buffer);
    if (wake) { const w = wake; wake = null; w(); }
    // Backpressure: stop pulling from ffmpeg before the buffered PCM grows past
    // MAX_BUFFER_BYTES. pause() stops our 'data' events, the pipe fills up and
    // ffmpeg blocks on its write — zero data lost, no audio skipped, and memory
    // stays bounded to ~10s instead of an entire track.
    if (!ended && bufferedBytes() >= MAX_BUFFER_BYTES) ff.stdout.pause();
  });
  ff.stdout.on("end", () => { ended = true; log.info(`producer stdout end: totalBytes=${totalBytes} (${(totalBytes / (SAMPLE_RATE * 4)).toFixed(1)}s audio)`); if (wake) { const w = wake; wake = null; w(); } });
  ff.on("exit", (code, signal) => { ended = true; log.info(`producer ffmpeg exit code=${code} signal=${signal} totalBytes=${totalBytes}`); if (wake) { const w = wake; wake = null; w(); } });

  const waitData = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      // Only resolve on the next stdout chunk (or stream end). Early-resolving
      // on buffer fullness here would busy-spin the prefill loop (every call
      // returns immediately once ≥1 chunk is buffered, before ffmpeg's data
      // events ever get a chance to run → 100% CPU stall).
      if (ended) return resolve(true);
      const t = setTimeout(() => { wake = null; resolve(false); }, timeoutMs);
      wake = () => { clearTimeout(t); resolve(true); };
    });

  const nextChunk = (): Buffer | null => {
    if (readIdx < ready.length) {
      const c = ready[readIdx];
      ready[readIdx] = (null as unknown) as Buffer;
      readIdx++;
      // Compact the consumed head periodically to avoid an ever-growing array.
      if (readIdx > 2048 && readIdx * 2 > ready.length) {
        ready.splice(0, readIdx);
        readIdx = 0;
      }
      return c;
    }
    // consume the partial tail only when the stream has ended
    if (ended && carry.length) {
      const tail = carry;
      carry = Buffer.alloc(0);
      return tail;
    }
    return null;
  };

  // Resume ffmpeg once the buffered PCM has drained below the low-water mark
  // (half the cap). Called on every pull so backpressure never dead-locks: pause
  // only kicks in while the queue is at/above the cap, and every consumed chunk
  // is an opportunity to restart the pipe.
  const maybeResume = (): void => {
    if (ff.stdout.isPaused() && bufferedBytes() <= RESUME_BUFFER_BYTES) ff.stdout.resume();
  };

  return async (): Promise<Buffer | null> => {
    if (done) return null;
    maybeResume();
    if (!prefilled) {
      // First pull: wait until enough decoded audio is buffered to ride out
      // short stalls (decode start, WebDAV hiccup) without an audible gap.
      while (!ended && bufferedBytes() < PREFILL_BYTES) {
        const ok = await waitData(30000);
        if (!ok) { done = true; return null; }
      }
      prefilled = true;
    }
    const c = nextChunk();
    if (c) return c;
    if (!ended) {
      if (!(await waitData(30000))) { done = true; return null; }
      maybeResume();
      const c2 = nextChunk();
      if (c2) return c2;
    }
    done = true;
    return null;
  };
}
