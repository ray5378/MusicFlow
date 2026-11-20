/** 服务端自我重启的触发闸（2026-11-20）。
 *
 *  为什么需要：热补丁换掉 `dist` 之后，Node 的模块缓存只有"换进程"才能清掉 ——
 *  以往只能 SSH 进机器执行 `docker restart`。这里把既有的 `gracefulShutdown`
 *  （停 mDNS → 各端发 TEARDOWN → `retainActiveQueues` 保住"正在播" → 关端口 → exit）
 *  暴露成一个受控入口，由容器 `restart=always` 把进程重新拉起。
 *
 *  240 实测：容器启动 → listening 用 2.2s；起来后约 10s 自动续播同一首
 *  （`playCurrent source=resume-active`）。所以"热"指的是**不重启容器、不动数据卷、
 *  不用 SSH**，而不是热加载模块。
 *
 *  刻意不做：① 热加载（Node 做不到）；② 启动失败自动回滚（这是常规运维重启，
 *  不是滚动升级；坏代码要靠人工回滚 dist）。
 */
import { createLogger } from "../../utils/logger.js";

const log = createLogger("system-restart");

type RestartHandler = (reason: string) => void | Promise<void>;

let handler: RestartHandler | null = null;
let requestedAt = 0;

/** 由 index.ts 在启动时注入（它持有 gracefulShutdown 与退出时序）。
 *  传 null = 撤销能力（同时清冷却，便于测试与热替换场景）。 */
export function setRestartHandler(fn: RestartHandler | null): void {
  handler = fn;
  if (fn === null) requestedAt = 0;
}

/** 是否已注册（路由探测用：未注册时不该假装能重启）。 */
export function isRestartAvailable(): boolean {
  return handler !== null;
}

/**
 * 受理一次重启请求。
 * @returns true = 已受理并排定退出；false = 进程内没有重启能力（例如被当作库引入）。
 */
export function requestRestart(reason: string): boolean {
  if (!handler) {
    log.warn(`重启请求被拒（未注册重启处理）: ${reason}`);
    return false;
  }
  // 冷却 5s：前端连点/重试不能把 exit 排成多次，否则会连续经历两轮启动。
  const now = Date.now();
  if (requestedAt !== 0 && now - requestedAt < 5_000) {
    log.warn(`重启已在进行中（${now - requestedAt}ms 前受理），忽略本次: ${reason}`);
    return true;
  }
  requestedAt = now;
  log.info(`受理重启请求: ${reason}`);
  // 先让 HTTP 响应飞回去，再进入 gracefulShutdown（它内部还会等 800ms 才 exit）。
  setTimeout(() => {
    Promise.resolve(handler?.(reason)).catch((e) => {
      log.error(`重启处理器失败，进程仍在运行: ${(e as Error)?.message || e}`);
    });
  }, 500);
  return true;
}
