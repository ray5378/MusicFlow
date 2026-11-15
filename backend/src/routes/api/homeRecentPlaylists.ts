// ==================== 首页「最近更新的歌单」纯计算(GET /v1/home/recent-playlists) ====================
//
// 与「为你推荐」拆成两个端点,各管一件事:
//   recommend-section 有随机位 → 必须存快照才能小时内稳定(homeRecommendSection.ts);
//   recent-playlists 没有随机位 → 纯查询、天然确定、**保持新鲜**,刻意不做快照
//   (冻结反而会让「最近更新」失真)。
//
// 本模块只做**纯计算**:不读库、不写库、不写缓存、不解析 Date。
// 时间字段 `changed` 是 ISO 8601 UTC 定长字符串(生产实测 871 条全部形如
// `2026-11-15T12:36:43.461Z`,无空值/无 offset),所以**直接比字符串**即是时间序;
// 走 `new Date()` 解析只会引入时区 bug 与性能损耗。
//
// 非 music 歌单(kind='study' 等)天然不进:数据源是 buildPlaylistPool,它的
// `WHERE kind='music'` 已经挡住。

/** `?limit` 缺省/非法时的条数。 */
export const RECENT_DEFAULT_LIMIT = 20;

/** `?limit` 上限:防 `?limit=99999` 把 871 条整包吐出去。 */
export const RECENT_MAX_LIMIT = 100;

/** 歌单池最小投影(buildPlaylistPool 的 items 元素,已做可见性过滤)。
 *  与 homeRecommendSection.ts 的 RecommendPoolItem 结构一致 —— 同一个数据源喂两个端点。 */
export interface RecentPoolItem {
  id: string;
  name: string;
  songCount: number;
  changed: string;
}

/** 响应里的一条「最近更新」。coverArt 由服务端算好,客户端不猜派生规则。 */
export interface RecentPlaylistItem {
  id: string;
  name: string;
  songCount: number;
  coverArt: string;
  /** 歌单最后更新时间原文(ISO 8601 UTC)。 */
  changed: string;
}

/**
 * `?limit` 的 clamp:`NaN`→默认 20,其余夹在 [1, 100]。
 *
 * 说明:规格公式写作 `clamp(parseInt(query.limit) || 20, 1, 100)`,但 `|| 20` 会把
 * `?limit=0` 变成 20,而规格第 5 节自检 #14 明确要求 `?limit=0` → 1。两者冲突时以
 * 自检清单为准(0 视为「要 1 条」,不是「没传」),故这里显式区分 NaN 与 0。
 *
 * @param raw URL 上的原始字符串(可能 undefined)
 * @return 实际生效的条数,恒在 [1, 100]
 */
export function clampRecentLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return RECENT_DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), RECENT_MAX_LIMIT);
}

/** 最近更新倒序:changed 降序,并列时 id 升序兜底(保证同一份数据永远同一个顺序)。 */
function compareRecentDesc(a: RecentPoolItem, b: RecentPoolItem): number {
  if (a.changed === b.changed) return a.id.localeCompare(b.id);
  return a.changed < b.changed ? 1 : -1;
}

/**
 * 取「最近更新的歌单」。
 *
 * - 按 `changed`(updated_at 原文)倒序,并列按 id 升序 —— 结果确定,不依赖输入顺序的稳定排序;
 * - **不排除固定卡**(独立分区,与「为你推荐」无关);
 * - 再兜一层 limit(调用方已 clamp,这里防非法值把整池吐出去)。
 *
 * @param pool  可见性过滤后的歌单池
 * @param limit 条数
 */
export function selectRecentPlaylists(pool: RecentPoolItem[], limit: number): RecentPlaylistItem[] {
  const items: RecentPoolItem[] = Array.isArray(pool) ? pool : [];
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 0), items.length) : RECENT_DEFAULT_LIMIT;
  return [...items]
    .sort(compareRecentDesc)
    .slice(0, safeLimit)
    .map((p) => ({
      id: p.id,
      name: p.name,
      songCount: p.songCount,
      coverArt: `pl-${p.id}`,
      changed: p.changed,
    }));
}
