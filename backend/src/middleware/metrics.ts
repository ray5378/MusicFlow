// ==================== 请求级 metrics 中间件 ====================
//
// 用途:
//   - 慢请求告警:耗时 ≥ SLOW_MS(1s) 打 warn 日志(含 method/路由模板/耗时),
//     让「哪个端点慢」可被发现,而不必翻遍所有日志。
//   - 端点调用计数:按「Method + 路由模板」统计,供 GET /v1/admin/metrics 查看。
//
// 内存边界:计数 key = 路由模板(有界,456 端点),不是真实 URL——动态路径
// (如 /v1/sources/:id/scan)不会让 Map 无限增长。符合 SPEC 内存红线。
import { createMiddleware } from "hono/factory";
import { createLogger } from "../utils/logger.js";

const log = createLogger("HTTP");

const SLOW_MS = 1000;
const counter = new Map<string, number>(); // "METHOD routeTemplate" -> count
let total = 0;
let slowCount = 0;

export interface RequestMetrics {
  total: number;
  slowCount: number;
  /** 端点调用计数(Method + 路由模板)。 */
  byEndpoint: Record<string, number>;
}

/** 慢请求 + 端点计数中间件。在 index.ts 挂 app.use("*")。 */
export const metricsMiddleware = createMiddleware(async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  total++;
  const route = c.req.routePath || new URL(c.req.url).pathname; // 路由模板,防动态路径无界
  const key = `${c.req.method} ${route}`;
  counter.set(key, (counter.get(key) || 0) + 1);
  if (ms >= SLOW_MS) {
    slowCount++;
    log.warn("慢请求", { method: c.req.method, route, ms });
  }
});

/** 请求指标快照(供 GET /v1/admin/metrics)。 */
export function getRequestMetrics(): RequestMetrics {
  const byEndpoint: Record<string, number> = {};
  for (const [k, v] of counter) byEndpoint[k] = v;
  return { total, slowCount, byEndpoint };
}
