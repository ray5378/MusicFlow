// ==================== AP2 首包延迟分解埋点（诊断用；门控缺省零开销）====================
//
// 目的：定位「SETUP(stream) 响应到达 → 首个 RTP 包发出」这段里的 22ms 级抖动究竟落在哪一步。
//
// 门控：MUSICFLOW_AP2_TRACE=1 才工作。未设时本模块除两个常量外什么都不做——
//   · 不建任何 observer / 定时器 / 句柄；
//   · 不写文件（TRACE_FILE 只在门控开时解析一次）；
//   · 不分配缓冲（打点分支全部由 `if (this.trace)` 短路，trace 恒为 null）；
//   · 不打时间（nowUs() 只在门控开的分支里调用）。
//   门控在**模块加载时**读一次并存为常量，运行期不再读 process.env。
//
// 时间基准：nowUs() = process.hrtime.bigint()/1000（单调 µs，不受 NTP 校时影响）；
//   另取一次 Date.now() 作墙钟锚点 tWallMs，便于与 pcap / 床侧日志对齐。
//
// 输出：一行 JSON 走 [airplay-ap2] 日志；可选 MUSICFLOW_AP2_TRACE_FILE 追加一行 jsonl。
import { appendFileSync } from "node:fs";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("airplay-ap2");

/** 门控常量：模块加载时读一次，之后只读不改（未设 ⇒ 全程零开销）。 */
export const AP2_TRACE_ON: boolean = process.env["MUSICFLOW_AP2_TRACE"] === "1";

/** 可选 jsonl 落盘路径（仅门控开时解析一次；空 = 只走日志）。 */
const TRACE_FILE: string = AP2_TRACE_ON ? (process.env["MUSICFLOW_AP2_TRACE_FILE"] ?? "") : "";

/** 循环延迟样本数达到该值即出报告（不等整场结束，避免中途被杀时拿不到数据）。 */
export const AP2_TRACE_LOOP_SAMPLES = 32;

/** 循环延迟样本上限（只统计前若干次，杜绝长会话无界增长）。 */
const MAX_LOOP_SAMPLES = 4096;

/** 单调微秒时钟（仅门控开时调用，故不做零开销以外的优化）。 */
export function nowUs(): number {
  return Number(process.hrtime.bigint() / 1000n);
}

/** 取分位数（输入须已升序；空数组返回 0）。 */
export function percentileUs(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return Math.round(sorted[idx]!);
}

/** 一次会话的「SETUP 响应 → 首包」延迟分解（字段均为 µs，除 pullWaitMs/tWallMs 为 ms）。 */
export interface Ap2TraceRecord {
  ev: "trace";
  /** 设备 controllerId。 */
  dev: string;
  /** 协商后的流速率。 */
  rate: number;
  /** 墙钟锚点（Date.now()，与 pcap/床侧对齐用）。 */
  tWallMs: number;
  /** SETUP(stream) 响应到达 → 首包发出 的总跨度。 */
  totalUs: number;
  /** #1：await timing.connect()（设备侧 accept 事件/时序端口）。 */
  dTimingUs: number;
  /** #4：await import("node:dgram")（ESM 动态导入，首次会走模块解析）。 */
  dDgramImportUs: number;
  /** #7：dgram.createSocket("udp4")。 */
  dSocketUs: number;
  /** #3：open() 返回 → pumpRealtime 真正被调度（调用方 + 事件循环）。 */
  dCallerSchedUs: number;
  /** #2：pumpRealtime 入口 → 首次 pull() 返回。 */
  dFirstPullUs: number;
  /** 同一区间的墙钟（Date.now）测量，交叉验证 pull 是否真的阻塞在 I/O 上。 */
  pullWaitMs: number;
  /** 推流循环「实际唤醒 − 计划唤醒」延迟 P50/P95（#3 事件循环健康度）。 */
  loopDelayP50Us: number;
  loopDelayP95Us: number;
  /** 参与统计的循环样本数。 */
  loops: number;
}

/**
 * 单会话埋点收集器。仅在 AP2_TRACE_ON 时实例化；门控关时 ap2Stream 里的引用恒为 null，
 * 所有打点分支退化为一次 null 判断。
 */
export class Ap2OpenTrace {
  private tSetupRespUs = 0;
  private tOpenDoneUs = 0;
  private tFirstSendUs = 0;
  private dTimingUs = 0;
  private dDgramImportUs = 0;
  private dSocketUs = 0;
  private dCallerSchedUs = 0;
  private dFirstPullUs = 0;
  private pullWaitMs = 0;
  private firstPullDone = false;
  private readonly loopDelays: number[] = [];
  private emitted = false;

  constructor(private readonly dev: string) {}

  /** SETUP(stream) 响应到达时刻。 */
  markSetupResp(tUs: number): void {
    this.tSetupRespUs = tUs;
  }

  /** #1：await timing.connect() 前后。 */
  markTiming(t0Us: number, t1Us: number): void {
    this.dTimingUs = t1Us - t0Us;
  }

  /** #4/#7：UdpAudioSink.connect() 内部两步（未取到则为 0）。 */
  markDgram(dgramImportUs: number, socketUs: number): void {
    this.dDgramImportUs = dgramImportUs;
    this.dSocketUs = socketUs;
  }

  /** open() 结束时刻（返回值之前）。 */
  markOpenDone(tUs: number): void {
    this.tOpenDoneUs = tUs;
  }

  /** #3：pumpRealtime 入口时刻（与 open() 结束时刻之差 = 调用方调度）。 */
  markPumpEnter(tUs: number): void {
    this.dCallerSchedUs = this.tOpenDoneUs ? tUs - this.tOpenDoneUs : 0;
  }

  /** #2：首次 pull() 区间（单调 µs + 墙钟 ms）。只记第一次。 */
  markFirstPull(t0Us: number, t1Us: number, waitMs: number): void {
    if (this.firstPullDone) return;
    this.firstPullDone = true;
    this.dFirstPullUs = t1Us - t0Us;
    this.pullWaitMs = waitMs;
  }

  /** 首包发出时刻（只记第一次）。 */
  markFirstSend(tUs: number): void {
    if (!this.tFirstSendUs) this.tFirstSendUs = tUs;
  }

  /** 推流循环唤醒延迟样本（µs，相对计划唤醒时刻的超额量）。 */
  sampleLoopDelay(us: number): void {
    if (this.loopDelays.length < MAX_LOOP_SAMPLES) this.loopDelays.push(us);
  }

  /** 已采集的循环样本数（够数即出报告）。 */
  get loopSamples(): number {
    return this.loopDelays.length;
  }

  /** 是否已有首包时间戳（未发出的会话出报告也无意义，但仍会如实给出 totalUs=0）。 */
  get hasFirstSend(): boolean {
    return this.tFirstSendUs !== 0;
  }

  /**
   * 输出一行 JSON（每次会话只输出一次）。返回记录本身，便于单测断言；
   * 已输出过则返回 null。
   */
  emit(rate: number): Ap2TraceRecord | null {
    if (this.emitted) return null;
    this.emitted = true;
    const sorted = this.loopDelays.slice().sort((a, b) => a - b);
    const rec: Ap2TraceRecord = {
      ev: "trace",
      dev: this.dev,
      rate,
      tWallMs: Date.now(),
      totalUs: this.tFirstSendUs && this.tSetupRespUs ? this.tFirstSendUs - this.tSetupRespUs : 0,
      dTimingUs: this.dTimingUs,
      dDgramImportUs: this.dDgramImportUs,
      dSocketUs: this.dSocketUs,
      dCallerSchedUs: this.dCallerSchedUs,
      dFirstPullUs: this.dFirstPullUs,
      pullWaitMs: this.pullWaitMs,
      loopDelayP50Us: percentileUs(sorted, 50),
      loopDelayP95Us: percentileUs(sorted, 95),
      loops: sorted.length,
    };
    log.info(`[airplay-ap2] trace ${JSON.stringify(rec)}`);
    if (TRACE_FILE) {
      try {
        appendFileSync(TRACE_FILE, `${JSON.stringify(rec)}\n`);
      } catch {
        /* 落盘失败不影响主链路 */
      }
    }
    return rec;
  }
}
