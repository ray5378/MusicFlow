// ==================== 播放器隔离总开关 ====================
//
// 为什么要文件开关：AF_PLAYER_ISOLATION 是进程启动期环境变量，改它必须重建容器
// （丢掉挂载/端口/重启策略）。改造验证期需要频繁 A/B，所以额外支持「标志文件」：
//   开机启用：docker exec musicflow touch /app/backend/data/player-isolation.on
//   关闭    ：docker exec musicflow rm -f  /app/backend/data/player-isolation.on
// 之后 restart 容器即可（文件在持久化卷上，重建容器也仍然生效）。
//
// ===== 对标 MA =====
// MA 位置：无直接对应物。最接近的语义锚点：music_assistant/providers/airplay/
//          stream.py:305-320 —— connect(use_shared_ptp)（参数声明在 :307，
//          「Session-wide decision…」docstring 在 :316-318）：
//          「Session-wide decision on whether native AirPlay 2 members attach to
//          the shared PTP clock daemon. The stream session passes the same value
//          to every member so a group never mixes PTP and NTP timing.」
// MA 语义：行为开关是**会话级统一决策** —— 一个值传给组内每个成员，
//          绝不允许同组混用两种时序/投递模式。
// 我们：进程级总开关（env + 标志文件），语义对齐「会话级统一」—— 开关决定
//          进程内所有组走隔离/广播路径，不做逐组混合。差异原因：MA 的开关在
//          代码/配置里改完重启即可；我们的容器改动成本高（见上），所以额外提供
//          持久化卷上的标志文件做免重建 A/B —— 这是运维面差异，不是语义分歧。
const DEFAULT_FLAG = "/app/backend/data/player-isolation.on";

export function playerIsolationEnabled(): boolean {
  // 2026-11-25 起隔离模式是唯一架构（legacy 投递已删）：默认开启。
  // 回滚通道：MF_PLAYER_ISOLATION=0 强制关闭（应急用，直连模式未经真机验证）。
  if (process.env.MF_PLAYER_ISOLATION === "0") return false;
  return true;
}

