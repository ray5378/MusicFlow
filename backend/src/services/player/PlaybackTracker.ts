// 状态迁移判断 + 卡死兜底。对照 MA playback_tracker.py 的
// _handle_playback_progress_report(prev_state, new_state)。
//
// 返回值:
//   "advance"      — 自然结束(PLAYING→IDLE),应推进下一首
//   "ended"        — 整队列播完(PLAYING→IDLE 且无下一首,由 QueueController 判断后传入)
//   "stalled"      — IDLE 卡死超 60s,异常兜底
//   "track_changed"— 同为 PLAYING 但 uri 变了(设备 native gapless 切歌)
//   "idle_early"   — 收到 IDLE 但进度远未到已知时长:判为 IDLE 误报,**不切歌**
//                    (由 QueueController 复查设备真实状态后决定放行还是撤销)
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

// 卡死兜底阈值(我方设计,不是现版 MA 的机制 —— 见下)。
// 2026-09-21 复核 MA `76c2fcb`:全仓 `stall` 只剩 `constants.py:944 STREAM_STALL_TIMEOUT = 20`,
// 那是**流**级别"多久没新 chunk 就当源卡住",与"播放卡死"无关;原先注里写的
// `elapsed_time_last_updated > 60s` 只存在于 2026-08 那版 MA(当时据此实现),上游已移除。本仓有意保留。
const STALL_TIMEOUT_MS = 60_000;

/** 播到已知时长后,再宽限多久才认定"设备不会报结束了"。
 *  取 8s:外推起点是 cast 时刻,设备实际出声常晚 1~3s,外推读数会略超前于真实
 *  播放位置;8s 足够吃掉这段偏差,又不至于让用户在结尾干等。 */
const END_GRACE_MS = 8_000;

export type TrackDecision =
  | "advance"
  | "ended"
  | "stalled"
  | "track_changed"
  | "idle_early"
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
  // "BUFFERING→IDLE" 会被判为瞬态 → advance 丢失 → 队列卡死 → 60s 后 stalled 重播当前首。
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

    if (cur === PlaybackState.PLAYING) {
      // native gapless:同为 PLAYING 但 uri 变了
      if (prev && prev.playbackState === PlaybackState.PLAYING
               && prev.mediaUri && neww.mediaUri && prev.mediaUri !== neww.mediaUri) {
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
      } else if (prev && prev.playbackState === PlaybackState.IDLE
               && (neww.updatedAt - prev.updatedAt) > STALL_TIMEOUT_MS) {
        // 卡死兜底:从未播放 / 已结尾,IDLE 持续超 60s
        decision = "stalled";
      }
      // 其余:无 lastPlaying 的单发 IDLE 不误判(首次 update / 纯净 IDLE)
    }
    // BUFFERING / PAUSED:不作为结束(瞬态屏蔽)。lastPlaying 保持,便于后续 IDLE 落入上方分支。
    this.prev = neww;
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
   */
  tick(nowMs: number): TrackDecision {
    const dur = this.expectedDuration;
    const cur = this.prev;
    // 非 PLAYING(PAUSED/BUFFERING/IDLE)不推进:暂停期间的墙钟不该算进宽限,
    // 恢复播放后重新起算,避免「暂停前已等 7s」导致刚恢复就判结束。
    if (dur <= 0 || !cur || cur.playbackState !== PlaybackState.PLAYING) return "none";
    const pos = cur.position + (nowMs - cur.updatedAt) / 1000;
    if (pos < dur) {
      this.overrunAt = null;
      return "none";
    }
    if (this.overrunAt === null) this.overrunAt = nowMs;
    if (nowMs - this.overrunAt < END_GRACE_MS) return "none";
    this.lastPlaying = null;
    this.overrunAt = null;
    this.expectedDuration = 0;
    return "advance";
  }

  reset(): void {
    this.prev = null;
    this.lastPlaying = null;
    this.overrunAt = null;
  }

  getPrev(): CompareState | null {
    return this.prev;
  }

  getLastPlaying(): CompareState | null {
    return this.lastPlaying;
  }
}
