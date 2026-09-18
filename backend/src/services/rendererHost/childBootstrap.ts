// ==================== 常驻渲染器子进程:启动骨架(通用) ====================
//
// 每个常驻渲染器子进程入口(child.ts)的样板逻辑都收敛到这里:
//   1. 致命异常兜底 —— 未捕获异常/未处理拒绝一律「记日志 + 退出」,由主进程看门狗退避重启,
//      绝不让子进程带伤继续跑(那会表现为推流卡死而不是重启);
//   2. 数据层 bootstrap —— 需要音源解析/换源探测的运行时(如 sendspin)必须有与主进程一致的
//      插件注册 + DB 建表/回填 + 外置插件发现;**纯协议运行时(如 airplay)可跳过**;
//   3. 消息循环 —— 过滤非法消息 + 统一错误日志,业务只写自己的分发;
//   4. process.send 安全包装 —— 非 fork 场景(单测)下 process.send 不存在。
//
// 注意:数据层相关模块是**动态 import** 的 —— 主进程侧 import 本文件不会连带加载 db/plugins,
// 纯协议子进程不调用 bootstrapChildDataLayer() 就不会付出这份加载成本。
import { createLogger } from "../../utils/logger.js";

/** 把 process.send 包成稳定函数(非 fork / 单测环境下 process.send 不存在)。 */
export function createProcessSend<TSend>(): (msg: TSend) => void {
  return (msg: TSend) => {
    if (typeof process.send === "function") process.send(msg);
  };
}

/**
 * 装致命异常兜底:常驻子进程崩溃必须**退出**(而非吞掉),主进程据此退避重启恢复服务。
 * @param logName 日志通道名
 * @param label 日志里对自身的称呼,如 "sendspin 子进程"
 */
export function installChildFatalHandlers(logName: string, label: string): void {
  const log = createLogger(logName);
  process.on("uncaughtException", (e: any) => {
    log.error(`${label}未捕获异常,退出等重启: ${e?.message || e}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (e: any) => {
    log.error(`${label}未处理的 Promise 拒绝,退出等重启: ${(e as Error)?.message || e}`);
    process.exit(1);
  });
}

export interface ChildDataLayerOptions {
  logName: string;
  /** 日志里对自身的称呼,如 "sendspin 子进程"。 */
  label: string;
  /** 外置插件发现用的版本号,默认取 process.env.APP_VERSION。 */
  appVersion?: string;
  /** 额外步骤:数据层就绪后执行(如 sendspin 的 6053 桥预热)。 */
  after?: () => Promise<void> | void;
}

/**
 * 与主进程一致的**数据层** bootstrap(不启 HTTP/WS/调度器/播放器编排):
 * 内置插件注册 → DB 建表 → 类型回填 → 外置插件发现。
 * 音源解析、换源探测、插件配置读取都依赖它;纯推流协议运行时可以完全不调。
 */
export async function bootstrapChildDataLayer(opts: ChildDataLayerOptions): Promise<void> {
  const log = createLogger(opts.logName);
  try {
    const { registerBuiltinPlugins } = await import("../../plugins/builtins.js");
    const { initDatabase, backfillGenres } = await import("../../db/index.js");
    const { discoverExternalPlugins } = await import("../../plugins/discovery.js");
    registerBuiltinPlugins();
    initDatabase();
    backfillGenres();
    await discoverExternalPlugins(opts.appVersion || process.env.APP_VERSION || "dev");
    await opts.after?.();
  } catch (e: any) {
    log.error(`${opts.label} bootstrap 失败`, { err: e?.message || e });
    throw e;
  }
}

/**
 * 装 IPC 消息循环:过滤非对象消息 + 统一错误日志(不吞错,日志里带原文便于排障)。
 * 业务在 onMessage 里只写自己的分发逻辑。
 */
export function installChildMessageLoop<TMsg>(
  logName: string,
  label: string,
  onMessage: (msg: TMsg) => Promise<void> | void,
): void {
  const log = createLogger(logName);
  process.on("message", async (raw) => {
    if (!raw || typeof raw !== "object") return;
    try {
      await onMessage(raw as TMsg);
    } catch (e: any) {
      log.error(`${label}消息处理失败: ${e?.message || e}`);
    }
  });
}

/**
 * 子进程「主动求退」:给消息一拍冲刷时间后 exit(0)。
 * 主进程 side 的 stop 流程仍有 SIGKILL 兜底,所以这里只求体面、不赌成功。
 */
export function exitChildSoon(delayMs = 200): void {
  setTimeout(() => process.exit(0), delayMs);
}
