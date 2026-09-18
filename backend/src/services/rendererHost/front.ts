// ==================== 常驻渲染器:主进程侧外观工厂(通用) ====================
//
// fork 模式下主进程不持有运行时实例 —— 路由/外围代码必须通过「外观」访问状态与能力:
//   fork    → 代理:同步读镜像(子进程推的快照) + 命令写走 RPC;
//   in-proc → 真实运行时实例(单测 / 排障开关 / 默认未开启进程化的业务)。
// 业务只要保证「真实实例结构上满足外观接口」(用 AssertImplements 哨兵在编译期守住),
// 上层调用方就完全不用区分两种模式 —— 这是让迁移「行为不变」的关键。
import type { RendererHostSupervisor } from "./supervisor.js";

/** 编译期哨兵:真实实现必须满足外观接口(结构漂移第一时间在此爆,而非路由运行时才炸)。 */
export type AssertImplements<TReal, TLike> = TReal extends TLike ? true : never;

export interface FrontAccessorOptions<TLike> {
  /** 当前是否 fork 模式。 */
  isFork: () => boolean;
  /** 子进程宿主是否在运行(fork 模式下用于判空)。 */
  isRunning: () => boolean;
  /** 构造 fork 模式的代理外观(懒建,只调一次)。 */
  createProxy: () => TLike;
  /** in-proc 模式下取真实运行时;未就绪返回 null。 */
  getInProc: () => TLike | null;
}

/** 造一个「取外观」的函数:fork → 代理(未运行返回 null);in-proc → 真实实例。 */
export function createFrontAccessor<TLike>(opts: FrontAccessorOptions<TLike>): () => TLike | null {
  let proxy: TLike | null = null;
  return () => {
    if (!opts.isFork()) return opts.getInProc();
    if (!opts.isRunning()) return null;
    proxy ??= opts.createProxy();
    return proxy;
  };
}

/** 宿主的最小 RPC 面(用于下面的通用助手)。 */
export type RpcHost = Pick<RendererHostSupervisor<any, any, any, any, any>, "rpc">;

/**
 * 镜像即时更新 + RPC fire-and-forget —— 幂等写操作(静音/音量)在主进程侧的通用姿势:
 * 不阻塞调用方,失败也不抛(下一次快照推送或重连会校正镜像)。
 */
export function rpcFireAndForget(host: RpcHost, op: string, payload?: unknown): void {
  void host.rpc(op, payload).catch(() => { /* 子进程未运行/瞬时失败:交给下一轮快照校正 */ });
}
