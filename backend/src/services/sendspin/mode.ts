// ==================== Sendspin 运行模式(leaf,零依赖) ====================
//
//  - MUSICFLOW_SENDSPIN_CHILD=1:自身就是 sendspin 子进程 → in-proc 装配(运行时本体);
//  - MUSICFLOW_SENDSPIN_INPROC=1 或 vitest:主进程内装配(单测免 fork);
//  - 其余(生产主进程):sendspin 运行时 fork 到专属子进程(supervisor.ts 管理)。
// 独立成 leaf 模块:protocolPlayer / announce / childMain 等热路径都能零成本引用,
// 不经 index.ts(那里挂着 runtime/server 重图,避免任何潜在初始化环)。
export function isForkMode(): boolean {
  if (process.env.MUSICFLOW_SENDSPIN_CHILD === "1") return false;
  if (process.env.MUSICFLOW_SENDSPIN_INPROC === "1") return false;
  if (process.env.VITEST) return false;
  return true;
}
