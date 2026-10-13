// ==================== 请求级 metrics 中间件 ====================
//
// 用途:
//   - 慢请求告警:耗时 ≥ 该请求的**路由预算**时打 warn 日志(含 method/路由模板/耗时/
//     预算/调用方),让「哪个端点慢、慢了多少、谁在打」一眼可查。
//   - 端点调用计数:按「Method + 路由模板」统计,供 GET /v1/admin/metrics 查看。
//
// 内存边界:计数 key = 路由模板(有界,456 端点),不是真实 URL——动态路径
// (如 /v1/sources/:id/scan)不会让 Map 无限增长。符合 SPEC 内存红线。
//
// 阈值分级(2026-10-12 起):此前全局硬编码 1000ms,把两类**设计本就如此**的请求
// 长期刷成告警噪音,真问题被淹没:
//   · `/rest/getCoverArt` —— 冷缓存时一屏封面并发渲染,单张排队 1~3s 是正常水位;
//   · `/rest/stream` 族   —— 出流 TTFB 设计上含最长 6s 的有界首字节等待
//     (STREAM_BUFFER_HEAD_WAIT_MS),超时才"直通优先"返回,几千 ms 返回属正常。
// 因此按路由给不同预算,默认值全部 env 可覆盖(运维调参不必改代码):
//   HTTP_SLOW_MS(全局,默认 1000)/ HTTP_SLOW_MS_COVER(默认 5000)/
//   HTTP_SLOW_MS_STREAM(默认 7000)。
// 纪律:未列出的路由一律用全局默认 —— 分级是"豁免已知的慢",不是"抬高全局底线"。
import { createMiddleware } from "hono/factory";
import { createLogger } from "../utils/logger.js";
import { noteStreamActivity } from "../services/source/streamProbe.js";

const log = createLogger("HTTP");

/** 读一个正整数毫秒型 env,非法/缺失时回落默认值(0 与负值视为非法,避免静默关掉告警)。 */
function envMs(name: string, def: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** 全局默认预算(ms):未进覆盖表的路由都用它。 */
export const SLOW_MS = envMs("HTTP_SLOW_MS", 1000);
/** 封面渲染预算(ms):冷缓存并发渲染是常态,按 1s 告警纯属噪音。 */
export const SLOW_MS_COVER = envMs("HTTP_SLOW_MS_COVER", 5000);
/** 音频出流预算(ms):必须大于出流侧的有界首字节等待(默认 6s),否则每次超时都告警。 */
export const SLOW_MS_STREAM = envMs("HTTP_SLOW_MS_STREAM", 7000);

/**
 * 路由 → 预算覆盖表。key 与调用计数的 key 同一命名空间("METHOD 路由模板")。
 * `.view`(OpenSubsonic 兼容别名)与 POST 变体由 routes/rest 的兼容注册器一并挂载,
 * 是**同一条链路的同一入口**,预算必须同步,否则换个写法就漏告警或乱告警。
 */
const SLOW_MS_BY_ROUTE: Record<string, number> = {
  "GET /rest/getCoverArt": SLOW_MS_COVER,
  "GET /rest/getCoverArt.view": SLOW_MS_COVER,
  "POST /rest/getCoverArt": SLOW_MS_COVER,
  "POST /rest/getCoverArt.view": SLOW_MS_COVER,
  "GET /rest/stream": SLOW_MS_STREAM,
  "GET /rest/stream.view": SLOW_MS_STREAM,
  "POST /rest/stream": SLOW_MS_STREAM,
  "POST /rest/stream.view": SLOW_MS_STREAM,
  "GET /rest/dlna/stream/:token": SLOW_MS_STREAM,
};

/**
 * 出流族请求判定(**URL 路径级**,中间件入口即判,不等路由模板):
 * 起播/切歌的真正入口一被调用,金丝雀探针就安静 QUIET_MS(默认 60s,让开起播/切歌
 * 这段最敏感的上行窗口)。窗口按「最近一次出流请求进入时刻」算,故长于 60s 的曲目
 * 在播放中仍可能被探一次(单次代价 ≤ 一个 chunk),此处只保证「起播前后不抢」。
 * 封面渲染不算——它不是「播放活动」。
 * 为什么不能像慢请求预算那样用 routePath 模板:模板要等 next() 跑完路由才定型,
 * 而避让登记必须在请求**进入时**就生效(出流请求会挂住整个播放时长)。
 */
export function isStreamRequest(url: string): boolean {
  const p = new URL(url).pathname;
  if (p === "/rest/stream" || p === "/rest/stream.view") return true;
  if (p.startsWith("/rest/dlna/stream/")) return true;
  return false;
}

/** 该请求适用的慢请求预算(ms)。未列出的路由回落全局默认 SLOW_MS。 */
export function slowThresholdMs(method: string, route: string): number {
  return SLOW_MS_BY_ROUTE[`${method} ${route}`] ?? SLOW_MS;
}

/**
 * 由请求头推导慢请求的调用方标识(纯函数,便于单测):
 * x-mf-client-id(客户端/网页端自报的实例 ID)优先,回落 UA 片段,都没有给 "-"。
 * 封面 <img> 带不了自定义头,只有 UA —— 但仍能区分浏览器 / Flutter 客户端 / HA 集成,
 * 足够把"谁在制造封面突发"钉到具体一类设备上。
 */
export function clientTag(
  clientId: string | undefined,
  userAgent: string | undefined,
): string {
  if (clientId) return clientId.slice(0, 40);
  if (userAgent) return `ua:${userAgent.slice(0, 40)}`;
  return "-";
}

const counter = new Map<string, number>(); // "METHOD routeTemplate" -> count
let total = 0;
let slowCount = 0;

export interface RequestMetrics {
  total: number;
  /** 超过**各自路由预算**的请求数(不是"超过 1s"的请求数)。 */
  slowCount: number;
  /** 端点调用计数(Method + 路由模板)。 */
  byEndpoint: Record<string, number>;
}

/** 慢请求 + 端点计数中间件。在 index.ts 挂 app.use("*")。 */
export const metricsMiddleware = createMiddleware(async (c, next) => {
  const start = Date.now();
  // 出流族请求 = 用户正在起播/切歌:进请求就登记给探针避让闸(让它安静 QUIET_MS)。
  // 必须用 URL 路径判(路由模板此刻还没定型),且不能动下方计数用的 route。
  if (isStreamRequest(c.req.url)) noteStreamActivity();
  await next();
  const ms = Date.now() - start;
  total++;
  const route = c.req.routePath || new URL(c.req.url).pathname; // 路由模板,防动态路径无界
  const key = `${c.req.method} ${route}`;
  counter.set(key, (counter.get(key) || 0) + 1);
  const budget = slowThresholdMs(c.req.method, route);
  if (ms >= budget) {
    slowCount++;
    log.warn("慢请求", {
      method: c.req.method,
      route,
      ms,
      budget,
      client: clientTag(c.req.header("x-mf-client-id"), c.req.header("user-agent")),
    });
  }
});

/** 请求指标快照(供 GET /v1/admin/metrics)。 */
export function getRequestMetrics(): RequestMetrics {
  const byEndpoint: Record<string, number> = {};
  for (const [k, v] of counter) byEndpoint[k] = v;
  return { total, slowCount, byEndpoint };
}
