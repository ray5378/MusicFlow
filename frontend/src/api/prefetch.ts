import api from "@/api";

/**
 * 启动期预取(2026-11-09 首页提速)。
 *
 * 首屏卡片要等 Home 组件 mount 之后才发 /recommend/home-cards 等请求 —— 实测这个时刻
 * 在 304~584ms,而应用启动(路由/布局/Element Plus 初始化)本身就要 140ms+。这段时间
 * 接口完全空闲,数据请求纯排在「等自己的 JS」后面。这里在 bootstrap 一开始就把首屏
 * 必需的 3 个 GET 发出去,让网络与应用启动并行;组件侧用 dedupGet 取同一条 promise,
 * 不重复打接口。
 */
const HOME_CARDS_URL = "/rest/api/v1/recommend/home-cards";

const HOME_PREFETCH_URLS = [
  HOME_CARDS_URL,
  "/rest/api/v1/home/playlist-pool",
  "/rest/api/v1/favorites/ids",
];

const inflight = new Map<string, Promise<any>>();

/** 提前发出首屏 GET。未登录时不要调用(只会拿到 401)。 */
export function prefetchHomeData(): void {
  for (const url of HOME_PREFETCH_URLS) {
    if (inflight.has(url)) continue;
    const p = api.get(url);
    // 预取结果可能没人消费(用户直接落在别的路由):挂一个空 catch,避免
    // unhandledrejection。调用方取用时拿到的仍是原始 promise,自行走降级逻辑。
    p.catch(() => {});
    if (url === HOME_CARDS_URL) p.then(preloadCardCovers).catch(() => {});
    inflight.set(url, p);
    // 兜底清理:10s 内没人取用就释放(响应体几十 KB 级)。
    setTimeout(() => {
      if (inflight.get(url) === p) inflight.delete(url);
    }, 10_000);
  }
}

/** 取预取结果(一次性):命中则复用同一条请求,否则新发一条。 */
export function dedupGet(url: string): Promise<any> {
  const p = inflight.get(url);
  if (p) {
    inflight.delete(url);
    return p;
  }
  return api.get(url);
}

/**
 * 首屏卡片封面预加载(2026-11-09 首页提速)。
 *
 * 卡片封面 URL 要等 home-cards 响应才知道,而 <img> 要等组件渲染才发出请求;
 * 在响应到达的这一刻先把前 3 张的封面发出去,让图片下载与 Vue 渲染并行。
 *
 * 这里**不写死固定歌单 id**(check-fixed-playlist-ids.mjs 的契约:核心代码不得出现
 * pl-daily-* 字面量),而是从响应里取。调用前必须已有登录态 —— 封面端点受鉴权保护,
 * 无凭据会拿到 401,而 <img> 会复用这条失败响应变成空图。
 */
function preloadCardCovers(res: any): void {
  const cards = res?.data?.cards;
  if (!Array.isArray(cards)) return;
  cards.slice(0, 3).forEach((card: any, i: number) => {
    const id = card?.coverArt;
    if (!id) return;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = `/rest/getCoverArt?id=${encodeURIComponent(id)}&size=150`;
    if (i === 0) link.setAttribute("fetchpriority", "high");
    document.head.appendChild(link);
  });
}
