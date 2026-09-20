// ==================== flow mode：队列连续曲目拼成一条不间断流（P3-1/P3-4/P3-6） ====================
//
// 第 ④ 段 Smart Fades L0 的**进程编排层**（数学在 fades.ts，plan §3.4）：
//
//   曲 i   解码 ffmpeg(源 → af[响度] → f32le) ─┐
//                                              ├─→ Node 侧逐片加权混合 ─→ 编码 ffmpeg → HTTP
//   曲 i+1 解码 ffmpeg(源 → af[响度] → f32le) ─┘
//
// 为什么必须两条解码 + 一条编码（而不是一条 ffmpeg 走 -af）：
//   - 两首歌要**同时存在于内存里**才能重叠混合，ffmpeg 的 `acrossfade` 要求两个输入
//     预先对齐且长度已知，流式做不到（plan §3.4-2）；
//   - 混合只能在 F32 域做，所以中间必须经过 Node。
// 采样率/声道在**解码段**统一（`-ar/-ac` 锚定值）：两路 PCM 逐帧相加的前提是同格式。
//
// P3-4（过渡期增益不跳变，照 MA `streams/audio.py:1683`/`:1749` 的 `normalization_override`）：
// 每首歌的 af 链（静态增益或实时 loudnorm）**由调用方一次算定**（`FlowItem.af`），
// 会话内部只读不重算 —— 过渡途中若重新解析（capacity reselection / 换源行），
// 新增益会与已经混过的前一段不一致，听感上就是过渡瞬间的音量跳变，
// 且只在换歌时出现、极难复现。
//
// P3-6：会话按「每路存活解码器占一个 flow 槽」计费（稳态 1、过渡期 2），
// 槽位在解码器启动前申请 —— 交叉淡入的额外一路不会挤占普通管道的槽。
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createLogger } from "../../utils/logger.js";
import { acquireTranscodeSlot, resolveFfmpeg } from "../transcode.js";
import { codecArgs, decodeArgs, limiterFilter, outputFilters, type ChannelCodec } from "./pipeline.js";
import {
  F32_BYTES_PER_SAMPLE,
  crossfadeSamples,
  frameBytesOf,
  mixCrossfade,
  normalizeFadeConfig,
  trailingSilenceFrames,
  type FadeConfig,
} from "./fades.js";

const log = createLogger("FLOW");

/** flow 会话锚定的输出采样率（plan §3.4：flow 模式按锚定采样率统一；逐曲跟随则无法相加）。 */
export const FLOW_DEFAULT_SAMPLE_RATE = 48000;
/** flow 会话锚定的输出声道数。 */
export const FLOW_DEFAULT_CHANNELS = 2;
/** 预取提前量（秒）：距本曲结束还有「过渡时长 + 此值」时拉起下一路解码，避免接缝处停顿。 */
export const FLOW_PREFETCH_MARGIN_SEC = 2;
/** 缺省输出编码（与 DLNA/HTTP 通道的通用兜底一致）。 */
export const FLOW_DEFAULT_CODEC: ChannelCodec = { codec: "mp3", bitrateKbps: 320, container: "mp3", mime: "audio/mpeg" };

export interface FlowItem {
  /** 稳定 key（`songs.id` 或 `remote:...`）：回写测量用。 */
  key: string;
  /** **已合规**输入（本地路径或回环 token URL，SPEC §1.8）。 */
  input: string;
  headers?: Record<string, string>;
  /** 该曲的响度 af 链（**已算定**，P3-4）。空数组 = 不做响度处理。 */
  af: string[];
  title?: string;
  artist?: string;
  /** 曲长（秒）：仅用于提前预取下一路解码；未知时退化为「过渡那一刻才拉」。 */
  durationSec?: number;
}

export interface FlowStats {
  /** 已发出的样本帧数（排障/测试判断"是否真在出流"）。 */
  emittedFrames: number;
  /** 成功做过交叉淡入的次数。 */
  crossfades: number;
  /** 解码失败/空流被跳过的曲数。 */
  skipped: number;
  /** 启动过的解码进程总数（>曲数即说明预取真的两路并存了）。 */
  decoders: number;
}

export interface FlowOptions {
  /** 输出采样率（会话锚定，缺省 48000）。 */
  sampleRate?: number;
  /** 输出声道数（会话锚定，缺省 2）。 */
  channels?: number;
  /** 输出编码（缺省 mp3 320）。 */
  codec?: ChannelCodec;
  /** 交叉淡入配置（缺省 8s / 等功率 / -60dBFS 静音剥离）。 */
  fade?: Partial<FadeConfig> | null;
  /** 是否启用交叉淡入。false = 逐首直通（**仍走管道**，D9）—— 关闭开关的等价物。 */
  crossfade?: boolean;
  /** 每曲起播回调（队列推进 / ICY 曲目边界）。 */
  onItemStart?: (index: number, item: FlowItem) => void;
  /** 每曲结束回调，带该曲解码 stderr（P0-4 边播边测的唯一落点）。ok=false 表示该曲空流/失败。 */
  onItemEnd?: (index: number, item: FlowItem, stderr: string, ok: boolean) => void;
}

export interface FlowSession {
  /** 编码后的字节流（直接作为 HTTP body）。 */
  stream: Readable;
  /** 中止（客户端断开 / 停止投屏）：杀掉全部存活 ffmpeg 并释放槽位。幂等。 */
  abort: () => void;
  /** 自然结束或中止时 resolve。 */
  done: Promise<void>;
  /** 当前正在播的曲目下标（0 基；供 ICY / 队列推进读取）。 */
  currentIndex: () => number;
  stats: () => FlowStats;
}

/** 内部：一路解码器。 */
interface Decoder {
  proc: ChildProcessByStdio<null, Readable, Readable>;
  stderr: string;
  release: () => void;
  settled: boolean;
}

export interface FlowDecodeRequest {
  input: string;
  headers?: Record<string, string>;
  af?: string[];
  sampleRate: number;
  channels: number;
}

/** 曲目解码命令（纯函数）：按 flow 锚定值强制采样率/声道，输出 F32 交错 PCM。 */
export function flowDecodeArgs(req: FlowDecodeRequest): string[] {
  return decodeArgs({
    input: req.input,
    headers: req.headers,
    ...(req.af && req.af.length > 0 ? { af: req.af } : {}),
    forceRate: req.sampleRate,
    forceChannels: req.channels,
  });
}

export interface FlowEncodeRequest {
  sampleRate: number;
  channels: number;
  codec: ChannelCodec;
}

/**
 * 混合后的编码命令（纯函数）：吃 stdin 的 f32le 交错 PCM，先过**限制器**再
 * dither/降位深，最后按通道编码到 stdout。
 * 顺序不能反：限制器必须在浮点域工作（先降到 s16 再限幅会把抖动噪声也算进天花板）。
 * 每曲自己的 af 链**不含**限制器（见 `pipeline.resolveLoudnessAf({ includeLimiter:false })`）——
 * 两路信号相加后仍可能超 0 dBFS，限制器必须落在混合之后（⑤ 在 ④ 之后，plan §3.1）。
 */
export function flowEncodeArgs(req: FlowEncodeRequest): string[] {
  const af = [
    limiterFilter(),
    ...outputFilters({
      sourceRate: req.sampleRate,
      sourceBits: 32,
      targetRate: req.sampleRate,
      targetBits: 16,
      hasLoudnorm: false,
    }),
  ];
  return [
    "-hide_banner", "-loglevel", "error",
    "-f", "f32le",
    "-ar", String(req.sampleRate),
    "-ac", String(req.channels),
    "-i", "pipe:0",
    "-af", af.join(","),
    ...codecArgs(req.codec.codec, req.codec.bitrateKbps),
    "-f", req.codec.container,
    "-",
  ];
}

class FlowAbort extends Error {
  constructor() { super("flow session aborted"); this.name = "FlowAbort"; }
}

function iterOf(rs: Readable): AsyncIterator<Buffer> {
  return rs[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
}

/**
 * 直通泵：把 `iter` 的字节按序交给 `emit`，同时**扣住尾部 holdBytes 字节**不发
 * （它们是过渡窗口，要等下一曲的首段到齐才能混）。
 * `onProgress(emittedBytes, bufferedBytes)` 每收一块调用一次 —— 预取时机就挂在这里。
 * 返回被扣住的尾部（≤ holdBytes；EOF 时缓冲里剩多少就是多少）。
 */
async function pumpHoldBack(
  iter: AsyncIterator<Buffer>,
  holdBytes: number,
  emit: (buf: Buffer) => Promise<void>,
  onProgress?: (emittedBytes: number, bufferedBytes: number) => void | Promise<void>,
): Promise<Buffer> {
  const q: Buffer[] = [];
  let qLen = 0;
  let emitted = 0;
  for (;;) {
    const { value, done } = await iter.next();
    if (done) break;
    if (!value || value.length === 0) continue;
    q.push(value);
    qLen += value.length;
    await onProgress?.(emitted, qLen);
    while (qLen > holdBytes) {
      const head = q[0];
      const cut = qLen - holdBytes;
      if (head.length <= cut) {
        q.shift();
        qLen -= head.length;
        emitted += head.length;
        await emit(head);
      } else {
        await emit(head.subarray(0, cut));
        q[0] = head.subarray(cut);
        qLen -= cut;
        emitted += cut;
      }
    }
  }
  return Buffer.concat(q);
}

/** F32 字节 → 视图（零拷贝；调用方保证对齐且不长期持有底层 buffer）。 */
function f32View(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / F32_BYTES_PER_SAMPLE));
}

function asBuffer(a: Float32Array): Buffer {
  return Buffer.from(a.buffer, a.byteOffset, a.length * F32_BYTES_PER_SAMPLE);
}

/**
 * 启动一条 flow 会话。返回时第一路解码器**已经在跑**（槽位已到手），
 * 调用方可以立刻把 `stream` 接到 HTTP 响应上。
 *
 * 单曲/空列表走同一实现（此时等价于"一次普通管道出流"），避免出现
 * 「逐首播」与「交叉淡入」两条并行出流路径 —— 关闭开关只让 fade 窗口为 0，
 * **不是**绕过管道（D9）。
 */
export async function startFlowSession(items: FlowItem[], opts: FlowOptions = {}): Promise<FlowSession> {
  const sampleRate = Math.max(8000, Math.round(opts.sampleRate ?? FLOW_DEFAULT_SAMPLE_RATE));
  const channels = Math.max(1, Math.round(opts.channels ?? FLOW_DEFAULT_CHANNELS));
  const codec = opts.codec ?? FLOW_DEFAULT_CODEC;
  const crossfade = opts.crossfade === true;
  const fade = normalizeFadeConfig(opts.fade ?? null);
  const frameBytes = frameBytesOf(channels);
  // 过渡窗口：按时长算出**采样数**（已按帧对齐），再换成字节做切片。
  const fadeSamples = crossfade ? crossfadeSamples(fade.durationSec, sampleRate, channels) : 0;
  const fadeFrames = fadeSamples / channels;
  const fadeBytes = fadeSamples * F32_BYTES_PER_SAMPLE;

  const stats: FlowStats = { emittedFrames: 0, crossfades: 0, skipped: 0, decoders: 0 };
  const live = new Set<Decoder>();
  let aborted = false;
  let currentIndex = 0;

  // 编码进程先起：混合结果随到随写，不设中间缓冲。
  const enc = spawn(resolveFfmpeg(), flowEncodeArgs({ sampleRate, channels, codec }), { stdio: ["pipe", "pipe", "pipe"] });
  let encErr = "";
  enc.stderr.on("data", (d: Buffer) => { encErr += d.toString(); });
  enc.stderr.resume();
  // 编码器 stdin 的错误必须吃掉（P3-1）：客户端中途断开 → 我们 SIGKILL 编码器 →
  // **正在飞行中的那一次** `stdin.write()` 会异步回 EPIPE，而 `writeOut` 里的
  // `writable` 检查拦不住已经写出去的那次。Node 对没有 'error' 监听的流会抛出
  // 未捕获异常（vitest 里是 Unhandled Error，生产里就是进程级崩溃）。
  enc.stdin.on("error", () => { /* 对端已退出；后续写入被 writeOut 的 aborted/可写性短路 */ });
  const encClosed = new Promise<void>((resolve) => {
    enc.on("close", () => resolve());
    enc.on("error", () => resolve());
  });

  const killDecoder = (d: Decoder) => {
    try { d.proc.kill("SIGKILL"); } catch { /* 已退出 */ }
    if (!d.settled) { d.settled = true; d.release(); }
    live.delete(d);
  };

  const abort = () => {
    if (aborted) return;
    aborted = true;
    try { enc.kill("SIGKILL"); } catch { /* 已退出 */ }
    for (const d of [...live]) killDecoder(d);
  };

  /** 写混合结果到编码 stdin，带背压与中止联动。 */
  const writeOut = async (buf: Buffer): Promise<void> => {
    if (aborted || buf.length === 0) return;
    const stdin = enc.stdin;
    if (!stdin.writable) throw new FlowAbort();
    if (!stdin.write(buf)) {
      await Promise.race([
        new Promise<void>((r) => stdin.once("drain", () => r())),
        encClosed,
      ]);
      if (aborted || !stdin.writable) throw new FlowAbort();
    }
  };

  /** 起一路解码器（占一个 flow 槽；等槽是异步的，排队时也不能静默丢曲）。 */
  const spawnDecoder = async (item: FlowItem): Promise<Decoder> => {
    const release = await acquireTranscodeSlot("flow");
    if (aborted) { release(); throw new FlowAbort(); }
    const proc = spawn(resolveFfmpeg(), flowDecodeArgs({
      input: item.input,
      headers: item.headers,
      af: item.af,
      sampleRate,
      channels,
    }), { stdio: ["ignore", "pipe", "pipe"] });
    const dec: Decoder = { proc, stderr: "", release, settled: false };
    proc.stderr.on("data", (d: Buffer) => { dec.stderr += d.toString(); });
    proc.stderr.resume();
    // 解码器 stdout 同理：abort 杀掉子进程后，尚未消费的那一段可能回 EPIPE。
    proc.stdout.on("error", () => { /* 被 abort/自然结束，见编码器 stdin 的注释 */ });
    const settle = () => { if (!dec.settled) { dec.settled = true; release(); } };
    proc.on("close", settle);
    proc.on("error", settle);
    live.add(dec);
    stats.decoders++;
    return dec;
  };

  /** 尾段直出：最后一曲的过渡窗口里没有下一曲可混，原样播出（不做静音剥离 ——
   *  最后一曲没人接，剥掉尾巴上的静音会变成"提前结束"）。 */
  const emitTail = async (buf: Buffer): Promise<void> => {
    if (buf.length === 0) return;
    stats.emittedFrames += buf.length / frameBytes;
    await writeOut(buf);
  };

  const run = async (): Promise<void> => {
    if (items.length === 0) {
      try { enc.stdin.end(); } catch { /* 已关 */ }
      return;
    }
    /** 上一曲扣住的尾段（过渡窗口，未播出）。 */
    let carry: Buffer = Buffer.alloc(0);
    /** 提前拉起的下一路（两路并存的第二路）。 */
    let prefetched: { index: number; dec: Decoder; iter: AsyncIterator<Buffer> } | null = null;

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      currentIndex = index;
      opts.onItemStart?.(index, item);

      // 上一环没预取到（无时长信息 / 上一路提前 EOF）→ 过渡那一刻才拉第二路。
      if (index > 0 && !prefetched) {
        const d = await spawnDecoder(item);
        prefetched = { index, dec: d, iter: iterOf(d.proc.stdout) };
      }
      const fromPrefetch = prefetched !== null && prefetched.index === index;
      const dec = fromPrefetch ? prefetched!.dec : await spawnDecoder(item);
      const iter = fromPrefetch ? prefetched!.iter : iterOf(dec.proc.stdout);
      if (fromPrefetch) prefetched = null;

      const before = stats.emittedFrames;
      const emit = async (buf: Buffer) => {
        stats.emittedFrames += buf.length / frameBytes;
        await writeOut(buf);
      };

      // ---------- ① 上曲尾段 ∩ 本曲首段 的交叉淡入（P3-2/P3-3）----------
      let headConsumed = 0;
      if (carry.length > 0 && fadeBytes > 0) {
        const carryFrames = Math.floor(carry.length / frameBytes);
        const silentFrames = trailingSilenceFrames(f32View(carry), channels, fade.silenceThresholdDb);
        const availFrames = Math.max(0, carryFrames - silentFrames);
        // 1) 过渡窗口之前的那段照常播出（它是上一曲正常的后半段）
        const preFrames = Math.max(0, availFrames - fadeFrames);
        if (preFrames > 0) await emit(carry.subarray(0, preFrames * frameBytes));
        // 2) 读本曲首段（最多一个过渡窗口）用于混合
        const wantBytes = Math.min(fadeFrames, availFrames) * frameBytes;
        let head = Buffer.alloc(0);
        while (head.length < wantBytes) {
          const { value, done } = await iter.next();
          if (done) break;
          if (value && value.length > 0) head = Buffer.concat([head, value]);
        }
        const mixFrames = Math.floor(Math.min(wantBytes, Math.max(0, head.length - (head.length % frameBytes))) / frameBytes);
        // 2.5) 混合窗口之前、又还没播出的那段：照常播出。
        //      `carry` 恒 ≤ 一个过渡窗口（pumpHoldBack 的 holdBytes = fadeBytes）⇒ preFrames 恒为 0；
        //      但下一曲首段可能**短于**过渡窗口（下一曲很短 / 解码失败 / 空流），此时
        //      mixFrames < availFrames，中间这段既没 emit 也没参与混合，会被循环末尾的
        //      `carry = Buffer.alloc(0)` 直接丢掉 —— 最长丢一个窗口且**完全不报错**（2026-09-20 审出）。
        //      自 preFrames 起算，保证与 ① 播出的区间不重叠。
        const unMergedFrames = Math.max(0, availFrames - mixFrames);
        if (unMergedFrames > preFrames) {
          await emit(carry.subarray(preFrames * frameBytes, unMergedFrames * frameBytes));
        }
        if (mixFrames > 0) {
          const outStart = (availFrames - mixFrames) * frameBytes;
          const outSlice = carry.subarray(outStart, outStart + mixFrames * frameBytes);
          const inSlice = head.subarray(0, mixFrames * frameBytes);
          const mixed = mixCrossfade(f32View(outSlice), f32View(inSlice), { channels, curve: fade.curve });
          stats.emittedFrames += mixFrames;
          stats.crossfades++;
          await writeOut(asBuffer(mixed));
        }
        // 3) 首段里超出混合窗口的部分照常播出
        headConsumed = mixFrames * frameBytes;
        const restHead = head.subarray(headConsumed);
        if (restHead.length > 0) { await emit(restHead); headConsumed += restHead.length; }
        // 4) 曲尾静音到此**丢弃**：剥离的意义就是不让它进过渡窗口，也不单独播出
        //    （否则"淡出完还在放静音"）。剩下的本曲由下面直通泵处理。
      } else if (carry.length > 0) {
        await emit(carry);
      }
      carry = Buffer.alloc(0);

      // ---------- ② 本曲剩余：直通 + 抠住尾部（+ 提前预取下一路）----------
      const nextIndex = index + 1;
      let prefetchStarted = false;
      const startNext = async (): Promise<void> => {
        if (prefetchStarted || nextIndex >= items.length) return;
        prefetchStarted = true;
        const d = await spawnDecoder(items[nextIndex]);
        prefetched = { index: nextIndex, dec: d, iter: iterOf(d.proc.stdout) };
      };
      // 预取点：距本曲结束还有「过渡窗口 + margin」时。没有时长信息则为 -1（不预取，
      // 退化到下一环开头的"过渡那一刻才拉"）。
      const totalBytes = typeof item.durationSec === "number" && item.durationSec > 0
        ? item.durationSec * sampleRate * frameBytes
        : -1;
      const prefetchAtBytes = totalBytes > 0
        ? Math.max(0, totalBytes - (fadeBytes + FLOW_PREFETCH_MARGIN_SEC * sampleRate * frameBytes))
        : -1;
      const tail = await pumpHoldBack(iter, fadeBytes, emit, (emittedInPump) => {
        if (prefetchStarted || nextIndex >= items.length) return;
        if (prefetchAtBytes < 0) return; // 无时长信息：交给下一环开头
        if (headConsumed + emittedInPump >= prefetchAtBytes) return startNext();
      });

      const ok = stats.emittedFrames > before;
      if (!ok) stats.skipped++;
      opts.onItemEnd?.(index, item, dec.stderr, ok);
      carry = tail;
    }

    // 最后一曲的过渡窗口：没有下一曲可混，原样播出。
    await emitTail(carry);
    try { enc.stdin.end(); } catch { /* 已关 */ }
  };

  const runPromise = run().catch((e: any) => {
    if (!(e instanceof FlowAbort)) log.warn("flow 会话异常结束", { error: e?.message || String(e) });
    abort();
  });

  const done = Promise.all([runPromise, encClosed]).then(() => {
    for (const d of [...live]) killDecoder(d);
    live.clear();
    if (encErr) log.warn("flow 编码器 stderr", { tail: encErr.slice(-300) });
  });

  return { stream: enc.stdout, abort, done, currentIndex: () => currentIndex, stats: () => stats };
}
