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

  /** 注入式:调用方告诉 tracker 是否还有下一首,决定 IDLE 是 advance 还是 ended。 */
  update(neww: CompareState, hasNext = true): TrackDecision {
    let decision: TrackDecision = "none";
    if (this.prev) {
      const prev = this.prev;
      const cur = neww.playbackState;
      const psv = prev.playbackState;

      // 自然结束:PLAYING → IDLE
      if (psv === PlaybackState.PLAYING && cur === PlaybackState.IDLE) {
        decision = hasNext ? "advance" : "ended";
      }
      // native gapless:同为 PLAYING 但 uri 变了
      else if (psv === PlaybackState.PLAYING && cur === PlaybackState.PLAYING
               && prev.mediaUri && neww.mediaUri && prev.mediaUri !== neww.mediaUri) {
        decision = "track_changed";
      }
      // 卡死兜底:IDLE 持续超 60s
      else if (psv === PlaybackState.IDLE && cur === PlaybackState.IDLE
               && (neww.updatedAt - prev.updatedAt) > STALL_TIMEOUT_MS) {
        decision = "stalled";
      }
      // TRANSITIONING(BUFFERING)→ 任何:不当结束(瞬态屏蔽,由乐观设态保证 prev 仍是 PLAYING)
    }
    this.prev = neww;
    return decision;
  }

  reset(): void {
    this.prev = null;
  }

  getPrev(): CompareState | null {
    return this.prev;
  }
}
