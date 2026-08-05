// Player 状态管理 + 双层去抖转发 + 乐观窗口。对照 MA:
//   - players/controller.py trigger_player_update (0.25s 去抖)
//   - call_later(0.5s) 转发到 player_queues.on_player_update
//
// 乐观窗口:cast 期间(beginOptimistic)忽略 IDLE 上报,屏蔽切歌瞬态。
//   对照 MA 乐观设态:命令发出前先把 _attr_playback_state = PLAYING。
// 5s play 超时:对照 MA PLAYBACK_START_TIMEOUT=5.0。
import { PlaybackTracker, type TrackDecision } from "./PlaybackTracker.js";
import { PlaybackState, PlayerState, toCompareState } from "./types.js";

const DEBOUNCE_LAYER1_MS = 250;  // player 层去抖
const DEBOUNCE_LAYER2_MS = 500;  // → queue 层去抖
const PLAY_TIMEOUT_MS = 5000;    // 乐观窗口上限

type DecisionFn = (decision: TrackDecision, playerId: string) => void;

interface OptimisticState {
  mediaUri: string;
  startedAt: number;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

export class PlayerController {
  private trackers = new Map<string, PlaybackTracker>();
  private latest = new Map<string, PlayerState>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private forwardTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private optimistic = new Map<string, OptimisticState>();
  // 去抖窗口内 tracker 给出的最新决策;evaluate 时转发非 none 的那个。
  // 关键:tracker 在 reportState 时即时喂入,这样同一去抖窗口内的
  // PLAYING→IDLE 迁移也能被捕获(否则 evaluate 只看到合并后的 IDLE)。
  private pendingDecision = new Map<string, TrackDecision>();
  /** 由 QueueController 注入。 */
  onDecision: DecisionFn = () => {};

  private trackerOf(playerId: string): PlaybackTracker {
    let t = this.trackers.get(playerId);
    if (!t) { t = new PlaybackTracker(); this.trackers.set(playerId, t); }
    return t;
  }

  /** 协议端点上报状态。0.25s 去抖后转发。 */
  reportState(state: PlayerState): void {
    this.latest.set(state.playerId, state);
    // 乐观窗口:若该 player 正在切歌,忽略 IDLE/异常上报,只接受 PLAYING(确认成功)
    const opt = this.optimistic.get(state.playerId);
    if (opt) {
      if (state.playbackState === PlaybackState.PLAYING) {
        // 切歌成功,关闭乐观窗口,让正常去抖流程处理(u1→u2 = track_changed)。
        // 对照 MA:收到 PLAYING 即确认成功,不要求 URI 精确匹配 ——
        // 设备可能不上报 CurrentTrackURI(GENA LastChange 常缺此字段),
        // 或上报的 URI 与我们的 streamUrl 不一致(设备解析/重定向),
        // 强制 URI 匹配会导致乐观窗口永远无法关闭 → 5s 超时 → stalled 死循环。
        this.clearOptimistic(state.playerId);
        // 落入下方正常去抖逻辑(不 return)
      } else {
        // 乐观窗口内忽略非 PLAYING 上报(屏蔽瞬态 STOPPED/TRANSITIONING)
        return;
      }
    }
    const playerId = state.playerId;
    // 即时喂 tracker:捕获去抖窗口内的状态迁移(如 PLAYING→IDLE 自然结束)。
    const decision = this.trackerOf(playerId).update(toCompareState(state));
    this.pendingDecision.set(playerId, decision);
    // 第一层去抖:250ms 内多次上报合并
    const existing = this.debounceTimers.get(playerId);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(playerId, setTimeout(() => {
      this.debounceTimers.delete(playerId);
      this.scheduleForward(playerId);
    }, DEBOUNCE_LAYER1_MS));
  }

  private scheduleForward(playerId: string): void {
    // 第二层去抖:再等 500ms 后做决策
    const existing = this.forwardTimers.get(playerId);
    if (existing) clearTimeout(existing);
    this.forwardTimers.set(playerId, setTimeout(() => {
      this.forwardTimers.delete(playerId);
      this.evaluate(playerId);
    }, DEBOUNCE_LAYER2_MS));
  }

  private evaluate(playerId: string): void {
    // 转发去抖窗口内 tracker 给出的最新非 none 决策。
    const decision = this.pendingDecision.get(playerId);
    this.pendingDecision.delete(playerId);
    if (decision && decision !== "none") {
      this.onDecision(decision, playerId);
    }
  }

  /** 开始乐观窗口:cast 命令发出前调用。屏蔽此期间的 IDLE 上报。 */
  beginOptimistic(playerId: string, mediaUri: string): void {
    this.clearOptimistic(playerId);
    const timeoutTimer = setTimeout(() => {
      // 5s 内未确认 PLAYING → 视为卡死
      this.optimistic.delete(playerId);
      this.onDecision("stalled", playerId);
    }, PLAY_TIMEOUT_MS);
    this.optimistic.set(playerId, { mediaUri, startedAt: Date.now(), timeoutTimer });
  }

  private clearOptimistic(playerId: string): void {
    const opt = this.optimistic.get(playerId);
    if (opt) { clearTimeout(opt.timeoutTimer); this.optimistic.delete(playerId); }
  }

  /** 显式结束乐观窗口(cast 成功/失败都调)。 */
  endOptimistic(playerId: string): void {
    this.clearOptimistic(playerId);
  }

  getLatest(playerId: string): PlayerState | undefined {
    return this.latest.get(playerId);
  }

  reset(playerId: string): void {
    this.trackerOf(playerId).reset();
    this.latest.delete(playerId);
    this.pendingDecision.delete(playerId);
    this.clearOptimistic(playerId);
    const d = this.debounceTimers.get(playerId); if (d) { clearTimeout(d); this.debounceTimers.delete(playerId); }
    const f = this.forwardTimers.get(playerId); if (f) { clearTimeout(f); this.forwardTimers.delete(playerId); }
  }
}
