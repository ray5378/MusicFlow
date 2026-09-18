// ==================== 常驻渲染器:运行模式判定(leaf,零依赖) ====================
//
// 每个渲染器业务都有三种形态,判定规则一致,只有 env 前缀与默认值不同:
//   1. 自身就是某业务的子进程(CHILD=1)      → 走 in-proc 装配(即运行时本体);
//   2. 主进程但强制 in-proc(INPROC=1 / 测试) → 不 fork;
//   3. 其余(生产主进程)                      → 按业务默认值决定 fork 与否。
//
// 独立成 leaf 模块(零依赖):protocolPlayer / announce / childMain 等热路径都能零成本引用,
// 不经业务 index.ts(那里挂着 runtime/server 重图,避免初始化环)。

export interface RendererForkModeOptions {
  /** 「自身是该业务子进程」的 env 名(设为 "1" 时一律返回 false)。 */
  childEnv: string;
  /** 「强制主进程内装配」的 env 名(排障/单测用,可选)。 */
  inprocEnv?: string;
  /** 「显式开启 fork」的 env 名(默认 in-proc 的业务用,可选)。 */
  forkEnv?: string;
  /** 两个开关都没设时,生产主进程的默认值。 */
  defaultFork: boolean;
}

/** 判定当前进程是否应把渲染器运行时 fork 到专属子进程。 */
export function isRendererForkMode(opts: RendererForkModeOptions): boolean {
  if (process.env[opts.childEnv] === "1") return false;
  if (opts.inprocEnv && process.env[opts.inprocEnv] === "1") return false;
  if (process.env.VITEST) return false; // 单测永不真 fork
  if (opts.forkEnv && process.env[opts.forkEnv] === "1") return true;
  return opts.defaultFork;
}
