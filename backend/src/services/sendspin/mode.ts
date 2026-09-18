// ==================== Sendspin 运行模式(leaf,零依赖) ====================
//
//  - MUSICFLOW_SENDSPIN_CHILD=1:自身就是 sendspin 子进程 → in-proc 装配(运行时本体);
//  - MUSICFLOW_SENDSPIN_INPROC=1 或 vitest:主进程内装配(单测免 fork);
//  - 其余(生产主进程):sendspin 运行时 fork 到专属子进程(supervisor.ts 管理)。
// 判定规则已统一到 rendererHost/mode.ts,这里只声明本业务的 env 与默认值(生产默认 fork)。
import { isRendererForkMode } from "../rendererHost/mode.js";

export function isForkMode(): boolean {
  return isRendererForkMode({
    childEnv: "MUSICFLOW_SENDSPIN_CHILD",
    inprocEnv: "MUSICFLOW_SENDSPIN_INPROC",
    defaultFork: true,
  });
}
