// ==================== 暂停看门狗冷静期(「自动转 stop」与「真结束」的隔离) ====================
//
// 解决的问题(2026-09-30 真机实测):
//   HA 卡片点暂停 → pauseCore 置 paused + 广播 paused;设备把 ~30s 缓冲播完后静音。
//   暂停满 30s 未恢复,看门狗(对齐 MA `_watch_pause`)自动 stopCore 拆流 →
//   PlayerController 上报 IDLE(pos=暂停位置, dur=曲长)→ PlaybackTracker 判 `idle_early`
//   → QueueController 复查:传输确实停了 → 「复查确认已停,放行切歌」→ **自动切下一首**。
//   用户观感:「暂停 → 缓冲播完停几秒 → 自己切歌了」。
//
//   真机日志(两次同样序列):
//     [sendspin] group/update -> paused
//     [Sendspin] 暂停满 30s 未恢复,自动转 stop(对齐 MA _watch_pause)
//     [sendspin] pushLoop 退出: contentEnded=false running=false
//     [QueueController][idle_early] … 复查确认已停,放行切歌
//     [QueueController][playCurrent] idx=…   ← 自动切歌
//
// MA 语义:`_watch_pause` 转的 stop 只停传输,**队列留在当前曲**(stopped = 可续播),
// 再按播放从当前曲重播;MA 的队列推进只由「曲目真结束」驱动,从不由「暂停超时」驱动。
// 因此:看门狗转 stop 的瞬间打标,冷静期内收到的 IDLE 一律按「暂停超时停」解释,
// 不得放行切歌。冷静期只拦这一条判据 —— 真播完走 `advance` / `ended`,不受影响。
// (与 seekSettle.ts 同构:同一类「我们自己制造的 IDLE」,同一类隔离手法。)
import { createLogger } from "../../utils/logger.js";

const log = createLogger("pause-stop-settle");

/** 看门狗转 stop 后的冷静期(毫秒)。
 *  取值依据:stopCore → finishPlayback → 状态上报几乎立即(同秒级);状态轮询粒度 5s;
 *  留一档余量 → 15s 足以覆盖「转停 → IDLE 上报 → idle_early 复查」整条链,又远小于
 *  「用户按播放恢复」的合理间隔。 */
export const PAUSE_STOP_SETTLE_MS = 15_000;

/** peer(裸 id) → 最近一次「暂停看门狗转 stop」时刻。 */
const lastPauseStopAt = new Map<string, number>();

/** 归一化 playerId:sendspin 组名是 `ug:<gid>`,而 QueueController 侧见到的是
 *  `group:<gid>` —— 两侧必须归到同一个 key,否则标的与查的不是一条记录。
 *  其余前缀与 seekSettleKey 对齐(dlna/group/airplay/sendspin/local)。
 *  注:未知前缀不剥(避免把裸 id 里本来就有的冒号吃掉)。 */
export function pauseStopSettleKey(playerId: string): string {
  for (const p of ["ug:", "dlna:", "group:", "airplay:", "sendspin:", "local:"]) {
    if (playerId.startsWith(p)) return playerId.slice(p.length);
  }
  return playerId;
}

/** 记一次「暂停看门狗转 stop」。**在 stopCore 拆流之前**调用。 */
export function markPauseStopIssued(playerId: string, at: number = Date.now()): void {
  const k = pauseStopSettleKey(playerId);
  lastPauseStopAt.set(k, at);
  log.info(`[pauseStopSettle] mark ${k} (看门狗转 stop,冷静期 ${PAUSE_STOP_SETTLE_MS}ms)`);
}

/** 是否仍在「暂停看门狗转 stop」冷静期内(= 此刻的 IDLE 应解释为暂停超时停,不切歌)。 */
export function withinPauseStopSettle(playerId: string, now: number = Date.now()): boolean {
  const at = lastPauseStopAt.get(pauseStopSettleKey(playerId));
  if (at === undefined) return false;
  return now - at < PAUSE_STOP_SETTLE_MS;
}
