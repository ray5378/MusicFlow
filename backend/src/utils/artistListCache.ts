// 艺术家列表页进程内缓存。
//
// /v1/artists 需要对全量艺术家做 JS localeCompare 排序(保留中文排序),
// 而无限滚动的每一块(60 条)都会触发一次完整取数+排序:17k 行实测每块 ~90ms,
// 是艺术家页滚动预取延迟的主因。本缓存按 query 保存「排好序的完整结果」,
// 滚动期间多块请求直接复用,单次排序成本摊到整个浏览会话;
// 任何艺术家写入(scanner 扫描 / 在线匹配落地 / 刮削更新)后调 invalidateArtistList()
// 使缓存失效,下一块请求重建。
//
// 无任何 import → 路由与各写库服务均可安全引用,不引入模块环。

const artistListCache = new Map<string, unknown[]>();

/** 读缓存:命中返回排好序的完整数组,未命中返回 null。 */
export function getArtistList(query: string): unknown[] | null {
  return artistListCache.get(query) ?? null;
}

/** 写缓存:query 为空串(全量列表)时同时覆盖所有搜索查询的“基础”缓存。 */
export function setArtistList<T>(query: string, sorted: T[]): void {
  artistListCache.set(query, sorted as unknown[]);
  if (!query) {
    // 全量列表重建后,搜索子集无法直接复用(名字相同但数量不同),只清空,下次按需重建。
    for (const k of artistListCache.keys()) if (k) artistListCache.delete(k);
  }
}

/** 任何艺术家增删改后调用:丢弃全部艺术家列表缓存。 */
export function invalidateArtistList(): void {
  artistListCache.clear();
}