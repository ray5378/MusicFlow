// ==================== AirPlay 桥接 PCM 环形缓冲(airplay 子进程侧)====================
//
// pump 送来的是 **48k / 2ch / s16** 交错的连续 PCM,每帧 25ms,并且带**时间戳**
// (`tsUs` = 该帧在 pump 时间线上应当被听到的绝对时刻)。RAOP 侧要的是
// **44.1k / 2ch / s16**、每次 352 帧(1408 字节)的顺序字节流,由 `RaopPlayer.stream`
// 按墙钟节拍来拉。
//
// 于是本模块干三件事:
//   1. 按时间戳收帧(48k,定长环形,4s 容量),记录「首帧 = 哪个绝对时刻」;
//   2. 重采样 48k → 44.1k(比例恰为 160:147,用有理数步进 + 线性插值,
//      避免浮点累积漂移;输出速率对内容时间严格 1:1);
//   3. 提供 `PcmProducer`:每次被调用时按 **now + lead** 决定「该取哪一段内容」——
//      lead = 该设备 RAOP 的播放延迟(latencyFrames)。这样"此刻送出去的音频"
//      正好是"lead 之后应当听到的音频",与 sendspin 客户端收到的同一 `tsUs`
//      在墙钟上重合 ⇒ 跨协议采样级同步。
//
// 为什么以**墙钟**而不是"顺序消费"为准:顺序消费只能保证节奏,一旦中途有抖动/丢帧
// 就会永久偏移;墙钟取内容则是**每次自校正**的(偏差超过 50ms 直接跳位重锚并计数),
// 与 MA 桥接层 `set_timing()` + 锚点校正同思路。
import type { PcmProducer } from "./raop.js";

/** 输入(pump)采样率。 */
const IN_RATE = 48000;
/** 输出(RAOP)采样率。 */
const OUT_RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
/** 单帧(所有声道)字节数。 */
const IN_FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE; // 4
/** RAOP 一次要的帧数 / 字节数(与 raop.ts CHUNK_LEN / PCM_BYTES_PER_CHUNK 一致)。 */
export const OUT_CHUNK_FRAMES = 352;
export const OUT_CHUNK_BYTES = OUT_CHUNK_FRAMES * IN_FRAME_BYTES; // 1408

/** 48k:44.1k = 160:147(精确有理数)。 */
const RATIO_NUM = 160;
const RATIO_DEN = 147;

/** 环形容量(秒)。
 *
 *  ⚠️ 2026-10-23 实测必须放大到 20s:pump 起播的 **prefill 一次性灌 10~15s 内容**
 *  (为 sendspin 设备攒深缓冲),而读端要从「已过 0.8s 位置」开始消费 —— 若环只有 4s,
 *  写端早就把读端待读区间覆盖掉了,`iFirst < floorFrame` 每批命中 ⇒ 输出全静音,
 *  但字节速率/RTP 节拍看起来完全正常(两台 AP 实测 -90dB、overrun 上亿帧就是这个)。
 *  内存代价:20s x 48000 x 4B ≈ 3.7MB/设备,7 台约 26MB,可接受。 */
const RING_SECONDS = 20;
const CAPACITY_FRAMES = RING_SECONDS * IN_RATE;

/** 偏差超过该阈值就重锚(输出帧数)。50ms 是人耳可辨的跨设备错位下限。 */
const RESYNC_FRAMES = Math.round(OUT_RATE * 0.05);

/** 目标时刻距首帧锚点还有多少毫秒(负 = 读端超前于已生产内容)。 */
function baseDiffMs(baseTsUs: number | null, targetTs: number): number {
  return baseTsUs === null ? 0 : (targetTs - baseTsUs) / 1000;
}

function nowUs(): number {
  // 与 sendspin 的 nowUs() 同源(CLOCK_MONOTONIC,跨进程可比)。
  return Number(process.hrtime.bigint() / 1000n);
}

export interface BridgeRingStats {
  /** 累计写入的输入帧数(48k)。 */
  writtenFrames: number;
  /** 累计输出帧数(44.1k)。 */
  outFrames: number;
  /** 数据不足被迫补静音的帧数(under-run)。 */
  underrunFrames: number;
  /** 墙钟重锚次数(>0 说明链路抖动/丢帧过)。 */
  resyncs: number;
  /** 因落后被覆盖而丢弃的输入帧数。 */
  overrunFrames: number;
  /** 因提前量不足而被「拉回已写内容末尾」的输出帧数。>0 即 pump 的 send_ahead
   *  低于该设备延迟 —— 声音仍会出(略早于 sendspin),但同步已被牺牲,必须修。 */
  clampedFrames: number;
}

export class BridgeRing {
  /** 诊断用标签(deviceId),多设备/多组并发时区分各环的日志。 */
  private readonly label: string;
  private buf = Buffer.alloc(CAPACITY_FRAMES * IN_FRAME_BYTES);
  /** 已写入的输入帧总数(绝对,重置后归零);下一帧的绝对索引即该值。 */
  private writtenFrames = 0;
  /** 早于该绝对索引的输入帧已不可读(被环形覆盖)。 */
  private floorFrame = 0;
  /** 首帧对应的 pump 时间线时刻;收到第一帧前为 null。 */
  private baseTsUs: number | null = null;
  /** 下一个输出帧(44.1k)索引;null = 待按墙钟对齐。 */
  private outFrame: number | null = null;

  private stats: BridgeRingStats = { writtenFrames: 0, outFrames: 0, underrunFrames: 0, resyncs: 0, overrunFrames: 0, clampedFrames: 0 };
  private lastWarnAt = 0;
  /** 诊断:上次打印 stats 快照的时刻(2s 一次,排查桥接无声用)。 */
  private lastStatAt = 0;

  constructor(label = "-") {
    this.label = label;
  }

  /** 是否已收到过数据(收到前 producer 一律输出静音)。 */
  get started(): boolean {
    return this.baseTsUs !== null;
  }

  get ringStats(): BridgeRingStats {
    return { ...this.stats, writtenFrames: this.writtenFrames, outFrames: this.stats.outFrames };
  }

  /** 时间线重置(切歌 / seek):丢弃全部残留,等下一帧重新建立锚点。 */
  reset(): void {
    this.writtenFrames = 0;
    this.floorFrame = 0;
    this.baseTsUs = null;
    this.outFrame = null;
    // 统计量随会话一起清零:否则 underrun/overrun 会跨会话累积成天文数字,
    // 让「当前这一首到底有没有欠载」这个唯一有用的判据失效。
    this.stats = { writtenFrames: 0, outFrames: 0, underrunFrames: 0, resyncs: 0, overrunFrames: 0, clampedFrames: 0 };
  }

  /** 写入一帧 pump PCM(48k / 2ch / s16 交错),`tsUs` 为该帧在 pump 时间线上的起点。 */
  push(tsUs: bigint, data: Buffer): void {
    if (data.length === 0) return;
    const frames = Math.floor(data.length / IN_FRAME_BYTES);
    if (frames <= 0) return;
    const ts = Number(tsUs);
    if (this.baseTsUs === null) {
      this.baseTsUs = ts;
      this.outFrame = null;
    } else {
      // 连续性自检:pump 正常是每 25ms 一帧;断流/被丢弃/重锚时会跳。
      // 只告警不改锚点 —— 重锚会让已写入内容的时刻全部平移,反而破坏同步。
      const expectTs = this.baseTsUs + (this.writtenFrames / IN_RATE) * 1e6;
      if (Math.abs(ts - expectTs) > 50_000) {
        const now = Date.now();
        if (now - this.lastWarnAt > 5_000) {
          this.lastWarnAt = now;
          console.warn(
            `[airplay-bridge] PCM 时间戳不连续[${this.label}]:期望 ${Math.round(expectTs)}us 实到 ${ts}us(差 ${Math.round(ts - expectTs)}us)`,
          );
        }
      }
    }

    // 覆盖式写入(环形):写满就顶掉最旧的,同时抬高可读下界。
    let src = 0;
    let remaining = frames;
    let writeAt = this.writtenFrames % CAPACITY_FRAMES;
    while (remaining > 0) {
      const slice = Math.min(remaining, CAPACITY_FRAMES - writeAt);
      data.copy(this.buf, writeAt * IN_FRAME_BYTES, src * IN_FRAME_BYTES, (src + slice) * IN_FRAME_BYTES);
      writeAt = (writeAt + slice) % CAPACITY_FRAMES;
      src += slice;
      remaining -= slice;
    }
    this.writtenFrames += frames;
    const newFloor = this.writtenFrames - CAPACITY_FRAMES;
    if (newFloor > this.floorFrame) {
      this.stats.overrunFrames += newFloor - this.floorFrame;
      this.floorFrame = newFloor;
    }
  }

  /** 读一段输入帧到连续缓冲(环形可能跨界,最多两段拷贝)。调用方须保证范围可读。 */
  private readFrames(startFrame: number, count: number, out: Buffer): void {
    const startSlot = startFrame % CAPACITY_FRAMES;
    const first = Math.min(count, CAPACITY_FRAMES - startSlot);
    this.buf.copy(out, 0, startSlot * IN_FRAME_BYTES, (startSlot + first) * IN_FRAME_BYTES);
    if (first < count) {
      this.buf.copy(out, first * IN_FRAME_BYTES, 0, (count - first) * IN_FRAME_BYTES);
    }
  }

  /**
   * 构造 RAOP 的 producer。
   *
   * @param leadUs 返回「设备播放延迟(微秒)」——即此刻送出的音频要等多久才会被听到。
   *               RAOP 侧取 `latencyFrames / 44100 * 1e6`。
   */
  producer(leadUs: () => number): PcmProducer {
    return async (): Promise<Buffer | null> => {
      const out = Buffer.alloc(OUT_CHUNK_BYTES); // 缺数据时天然是静音(全 0)
      if (this.baseTsUs === null) {
        // 还没收到任何 pump 帧(握手早于组起播):输出静音占位,时间线照常流逝。
        this.stats.outFrames += OUT_CHUNK_FRAMES;
        return out;
      }

      const leadU = leadUs();
      const nowU = nowUs();
      const targetTs = nowU + leadU;
      const clockFrame = Math.round(((targetTs - this.baseTsUs) / 1e6) * OUT_RATE);

      // 诊断快照(2s):把「写端水位 / 读端位置 / 提前量缺口 / 各类欠载」一次打全,
      // 无声问题的定位就看这一行 —— deltaMs < 0 表示读端要的内容还没生产。
      if (nowU - this.lastStatAt > 2_000_000) {
        this.lastStatAt = nowU;
        console.warn(
          `[airplay-bridge] stats[${this.label}] w=${this.writtenFrames} m=${this.outFrame} clock=${clockFrame} ` +
            `lead=${Math.round(leadU / 1000)}ms delta=${Math.round((baseDiffMs(this.baseTsUs, targetTs)))}ms ` +
            `underrun=${this.stats.underrunFrames} clamped=${this.stats.clampedFrames} resync=${this.stats.resyncs} overrun=${this.stats.overrunFrames}`,
        );
      }

      // ★ 安全网(2026-10-23 真机实锤,两台 AP 全程静音):**绝不请求尚未写入的内容**。
      //   正常情况下 pump 的 send_ahead 已被主进程抬到设备延迟之上(见
      //   group/airplayBridge.ts 的 minSendAheadUs),clockFrame 天然落在已写区间内,
      //   本 clamp 不生效、行为与历史完全一致。
      //   一旦提前量不足(例如纯 airplay 组被降级、或某设备 latency 比协商值更大),
      //   clockFrame 会永久超前于 writtenFrames ⇒ 每批都走欠载分支 ⇒ **整场静音**。
      //   此时宁可让本设备略早于 sendspin(人耳可辨错位,但**有声音**),也不要无声:
      //   拉回「已写内容的最后一批」并计入 clampedFrames,供 bridgeStats 直接暴露失配。
      const maxOut = Math.floor((this.writtenFrames * RATIO_DEN) / RATIO_NUM) - OUT_CHUNK_FRAMES - 2;
      const clamped = maxOut >= 0 && clockFrame > maxOut;
      const want = clamped ? maxOut : clockFrame;
      if (clamped) this.stats.clampedFrames += clockFrame - maxOut;

      if (this.outFrame === null || Math.abs(want - this.outFrame) > RESYNC_FRAMES) {
        // clamp 生效期间的抖动是「提前量失配」的症状,不是时钟抖动:不计 resyncs、不打日志,
        // 否则每批都会重锚一次把日志刷满、并让 resyncs 这个诊断量失去意义。
        if (this.outFrame !== null && !clamped) {
          this.stats.resyncs++;
          if (this.stats.resyncs <= 5 || this.stats.resyncs % 100 === 0) {
            console.warn(
              `[airplay-bridge] 时间线重锚[${this.label}]:${this.outFrame} → ${want}(偏差 ${want - this.outFrame} 输出帧)`,
            );
          }
        }
        this.outFrame = want;
      }

      const m0 = this.outFrame;
      // 该批输出帧需要的输入帧范围(44.1k 输出 m 对应 48k 输入 m*160/147)。
      const iFirst = Math.floor((m0 * RATIO_NUM) / RATIO_DEN);
      const iLast = Math.floor(((m0 + OUT_CHUNK_FRAMES - 1) * RATIO_NUM) / RATIO_DEN) + 1;

      // 该段内容已被环形覆盖(严重落后,通常是 prefill 灌得比环还深):
      // **必须跳到仍可读的最早位置**,而不是"对齐墙钟后继续读丢失区间" ——
      // 后者会让读指针永远追不上写的速度 ⇒ 每批都命中本分支 ⇒ 整场静音。
      if (iFirst < this.floorFrame) {
        this.stats.overrunFrames += this.floorFrame - iFirst;
        const recover = Math.floor((this.floorFrame * RATIO_DEN) / RATIO_NUM) + OUT_CHUNK_FRAMES;
        // ⚠️ 必须把**时钟基准**一起前移:否则下一批的 clockFrame 仍指向已被覆盖的旧位置,
        //    重锚又会把它拉回去 ⇒ 溢出分支每批命中 ⇒ 永久静音(死循环)。
        //    前移后 (targetTs - baseTs) 恰好映射到 recover,后续批次自然连续。
        this.baseTsUs = targetTs - (recover / OUT_RATE) * 1e6;
        this.outFrame = recover;
        this.stats.resyncs++;
        if (this.stats.resyncs <= 5 || this.stats.resyncs % 100 === 0) {
          console.warn(
            `[airplay-bridge] 环形已覆盖读区间[${this.label}]:m=${iFirst < 0 ? 0 : m0} < floor=${this.floorFrame},` +
              `跳到 ${recover}(+${recover - m0} 输出帧)后继续`,
          );
        }
        this.stats.underrunFrames += OUT_CHUNK_FRAMES;
        this.stats.outFrames += OUT_CHUNK_FRAMES;
        return out;
      }

      // 该时间段内容还没写进来(pump 还没推到):本批静音,时间线照常前进。
      if (iFirst >= this.writtenFrames) {
        this.stats.underrunFrames += OUT_CHUNK_FRAMES;
        this.stats.outFrames += OUT_CHUNK_FRAMES;
        this.outFrame = m0 + OUT_CHUNK_FRAMES;
        return out;
      }

      const availEnd = Math.min(iLast, this.writtenFrames);
      const inBuf = Buffer.alloc((availEnd - iFirst + 1) * IN_FRAME_BYTES);
      this.readFrames(iFirst, availEnd - iFirst, inBuf);

      // 线性插值:out[m] = in[i] + (in[i+1]-in[i]) * frac,i = floor(m*160/147)。
      // 尾部不足两帧的部分保持静音(under-run 计数),绝不越界读。
      let underrun = 0;
      const availFrames = availEnd - iFirst;
      for (let k = 0; k < OUT_CHUNK_FRAMES; k++) {
        const m = m0 + k;
        const num = m * RATIO_NUM;
        const i = Math.floor(num / RATIO_DEN);
        const frac = (num - i * RATIO_DEN) / RATIO_DEN;
        const rel = i - iFirst;
        if (rel < 0 || rel + 1 >= availFrames) {
          underrun++;
          continue; // 该帧保持静音
        }
        const o = k * IN_FRAME_BYTES;
        for (let ch = 0; ch < CHANNELS; ch++) {
          const a = inBuf.readInt16LE(rel * IN_FRAME_BYTES + ch * BYTES_PER_SAMPLE);
          const b = inBuf.readInt16LE((rel + 1) * IN_FRAME_BYTES + ch * BYTES_PER_SAMPLE);
          const v = Math.round(a + (b - a) * frac);
          out.writeInt16LE(v < -32768 ? -32768 : v > 32767 ? 32767 : v, o + ch * BYTES_PER_SAMPLE);
        }
      }

      this.stats.underrunFrames += underrun;
      this.stats.outFrames += OUT_CHUNK_FRAMES;
      this.outFrame = m0 + OUT_CHUNK_FRAMES;

      // 注意:floorFrame **只**由环形覆盖决定(见 push),此处不按消费推进 ——
      // 否则重锚/晚加入时会把仍可读的数据误判为「已丢弃」。
      return out;
    };
  }
}
