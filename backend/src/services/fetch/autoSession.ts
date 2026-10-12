// ==================== 自动续批会话标记（重启/让渡恢复用） ====================
//
// 全库下载 / 洗版的自动续批链本质是**进程内**链：jobRunner 的任务终态钩子
// （maybeContinueLibraryJob / maybeContinueUpgradeJob）在同一进程里接着开下一批。
// 容器重启、或链因「有其它任务在跑」让渡时，这条链会断——需要调度器凭一个
// **持久化的会话标记**把链接上：
//   - 建批（调度器触发 / 手动全库触发 / 终态钩子续批）时置位；
//   - 链自然收尾（无待办项）/ 用户取消 / 关闭自动开关时清除；
//   - 调度器每 60s tick：标记在 + 当前无活动任务 → 立即开下一批（绕过
//     interval/time-of-day 闸——链在开跑时就已获授权，重启不该干等一个周期）。
//
// 标记只表达「链未完」，不存进度：进度由各流的冷却表（fetch_library_attempts /
// fetch_upgrade_attempts）天然表达——已尝试的歌下一批选不中。
import { getSetting, setSetting } from "../settings.js";

/** 支持自动续批的业务流。 */
export type AutoFlow = "library" | "upgrade";

const SESSION_KEYS: Record<AutoFlow, string> = {
  library: "fetch.library.auto.session",
  upgrade: "fetch.upgrade.auto.session",
};

/** 该流的自动续批链是否仍在进行（重启后调度器据此立即接续）。默认 false。 */
export function isAutoSessionActive(flow: AutoFlow): boolean {
  return getSetting(SESSION_KEYS[flow], "0") === "1";
}

/** 标记 / 清除续批会话。幂等；值落 settings 表，重启不丢。 */
export function setAutoSession(flow: AutoFlow, on: boolean): void {
  setSetting(SESSION_KEYS[flow], on ? "1" : "0");
}
