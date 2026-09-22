// 状态迁移判断 + 卡死兜底。对照 MA playback_tracker.py 的
// _handle_playback_progress_report(prev_state, new_state)。
//
// 返回值:
//   "advance"      — 自然结束(PLAYING→IDLE),应推进下一首
//   "ended"        — 整队列播完(PLAYING→IDLE 且无下一首,由 QueueController 判断后传入)
//   "stalled"      — IDLE 卡死超 STALL_TIMEOUT_MS(15s),异常兜底
//   "track_changed"— 同为 PLAYING 但 uri 变了(设备 native gapless 切歌)
//   "idle_early"   — 收到 IDLE 但进度远未到已知时长:判为 IDLE 误报,**不切歌**
//                    (由 QueueController 复查设备真实状态后决定放行还是撤销)
//   "frozen"       — **PLAYING 但位置在墙钟上长时间一动不动**:设备/推流侧僵死,
//                    链路还在、状态还报 PLAYING,音频却不再前进。由 QueueController
//                    就地重投 + 拉回位置(不是切歌!)。见 FREEZE_TIMEOUT_MS。
//   "none"         — 无需动作
//
// 关键:不在此处判断"有无下一首",由 QueueController 在调用前注入 hasNext。
// 这里只做纯状态迁移判断,便于单测。
//
// ── 为什么必须有"时长"这一维(2026-09-21) ──
// 只靠"PLAYING→IDLE"判结束,等于把结束判定完全交给设备/链路的一句话,于是:
//   · IDLE 误报 → 提前切歌。DLNA 的 GetTransportInfo 一失败,state 就是初值
//     "STOPPED" → 映射成 IDLE → 直接切下一首;AirPlay 是 ffmpeg 流一结束
//     (含中途失败)就报 IDLE;实测 271s 的歌在 200s 被切。
//   · IDLE 不来 → 卡死在结尾。不报位置的设备(实测 HiVi)进度全靠外推,
//     外推封顶在时长就再也涨不动,设备又不报结束 → 631s 仍在 PLAYING、永不切歌。
// 两侧同因:缺少"以已知时长为准"的判据。故这里引入 expectedDuration(见下)。
//
// ── 与 MA 三层防御的对应(2026-09-21 按 MA 补齐第 2·3 层) ──
// MA(76c2fcb)判定"这一首/这一队列确实结束了"靠三层,缺一层就出现上面那两类症状:
//   ① 时长判据  _handle_end_of_queue:567 `seconds_played >= duration - 5`
//      → 设备报 IDLE 只是**触发**,真伪由时长定。本仓 = 下面的 idle_early/overrun。
//   ② 持续确认  _settle_or_resume_delayed:453-470 五次 1s 轮询,期间任何反证即取消。
//      → 本仓 = 下面「位置已到时长」后必须**持续**满足 END_GRACE_MS 才判结束
//        (窗口内设备报回落后段位置/换曲/转 PAUSED 都会撤销,见 overrunAt)。[已对齐]
//   ③ 本地节拍  players/controller.py:_poll_players:3202-3216,对 PLAYING 的 player
//      每 0.5s 把**本地推算**的 corrected_elapsed_time 推给队列侧,不等设备上报。
//      → 本仓 = 下面的 `tick()`。此前只在 reportState(设备采样,本仓 5s)时判,
//        而 DLNA 位置外推**只在采样点推进**(dlna/control.ts:1141),于是
//        「位置到时长 + END_GRACE_MS」被采样粒度拖成 ~10s 才生效。
import { CompareState, PlaybackState } from "./types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("tracker");

// 卡死兜底阈值(我方设计,不是现版 MA 的机制 —— 见下)。
// 2026-09-21 复核 MA `76c2fcb`:全仓 `stall` 只剩 `constants.py:944 STREAM_STALL_TIMEOUT = 20`,
// 那是**流**级别"多久没新 chunk 就当源卡住",与"播放卡死"无关;原先注里写的
// `elapsed_time_last_updated > 60s` 只存在于 2026-08 那版 MA(当时据此实现),上游已移除。本仓有意保留。
//
// ── 2026-09-21 二次订正:60s → 15s,且改「墙钟累积」 ──
// 旧判据是 `neww.updatedAt - prev.updatedAt > 60_000`,要求**连续两次 IDLE 上报间隔超 60s**。
// 但设备采样固定 5s(QueueController.startPollLoop),而每次上报都把 updatedAt 刷成当前时刻
// (DLNA poll 用采样时刻 / AirPlay 用 Date.now() / sendspin 用 Date.now())→ 差值恒为 5s,
// **生产里永远触发不了**(实测:5s 轮询喂 120 次 IDLE,stalled 0 次;单测能过只是因为它手工把
// 两次 update 隔了 61s —— 用例测的是一个生产不成立的输入)。更糟的是它唯一的可达旁路
// (队列停轮询 / advancing 占用超 60s)触发时,恰好会去重投一个**已经播完**的队列。
// 现在改为「进入 IDLE 记一个时刻、离开即清」的墙钟累积,在 tick() 里判 —— 与设备采样频率、
// 与 updatedAt 那个「一字段四义」的字段彻底解耦。
// 阈值取 15s 的依据:dlna/control.ts 的 TRANSPORT_STATE_CACHE_MS = 15000 ——
// 「SOAP 读不到时沿用最近一次成功读数」的最长窗口就是它,过了这个窗口才有资格认定
// 设备确实没在播,而不是"我们读不到"。
const STALL_TIMEOUT_MS = 15_000;

/** 播到已知时长后,再宽限多久才认定"设备不会报结束了"。
 *  取 8s:外推起点是 cast 时刻,设备实际出声常晚 1~3s,外推读数会略超前于真实
 *  播放位置;8s 足够吃掉这段偏差,又不至于让用户在结尾干等。 */
const END_GRACE_MS = 8_000;

/**
 * 「PLAYING 但位置冻结」的判定阈值(2026-09-21 新增,真机实测驱动)。
 *
 * 与 STALL_TIMEOUT_MS(IDLE 卡死)是**两条独立**的僵死路径,必须都有:
 *   · IDLE 卡死 = 设备停了但不说,队列不推进 → 上面那套。
 *   · PLAYING 冻结 = 设备(或推流侧)明明在"播",位置却一动不动。
 *     实测:sendspin peer 报 `PLAYING pos=173.6 dur=280` 整整 3 分钟不变、推流
 *     pump 零日志、后端毫无异常 —— 现有看门狗**全部不触发**,永不自愈。
 *     用户观感就是"进度条卡住不动"(与"归零"不同,不会切歌,只是永远停在那)。
 *
 * 取 30s 的依据:设备采样是 5s(QueueController.startPollLoop),30s = 连续 6 次采样
 * 位置一模一样。正常播放时 6 次采样一定跨过 ≥25s 音频,不可能读数不变;而 seek 后
 * ffmpeg 重起的真空期通常 1~3s,远小于 30s,不会误报(另有 seek 冷静期兜底)。
 */
const FREEZE_TIMEOUT_MS = 30_000;

export type TrackDecision =
  | "advance"
  | "ended"
  | "stalled"
  | "track_changed"
  | "idle_early"
  | "frozen"
  | "none";

/** IDLE 提前量容差:距已知时长还差超过此值 → 判 IDLE 误报。
 *  取 max(5s, 时长的 10%):短歌不至于因几秒抖动被拦,长歌也不会要求精确到秒。 */
function earlyIdleMargin(durationSec: number): number {
  return Math.max(5, durationSec * 0.1);
}

export class PlaybackTracker {
  private prev: CompareState | null = null;
  // 上一次"确实在播放"的状态。BUFFERING(TRANSITIONING)/PAUSED 瞬态不覆盖它。
  // 关键:DLNA 设备自然结束时常 PLAYING→TRANSITIONING→STOPPED。若只盯 prev,
  // "BUFFERING→IDLE" 会被判为瞬态 → advance 丢失 → 队列卡死 → STALL_TIMEOUT_MS 后 stalled 重播当前首。
  // 用 lastPlaying 记住"这首歌确实在播放",之后无论经过多少瞬态,一旦落到 IDLE 即算结束。
  private lastPlaying: CompareState | null = null;
  /**
   * 当前曲的**已知时长(秒)**,由 QueueController 在起播时从曲库注入。
   *
   * 只用注入值、不看设备自报 duration:后者未经我方核对(有设备恒回 0,也有
   * 乱报的),拿它当判据会把"设备报错时长"变成"切歌时机"。注入值为 0 = 未知
   * → 退化成旧的纯状态迁移判定,行为与改动前一致(flow 连续流会话正是走这条)。
   */
  private expectedDuration = 0;
  /** 首次观察到「位置已达已知时长」的时刻(ms)。用于上面的 END_GRACE_MS 计时 ——
   *  外推会把位置封顶在时长,读数是「到顶」而非「超过」,所以只能靠持续时长判定。 */
  private overrunAt: number | null = null;
  /** 进入 IDLE 的时刻(ms),用于卡死兜底的墙钟累积。只在 IDLE 期间累积,离开即清。 */
  private idleSinceAt: number | null = null;
  /** 本次 IDLE 期间是否已派发过 stalled。同一次卡死只报一次 —— 否则 500ms 的 tick
   *  会每拍重复派发;「再来一次」由 QueueController 重投后的 resetTracker 释放。 */
  private idleStallSignaled = false;
  /** 设备上报的 position **最后一次真正变化**的墙上时刻(ms)与当时的读数。
   *
   *  与 `prev.updatedAt` 的区别是这整套判据的关键:`updatedAt` 在每次采样都被刷成
   *  当前时刻(DLNA poll=采样时刻 / sendspin/AirPlay=Date.now()),拿它算"多久没动"
   *  恒得 5s(轮询间隔),永远触发不了 —— 与 STALL_TIMEOUT_MS 那次订正踩的是同一个坑。
   *  所以冻结判据必须自带一个"只在读数变了才刷新"的独立时钟。 */
  private progressAt: number | null = null;
  private progressPos = 0;
  /** 本段冻结是否已派发过 frozen。同段只报一次,位置重新推进 / reset() 时释放。 */
  private frozenSignaled = false;

  /** 起播时注入本曲已知时长(秒)。0/无效值 = 未知。 */
  setExpectedDuration(seconds: number): void {
    const v = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    if (v !== this.expectedDuration) this.overrunAt = null; // 换曲 → 重算宽限
    this.expectedDuration = v;
  }

  getExpectedDuration(): number {
    return this.expectedDuration;
  }

  /** 注入式:调用方告诉 tracker 是否还有下一首,决定 IDLE 是 advance 还是 ended。 */
  update(neww: CompareState, hasNext = true): TrackDecision {
    let decision: TrackDecision = "none";
    const prev = this.prev;
    const cur = neww.playbackState;
    const dur = this.expectedDuration;
    // 下面各分支会把 lastPlaying 清掉,故先快照一份用于日志(它决定 IDLE 能否被认作"真播过")。
    const hadLastPlaying = !!this.lastPlaying;

    // 冻结时钟:只在**设备报的位置真的变了**时才刷新(见 progressAt 字段注释)。
    // 放在状态分支之前 —— 与状态无关,纯粹记录"读数在动"这件事。
    if (Number.isFinite(neww.position) && neww.position !== this.progressPos) {
      this.progressPos = neww.position;
      this.progressAt = Date.now();
      // 位置重新推进 = 不再冻结 → 释放信号,让下一次冻结还能被报出来。
      this.frozenSignaled = false;
    }

    if (cur === PlaybackState.PLAYING) {
      // native gapless:同为 PLAYING 但 uri 变了。
      // 比较时必须剥掉 query(`?timeOffset=N`):同歌 seek 重投只改 query(token 复用
      // 保同一性,见 dlna/control.ts createCastSession 注释),query 交替出现不是换歌。
      // 240 实锤:194s→235s 连续重投,采样在两个 URI 间交替即误判 track_changed →
      // 自动 advance 切下一首(用户观感"拖动后切歌")。真换歌 token 必变,base 仍不同。
      const uriOf = (u: string | undefined): string => (u ?? "").split("?")[0];
      if (prev && prev.playbackState === PlaybackState.PLAYING
               && prev.mediaUri && neww.mediaUri && uriOf(prev.mediaUri) !== uriOf(neww.mediaUri)) {
        decision = "track_changed";
      }
      this.lastPlaying = neww;
      // 位置已到已知时长且持续了一个宽限期,设备却始终不报结束 → 主动判结束。
      // 这是「卡死在结尾」的兜底:不报位置的设备(外推封顶)只会一直 PLAYING。
      if (decision === "none" && dur > 0 && neww.position >= dur) {
        if (this.overrunAt === null) this.overrunAt = neww.updatedAt;
        if (neww.updatedAt - this.overrunAt >= END_GRACE_MS) {
          decision = hasNext ? "advance" : "ended";
          this.lastPlaying = null;
          this.overrunAt = null;
          this.expectedDuration = 0; // 已判结束,避免同一首反复 advance
        }
      } else if (this.overrunAt !== null && (dur <= 0 || neww.position < dur)) {
        this.overrunAt = null;
      }
    } else if (cur === PlaybackState.IDLE) {
      if (this.lastPlaying) {
        // 上一首确实在播放(可能刚经过 TRANSITIONING/BUFFERING → 现在才落 IDLE)。
        // 设备上报 IDLE 时 position 常回 0,故取「末次 PLAYING 位置」与本次的较大值 ——
        // 否则不报位置的设备(外推读数在 IDLE 时归零)会被误判成"刚开始播就停了"。
        const pos = Math.max(neww.position || 0, this.lastPlaying.position || 0);
        if (dur > 0 && pos < dur - earlyIdleMargin(dur)) {
          // 距结尾还差得远就报结束 → 判误报(SOAP 抖动 / 链路瞬断),不切歌。
          // 注意保留 expectedDuration:设备多半还在播,等它自己到时长再判。
          decision = "idle_early";
        } else {
          decision = hasNext ? "advance" : "ended";
          this.expectedDuration = 0;
        }
        this.lastPlaying = null;
      }
      // 其余:无 lastPlaying 的单发 IDLE 不误判(首次 update / 纯净 IDLE)。
      // 卡死兜底不在这里判 —— 它要的是「持续了多久」,而 update 是事件驱动(5s 采样),
      // 给不出采样粒度以下的时刻;改由 tick() 用墙钟累积判(见 STALL_TIMEOUT_MS)。
    }
    // BUFFERING / PAUSED:不作为结束(瞬态屏蔽)。lastPlaying 保持,便于后续 IDLE 落入上方分支。
    // 卡死计时:只在 IDLE 期间累积,一旦离开 IDLE(PLAYING/PAUSED/BUFFERING)即清零 ——
    // 暂停/缓冲的墙钟不该算进「卡住多久」,与 MA 只对 PLAYING 计时的口径一致。
    if (cur === PlaybackState.IDLE) {
      if (this.idleSinceAt === null) this.idleSinceAt = Date.now();
    } else {
      this.idleSinceAt = null;
      this.idleStallSignaled = false;
    }
    this.prev = neww;
    // debug:状态迁移判定的最终裁决点 —— 决策 + 全部判据输入一起打。拖动后被切歌 /
    // 判成结束 / 卡死这类问题的根因(时长已知与否、lastPlaying 有没有置上、
    // uri 是否变了)在这一行就齐了,不必再去翻上游各层。
    log.debug(`[tracker][update] ${prev?.playbackState ?? "-"}→${cur} pos=${Math.round(neww.position)} dur=${Math.round(dur)} hasNext=${hasNext} lastPlaying=${hadLastPlaying} uri=${neww.mediaUri ? "y" : "n"} → ${decision}`);
    return decision;
  }

  /**
   * 本地节拍推进(PlayerController 每 500ms 调一次,不触设备)。
   *
   * 对照 MA `players/controller.py:_poll_players`(3202-3216):MA 只对 PLAYING 的
   * player 每 0.5s 把**本地推算**的 `corrected_elapsed_time` 推给队列侧,不等设备
   * 上报 —— 设备采样只负责纠偏,不负责决定切歌时刻。
   *
   * 本仓缺口:结束判定原先只在 reportState 时跑,而 DLNA 的位置外推只在采样点推进
   * (`dlna/control.ts:1141`),于是「位置到时长 + END_GRACE_MS」被 5s 采样粒度拖成
   * ~10s 才生效(用户观感 = 唱完了还停着不动)。这里用「末次 PLAYING 快照 + 墙上
   * 时钟」自行外推,把判定接回 0.5s 节拍,总延迟回到 END_GRACE_MS 量级。
   *
   * 只读不写:不动 prev(否则污染状态迁移比较),而对外推有意义的只有末次 PLAYING
   * 快照。判结束后必须清掉时长 —— 设备多半仍报 PLAYING,不清就会同一首反复 advance。
   *
   * 这里同时承担**卡死兜底**(与结束判定共用同一节拍,不再依赖设备上报时刻):
   * 见下方 IDLE 分支(STALL_TIMEOUT_MS)与 PLAYING 冻结分支(FREEZE_TIMEOUT_MS)。
   */
  tick(nowMs: number): TrackDecision {
    const cur = this.prev;
    if (!cur) return "none";

    // ① 卡死兜底:进入 IDLE 后墙钟累积超过 STALL_TIMEOUT_MS 仍未离开 → 报 stalled。
    //    这是唯一能真正触发它的地方 —— 设备采样只有 5s 粒度,而 updatedAt 一字段四义
    //    (DLNA poll=采样时刻 / DLNA GENA=事件时刻 / AirPlay=快照时刻 / sendspin=now),
    //    任何「按上报时间差」的判据都会随来源漂移。
    if (cur.playbackState === PlaybackState.IDLE) {
      if (this.idleSinceAt === null || this.idleStallSignaled) return "none";
      if (nowMs - this.idleSinceAt < STALL_TIMEOUT_MS) return "none";
      this.idleStallSignaled = true; // 同一次卡死只报一次,等 reset()/离开 IDLE 释放
      // debug:卡死兜底触发点。拖动后无声/设备已停但队列不前进时,这一行是判定依据;
      // 配合上面的 [tracker][update] 看「最后一次 IDLE 是怎么来的」(误报 or 真停)。
      log.debug(`[tracker][tick] IDLE 持续 ${nowMs - this.idleSinceAt}ms ≥ ${STALL_TIMEOUT_MS}ms → stalled`);
      return "stalled";
    }

    // ② 结束兜底:PLAYING 且位置已到已知时长,持续一个宽限期仍不报结束 → 判结束。
    const dur = this.expectedDuration;
    // 非 PLAYING(PAUSED/BUFFERING)不推进:暂停期间的墙钟不该算进宽限,
    // 恢复播放后重新起算,避免「暂停前已等 7s」导致刚恢复就判结束。
    if (dur <= 0 || cur.playbackState !== PlaybackState.PLAYING) return "none";
    const pos = cur.position + (nowMs - cur.updatedAt) / 1000;
    if (pos < dur) {
      this.overrunAt = null;
      // ③ 冻结兜底:PLAYING、时长已知、且位置**在墙钟上**一动不动 ≥ FREEZE_TIMEOUT_MS
      //    → 判 frozen(设备/推流侧僵死,链路还在但音频不再前进)。
      //
      //    ⚠️ 判据不能用上面那个 `pos`:它按 `updatedAt` 外推,而 updatedAt 每次采样
      //    都被刷成当前时刻 → 冻结时 pos 照样"在涨"(恒为 frozen+5s),永远看不见卡住。
      //    必须用 progressAt —— 它只在设备报的位置真的变了才刷新(见 update())。
      //
      //    progressPos > 0 是必要的护栏:设备报告"position 恒 0"是**未知**而非冻结
      //    (部分渲染器不实现 GetPositionInfo),它可能正在正常出声 —— 那种情况
      //    交给 IDLE 卡死 / 结束兜底,绝不在这里动手。
      if (!this.frozenSignaled && this.progressPos > 0 && this.progressAt !== null
          && nowMs - this.progressAt >= FREEZE_TIMEOUT_MS) {
        this.frozenSignaled = true; // 同一段冻结只报一次,等位置重新推进 / reset() 释放
        log.debug(`[tracker][tick] PLAYING 但位置冻结在 ${Math.round(this.progressPos)}s(已 ${nowMs - this.progressAt}ms ≥ ${FREEZE_TIMEOUT_MS}ms)→ frozen`);
        return "frozen";
      }
      return "none";
    }
    if (this.overrunAt === null) this.overrunAt = nowMs;
    if (nowMs - this.overrunAt < END_GRACE_MS) return "none";
    this.lastPlaying = null;
    this.overrunAt = null;
    this.expectedDuration = 0;
    log.debug(`[tracker][tick] 位置外推 ${Math.round(pos)}s ≥ 时长 ${Math.round(dur)}s 且过宽限 → advance`);
    return "advance";
  }

  reset(): void {
    this.prev = null;
    this.lastPlaying = null;
    this.overrunAt = null;
    // 卡死计时一并清:新一轮播放(stalled 重投 / 切歌)时若不清,上一次 IDLE 累积的
    // 墙钟会立刻让新队列被判卡死。同时释放 idleStallSignaled,让新的一轮还能再报。
    this.idleSinceAt = null;
    this.idleStallSignaled = false;
    // 冻结时钟同理:重投/切歌后位置会从新起点重新变化,progressAt 不清也不会误报,
    // 但 progressPos 会带着上一首的读数 —— 清掉,让新的一轮从"未知"重新学起。
    this.progressAt = null;
    this.progressPos = 0;
    this.frozenSignaled = false;
  }

  getPrev(): CompareState | null {
    return this.prev;
  }

  getLastPlaying(): CompareState | null {
    return this.lastPlaying;
  }
}
