// ==================== 暂停看门狗冷静期(「自动转 stop」与「真结束」的隔离) ====================
//
// 解决的问题(2026-09-30 真机实测,两轮复现):
//   HA 卡片点暂停 → pauseCore 置 paused + 广播 paused;设备把 ~30s 缓冲播完后静音。
//   暂停满 30s 未恢复,看门狗(对齐 MA `_watch_pause`)自动 stopCore 拆流 →
//   设备**排空缓冲(~26s+)之后**才上报 IDLE → QueueController idle_early 复查:
//   设备确实停了 → 放行切歌 → **自动切下一首**。用户观感:「暂停 → 缓冲播完停几秒
//   → 自己切歌了」。
//
//   v1(15s 限时冷静期)为什么失效:打标发生在看门狗转 stop 的瞬间,而 idle_early
//   复查要等设备把缓冲播完才来(实测 ~26s)—— 复查到达时冷静期早已过期,照样放行。
//   教训:复查到达时刻 = 缓冲排空时长,**上限未知**,任何限时窗口都是赌。
//
// v2 语义(定稿):**打标不过期,持久到「新的播放会话开始」才清除**。
//   MA 语义:`_watch_pause` 转的 stop 只停传输,**队列留在当前曲**(stopped = 可续播),
//   队列推进只由「曲目真结束」驱动,从不由「暂停超时」驱动。因此这道 stop 之后,
//   无论复查来得早晚(26s 还是 26 分钟),idle_early 一律不得放行切歌。
//
//   清除点(= 标记生命周期终点,全部是「新的播放动作」):
//     · QueueController.transport:op=play(恢复播放)/ op=stop(丢弃上下文);
//     · QueueController.playCurrent:起播漏斗(手动上下曲/跳转/自动推进/恢复重投都汇于此)。
//   打标 Map 在进程内存中,后端重启自然清空;条目数以播放器数为上界,无泄漏。
import { createLogger } from "../../utils/logger.js";

const log = createLogger("pause-stop-settle");

/** peer(裸 id) → 最近一次「暂停看门狗转 stop」时刻。**不过期**,
 *  直到 transport(play/stop)或 playCurrent 开启新播放会话才清除(见顶部注释)。 */
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

/** 记一次「暂停看门狗转 stop」。**在 stopCore 拆流之前**调用。
 *  ⚠️ 必须落在**主进程**(idle_early 复查在主进程 QueueController):fork 模式下
 *  子进程经 IPC(sendspin/child.ts → supervisor.ts)上报,由主进程侧调用本函数;
 *  子进程原地调用打不进主进程的 Map(2026-09-30 真机两次复现的根因)。 */
export function markPauseStopIssued(playerId: string, at: number = Date.now()): void {
  const k = pauseStopSettleKey(playerId);
  lastPauseStopAt.set(k, at);
  log.info(`[pauseStopSettle] mark ${k} (看门狗转 stop,持久标记:新播放会话前 idle_early 不放行)`);
}

/** 此刻的 IDLE 是否应解释为「暂停看门狗转 stop」(= 保留队列位置,不切歌)。
 *  **无时间窗**:复查到达的时刻取决于设备缓冲排空(实测 ~26s,上限未知),
 *  限时窗口赌不赢排空时长 —— 打标持续到新播放会话清除为止。 */
export function withinPauseStopSettle(playerId: string): boolean {
  return lastPauseStopAt.has(pauseStopSettleKey(playerId));
}

/** 清除标记:任何「新的播放动作」都要恢复原有切歌能力 ——
 *  transport(op=play/stop)与 playCurrent(起播漏斗)在动作入口调用。
 *  未打标时调用是静默 no-op。 */
export function clearPauseStop(playerId: string): void {
  const k = pauseStopSettleKey(playerId);
  if (lastPauseStopAt.delete(k)) {
    log.info(`[pauseStopSettle] clear ${k} (新播放会话,恢复 idle_early 切歌能力)`);
  }
}
