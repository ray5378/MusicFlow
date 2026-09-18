// ==================== AirPlay 运行模式(leaf,零依赖) ====================
//
//  - MUSICFLOW_AIRPLAY_CHILD=1:自身就是 airplay 子进程 → 装配推流运行时本体;
//  - MUSICFLOW_AIRPLAY_INPROC=1 或 vitest:主进程内装配(排障回落,免 fork);
//  - MUSICFLOW_AIRPLAY_FORK=1:显式开启把推流会话 fork 到专属子进程;
//  - 其余(生产主进程):**默认 in-proc**。
//
// 为什么默认值与 sendspin 相反:AirPlay 的进程化路径在开发机上没有真机可端到端验证
// (sendspin 当年也是发版后真机验),所以先把能力就位、显式开关才启用;等真机确认
// (投屏起播/seek/暂停/多设备)无回归后,再把下面的 defaultFork 翻成 true 即与
// sendspin 对齐 —— 切换点只有这一行。
//
// 判定规则统一在 rendererHost/mode.ts。
import { isRendererForkMode } from "../rendererHost/mode.js";

export function isAirPlayForkMode(): boolean {
  return isRendererForkMode({
    childEnv: "MUSICFLOW_AIRPLAY_CHILD",
    inprocEnv: "MUSICFLOW_AIRPLAY_INPROC",
    forkEnv: "MUSICFLOW_AIRPLAY_FORK",
    defaultFork: false,
  });
}
