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
import { noteStreamActivity, percentileOf } from "../services/source/streamProbe.js";

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

// ==================== 首字节时延(TTFB)真实流量采样与 p95 告警(T03 / T21) ====================
// 补的空白:此前只有**上游金丝雀探针**(streamProbe)在量「上游→服务端」一段,且它默认
// 关闭、只在空闲时段跑;真实流量的服务端侧首字节分位一直没有落点。
//   · 出流族(/rest/stream,T03):本中间件测的是「请求进入到响应可发」这段。出流路径
//     的 serveFfmpegPipe 在回话前会**等 ffmpeg 首个输出字节**(启动裁决),故该值即
//     「服务端侧端到端首字节」—— 客户端网络那段服务端量不到,只能到此为止。
//   · 封面族(/rest/getCoverArt,T21):适应度函数为「封面时延 ≤2s」(测量源:服务端指标)。
// 采样点复用既有中间件(不碰出流热路径),样本进环形缓冲;告警按 **p95 状态翻转**
// (在阈值内 → 越线 / 越线 → 回落)打一条,而不是每个慢样本都打 —— 冷缓存下封面
// 排队 1~3s 是既有水位,逐样本告警只会把真信号淹掉(与慢请求分级同一哲学)。
// 样本数不足 TTFB_MIN_SAMPLES 时**不判定**:小样本的 p95 本身就是噪声。

/** 封面首字节告警线(ms),默认取适应度函数上界 2s。 */
export const COVER_TTFB_WARN_MS = envMs("HTTP_COVER_TTFB_WARN_MS", 2000);
/** 出流首字节告警线(ms),默认沿用既有出流慢请求预算(7000)。 */
export const STREAM_TTFB_WARN_MS = envMs("HTTP_STREAM_TTFB_WARN_MS", SLOW_MS_STREAM);
/** TTFB 环形缓冲样本上限(两族各一份,内存有界)。 */
const TTFB_SAMPLES_MAX = envMs("HTTP_TTFB_SAMPLES", 200);
/** 低于该样本数不做 p95 判定(小样本分位不可信)。 */
const TTFB_MIN_SAMPLES = envMs("HTTP_TTFB_MIN_SAMPLES", 20);

interface TtfbTap {
  samples: number[];
  /** 上一次 p95 判定是否越线(状态翻转告警用)。 */
  over: boolean;
}

const coverTtfb: TtfbTap = { samples: [], over: false };
const streamTtfb: TtfbTap = { samples: [], over: false };

export interface TtfbSnapshot {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  warnMs: number;
  /** p95 当前是否越线(样本不足时沿用上一次判定)。 */
  over: boolean;
}

/** 采样 + 评估告警线(只在状态翻转时打日志)。 */
function noteTtfb(tap: TtfbTap, ms: number, warnMs: number, label: string): void {
  tap.samples.push(ms);
  while (tap.samples.length > TTFB_SAMPLES_MAX) tap.samples.shift();
  if (tap.samples.length < TTFB_MIN_SAMPLES) return;
  const p95 = percentileOf(tap.samples, 95);
  if (p95 === null) return;
  const over = p95 > warnMs;
  if (over && !tap.over) {
    log.warn(`${label}首字节 p95 越告警线`, { p95Ms: p95, warnMs, samples: tap.samples.length });
  } else if (!over && tap.over) {
    log.info(`${label}首字节 p95 回落至告警线内`, { p95Ms: p95, warnMs, samples: tap.samples.length });
  }
  tap.over = over;
}

/** 只给「真产出了媒体字节的成功响应」计时。
 *  排除三类非首字节样本:Subsonic failed 信封(HTTP 200 + application/json)、
 *  304 未改(无渲染)、499/中止。否则 ffmpeg 首字节失败(最长等 15s 才回错)与
 *  各种错误信封会把 p95 顶起来,制造与在线播放无关的误告警。 */
function isMediaResponse(res: Response): boolean {
  if (res.status !== 200) return false;
  const ct = res.headers.get("content-type") || "";
  return ct.length > 0 && !ct.includes("json");
}

/** 切片一份快照(供 GET /v1/admin/metrics 展示;含内部样本时不返回数组本体)。 */
function ttfbSnapshot(tap: TtfbTap, warnMs: number): TtfbSnapshot {
  const v = tap.samples;
  return {
    samples: v.length,
    p50Ms: percentileOf(v, 50),
    p95Ms: percentileOf(v, 95),
    maxMs: v.length ? Math.max(...v) : null,
    warnMs,
    over: tap.over,
  };
}

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

/** 封面族请求判定(**路由模板级**)。模板要等 next() 跑完才定型,故只能在此处判、
 *  用于 TTFB 采样;出流族另有入口级的 isStreamRequest(见上)。 */
function isCoverRoute(route: string): boolean {
  return route.includes("/getCoverArt");
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
  /** 真实流量首字节时延分位(T03 出流 / T21 封面)。 */
  ttfb: { cover: TtfbSnapshot; stream: TtfbSnapshot };
}

/** 慢请求 + 端点计数中间件。在 index.ts 挂 app.use("*")。 */
export const metricsMiddleware = createMiddleware(async (c, next) => {
  const start = Date.now();
  // 出流族请求 = 用户正在起播/切歌:进请求就登记给探针避让闸(让它安静 QUIET_MS)。
  // 必须用 URL 路径判(路由模板此刻还没定型),且不能动下方计数用的 route。
  const streamReq = isStreamRequest(c.req.url);
  if (streamReq) noteStreamActivity();
  await next();
  const ms = Date.now() - start;
  total++;
  const route = c.req.routePath || new URL(c.req.url).pathname; // 路由模板,防动态路径无界
  const key = `${c.req.method} ${route}`;
  counter.set(key, (counter.get(key) || 0) + 1);
  // T03/T21:把真实流量的首字节时延采下来(出流用入口级标志,封面用路由模板);
  // 仅计「真产出媒体字节」的 200 —— 失败信封/304/中止不算首字节时延。
  const media = isMediaResponse(c.res);
  if (streamReq && media) noteTtfb(streamTtfb, ms, STREAM_TTFB_WARN_MS, "出流");
  if (isCoverRoute(route) && media) noteTtfb(coverTtfb, ms, COVER_TTFB_WARN_MS, "封面");
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
  return {
    total,
    slowCount,
    byEndpoint,
    ttfb: {
      cover: ttfbSnapshot(coverTtfb, COVER_TTFB_WARN_MS),
      stream: ttfbSnapshot(streamTtfb, STREAM_TTFB_WARN_MS),
    },
  };
}
