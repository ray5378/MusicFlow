// ==================== 每播放器独立投递环 ====================
//
// 为什么单独一个环（2026-11-23 决策，对齐 MA 的每播放器进程模型）：
// 现在所有播放器共用一条组环 + 每设备一个"水位"，实测出现
//   HiVi  wm = now+45.5s（追到前沿 ⇒ 听众侧跳进度）
//   iEAST wm = now−7.2s （喂过去的内容 ⇒ 全判 late、队列 0、静音垫片）
// 两个游标在同一条环上各自漂走之后互相污染。
//
// 新模型：组内容源只**广播**同一份帧，播放器侧各持一个本环 —— 落后只影响自己，
// 且落后的唯一处置是「丢弃过期帧、从当前时刻续上」，绝不去动别人的游标。
//
// 纪律：
//  · 只保留 [now − GRACE, now + HORIZON] 的帧；更早的丢弃并计数（droppedLate）；
//  · 投递按 ts 升序，游标单调前进；
//  · 水位落后墙钟超过 LAG_RESET 时整体前跳到「最早未过期帧」，不逐帧追；
//  · 任何输入都不会让游标倒退（对齐现有 bridgeShift 不变量）。

export interface RingFrame {
  tsUs: number;
  nFrames: number;
  data: Uint8Array;
}

export interface PlayerRingOptions {
  /** 环内保留的未来内容上限（µs）。默认 20s */
  horizonUs?: number;
  /** 允许的过期宽限（µs）。默认 300ms */
  graceUs?: number;
  /** 水位落后墙钟多久就前跳（µs）。默认 1.5s */
  lagResetUs?: number;
  /** 帧总时长上限（µs），超出先丢最旧（防内存膨胀）。默认 20s */
  maxBufferUs?: number;
}

export interface PullResult {
  frames: RingFrame[];
  /** 本次前跳的时长（µs，0 = 未前跳） */
  jumpedUs: number;
  /** 本次因过期被丢弃的帧数 */
  droppedLate: number;
}

export class PlayerRing {
  private buf: RingFrame[] = [];
  private cursorUs = 0;
  private readonly horizonUs: number;
  private readonly graceUs: number;
  private readonly lagResetUs: number;
  private readonly maxBufferUs: number;
  private totalUs = 0;
  private droppedLateTotal = 0;
  private jumpTotal = 0;

  constructor(opts: PlayerRingOptions = {}) {
    this.horizonUs = opts.horizonUs ?? 20_000_000;
    this.graceUs = opts.graceUs ?? 300_000;
    this.lagResetUs = opts.lagResetUs ?? 1_500_000;
    this.maxBufferUs = opts.maxBufferUs ?? 20_000_000;
  }

  get cursor(): number {
    return this.cursorUs;
  }

  get size(): number {
    return this.buf.length;
  }

  get bufferedUs(): number {
    return this.totalUs;
  }

  get droppedLate(): number {
    return this.droppedLateTotal;
  }

  get jumps(): number {
    return this.jumpTotal;
  }

  /** 入环：丢弃过期帧、按 ts 去重、维持容量上限。 */
  push(frame: RingFrame, nowUs: number): void {
    const lower = nowUs - this.graceUs;
    if (frame.tsUs + (frame.nFrames / 48_000) * 1e6 < lower) {
      this.droppedLateTotal += 1;
      return;
    }
    if (frame.tsUs > nowUs + this.horizonUs) {
      // 远未来内容：说明时间线错位，直接丢（留给上层重锚），不塞进环
      this.droppedLateTotal += 1;
      return;
    }
    // 按 ts 插入（广播路径下基本是顺序追加，二分兜底）
    let lo = 0;
    let hi = this.buf.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.buf[mid].tsUs < frame.tsUs) lo = mid + 1;
      else hi = mid;
    }
    if (this.buf[lo]?.tsUs === frame.tsUs) return; // 重复帧
    this.buf.splice(lo, 0, frame);
    this.totalUs += (frame.nFrames / 48_000) * 1e6;
    this.trim(nowUs);
  }

  private trim(nowUs: number): void {
    const keepFrom = nowUs - this.graceUs;
    while (this.buf.length > 0 && this.buf[0].tsUs < keepFrom) {
      const f = this.buf.shift()!;
      this.totalUs -= (f.nFrames / 48_000) * 1e6;
      this.droppedLateTotal += 1;
    }
    while (this.totalUs > this.maxBufferUs && this.buf.length > 1) {
      const f = this.buf.shift()!;
      this.totalUs -= (f.nFrames / 48_000) * 1e6;
      this.droppedLateTotal += 1;
    }
  }

  /**
   * 取出本次应投递的帧。
   * @param nowUs 墙钟
   * @param leadUs 该设备需要的提前量（组 lead + 成员延迟）
   * @param maxUs  本次最多取多少内容（µs，节拍用）
   */
  pull(nowUs: number, leadUs: number, maxUs: number): PullResult {
    let jumpedUs = 0;
    let droppedLate = 0;
    // 落后墙钟过多：整体前跳，不逐帧追（逐帧追==持续投过期内容，实测全判 late）
    if (this.cursorUs !== 0 && this.cursorUs + this.lagResetUs < nowUs) {
      const target = Math.max(nowUs, this.buf.length > 0 ? this.buf[0].tsUs : nowUs);
      jumpedUs = target - this.cursorUs;
      this.cursorUs = target;
      this.jumpTotal += 1;
    }
    if (this.cursorUs === 0) {
      this.cursorUs = this.buf.length > 0 ? Math.max(this.buf[0].tsUs, nowUs - this.graceUs) : nowUs;
    }
    const until = nowUs + leadUs;
    const out: RingFrame[] = [];
    let taken = 0;
    while (this.buf.length > 0) {
      const f = this.buf[0];
      if (f.tsUs < this.cursorUs) {
        // 已过期的旧帧：丢掉并计数（绝不投出去喂设备）
        this.buf.shift();
        this.totalUs -= (f.nFrames / 48_000) * 1e6;
        droppedLate += 1;
        this.droppedLateTotal += 1;
        continue;
      }
      if (f.tsUs > until) break;
      const durUs = (f.nFrames / 48_000) * 1e6;
      if (taken + durUs > maxUs) break;
      this.buf.shift();
      this.totalUs -= durUs;
      out.push(f);
      taken += durUs;
      this.cursorUs = Math.max(this.cursorUs, f.tsUs + durUs);
    }
    return { frames: out, jumpedUs, droppedLate };
  }
}
