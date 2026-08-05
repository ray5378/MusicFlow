// 状态迁移判断 + 卡死兜底。对照 MA playback_tracker.py 的
// _handle_playback_progress_report(prev_state, new_state)。
//
// 返回值:
//   "advance"      — 自然结束(PLAYING→IDLE),应推进下一首
//   "ended"        — 整队列播完(PLAYING→IDLE 且无下一首,由 QueueController 判断后传入)
//   "stalled"      — IDLE 卡死超 60s,异常兜底
//   "track_changed"— 同为 PLAYING 但 uri 变了(设备 native gapless 切歌)
//   "none"         — 无需动作
//
// 关键:不在此处判断"有无下一首",由 QueueController 在调用前注入 hasNext。
// 这里只做纯状态迁移判断,便于单测。
import { CompareState, PlaybackState } from "./types.js";

const STALL_TIMEOUT_MS = 60_000; // 对照 MA: elapsed_time_last_updated > 60s

export type TrackDecision =
  | "advance"
  | "ended"
  | "stalled"
  | "track_changed"
  | "none";

export class PlaybackTracker {
  private prev: CompareState | null = null;
  // 上一次"确实在播放"的状态。BUFFERING(TRANSITIONING)/PAUSED 瞬态不覆盖它。
  // 关键:DLNA 设备自然结束时常 PLAYING→TRANSITIONING→STOPPED。若只盯 prev,
  // "BUFFERING→IDLE" 会被判为瞬态 → advance 丢失 → 队列卡死 → 60s 后 stalled 重播当前首。
  // 用 lastPlaying 记住"这首歌确实在播放",之后无论经过多少瞬态,一旦落到 IDLE 即算结束。
  private lastPlaying: CompareState | null = null;

  /** 注入式:调用方告诉 tracker 是否还有下一首,决定 IDLE 是 advance 还是 ended。 */
  update(neww: CompareState, hasNext = true): TrackDecision {
    let decision: TrackDecision = "none";
    const prev = this.prev;
    const cur = neww.playbackState;

    if (cur === PlaybackState.PLAYING) {
      // native gapless:同为 PLAYING 但 uri 变了
      if (prev && prev.playbackState === PlaybackState.PLAYING
               && prev.mediaUri && neww.mediaUri && prev.mediaUri !== neww.mediaUri) {
        decision = "track_changed";
      }
      this.lastPlaying = neww;
    } else if (cur === PlaybackState.IDLE) {
      if (this.lastPlaying) {
        // 上一首确实在播放(可能刚经过 TRANSITIONING/BUFFERING → 现在才落 IDLE)→ 自然结束
        decision = hasNext ? "advance" : "ended";
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

  reset(): void {
    this.prev = null;
    this.lastPlaying = null;
  }

  getPrev(): CompareState | null {
    return this.prev;
  }

  getLastPlaying(): CompareState | null {
    return this.lastPlaying;
  }
}
