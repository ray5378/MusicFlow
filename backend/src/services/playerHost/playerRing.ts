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
//
// ===== 对标 MA =====
// MA 位置：music_assistant/providers/sendspin/playback.py:52-76（LIVE_MEDIA_TYPES
//          注释段 + min_buffer_ms 语义）、playback.py:922（sleep_to_limit_buffer）
//          ；缓冲面 = 每成员一条 PushStream（sendspin/player.py 角色模型）。
// MA 语义：每个成员有自己的时间线缓冲与 send-ahead 调度 —— live 源播放开始后
//          send-ahead 固定在 min_buffer_ms floor，buffered 源可涨到 required_lead；
//          「产多少」由成员缓冲水位反压（超 30s 生产者睡眠），成员间互不影响。
// 我们：PlayerRing = 广播/隔离路径下每台播放器的**本环**，等价 MA 的单成员
//          PushStream 缓冲面。差异：MA 的缓冲调度在 aiosendspin 库内（成员连接里），
//          我们在父进程内显式建模（horizon/grace/lagReset/maxBuffer 四参数），
//          以便在「共享内容环广播」架构下复刻「落后只影响自己」的隔离性。

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
    // 对标 MA playback.py:82 _PRODUCER_BUFFER_LIMIT_US（值 30_000_000，语义=单成员
    //   缓冲上限，超则生产者睡眠）。
    // 我们：20_000_000。差异原因：本环只是「隔离面」缓冲，组侧另有共享环(35s 上限)
    //   兜底，20s 抗抖动已足且省内存（20s ≈ 7.5MB/台 @192KB/s）。
    this.horizonUs = opts.horizonUs ?? 20_000_000;
    // 对标 MA playback.py:91 _HISTORY_KEEP_PAST_US（值 1_000_000，语义=提交历史
    //   保留已消费 1s 供 late-join 回填）。
    // 我们：300_000。差异原因：本环不承担回填职责（组环负责），只留「刚错过」的
    //   最小余量防时钟抖动误丢；MA 的 1s 是为 join 追赶处理器预热 ffmpeg 缓冲，
    //   我们没有 DSP 追赶管线，不需要那么多历史。
    this.graceUs = opts.graceUs ?? 300_000;
    // 对标 MA playback.py:90 ANCHOR_REBASE_SIGNIFICANT_US（值 500_000，语义=锚点
    //   偏移超此值才算显著、立即重锚）。
    // 我们：1_500_000。差异原因：本环落后 0~1.5s 之间还能靠 grace 余量自然续上，
    //   给「追得上」留余地，超 1.5s 才整体前跳；广播路径的跳转阈值已按 MA 收紧到
    //   500ms（CURSOR_JUMP_BEHIND_US）—— 两条路径口径独立，互不影响。
    this.lagResetUs = opts.lagResetUs ?? 1_500_000;
    // 容量兜底（帧总时长上限）：与 horizonUs 同量级，防「历史帧塞满」的内存膨胀；
    // MA 的对应物是 PushStream 的固定容量队列，语义相同。
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
   * 取出本次应投递的帧（节拍续杯：每 tick 最多 maxUs，由消费进度驱动）。
   *
   * 对标 MA（预灌/续杯）：MA 的 send-ahead 语义（playback.py:52-76）= 播放开始后
   * send-ahead 固定在 min_buffer_ms（live 源 floor；buffered 源可涨到
   * required_lead），aiosendspin 按该 lead 调度成员消费 —— 产多少由成员缓冲水位
   * 决定，不由生产者决定。
   * 我们：`leadUs` 就是该设备的 send-ahead（组 lead + 成员延迟补偿），取料上沿 =
   * `nowUs + leadUs` —— 设备消费到哪、就补到哪（消费驱动续杯，与广播路径的
   * 需求闸门同一哲学）；`maxUs` 限制单拍取量 = 稳态节拍灌注，避免把设备队列
   * 瞬间顶穿。MA 的对应角色是 `sleep_to_limit_buffer`（限**生产**），我们限
   * **投递** —— 方向相反，因为我们的瓶颈面在投递侧（泵是共享的）。
   *
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
