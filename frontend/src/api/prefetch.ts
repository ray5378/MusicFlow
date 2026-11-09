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
const HOME_PREFETCH_URLS = [
  "/rest/api/v1/recommend/home-cards",
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
