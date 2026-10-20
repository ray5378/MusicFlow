// ==================== 首页预热聚合接口(优化 #3) ====================
// 背景:前端首页启动时会并发发起 4 个「预热」请求(响应体被前端丢弃,只为在服务端
// 触发一遍列表查询):
//   GET /v1/songs?page=1&pageSize=25、/v1/albums?page=1&pageSize=20、
//   /v1/artists?page=1&pageSize=20、/v1/playlists?page=1&pageSize=20。
// 在 HTTP/1.1 每域名 6 连接下,这 4 个请求会与首页其余请求互相排队,拖慢首屏。
// 现合并为一个 GET /v1/home/preload:服务端一次性触发上述四个列表的第一页查询,
// 让相关缓存(如艺术家列表进程内缓存)与 SQLite 语句/页缓存就绪。
//
// 响应体保持最小:前端本就丢弃这 4 个响应,回传四份列表数据纯属浪费带宽与序列化开销,
// 故只回一个最小 ack({ success: true })。
//
// 复用而非重写:四个列表的实现已从 library.ts / playlists.ts 抽出为 buildXxxPage
// 纯函数,此处直接调用同一份实现(含 SQL),不复制也不重写查询。
import type { Hono } from "hono";
import { PERM, permMiddleware } from "./shared.js";
import { buildSongsPage, buildAlbumsPage, buildArtistsPage } from "./library.js";
import { buildPlaylistsPage, buildPlaylistPool } from "./playlists.js";

export function registerHomePreload(app: Hono): void {
  // 权限与各列表接口一致:歌曲/专辑/艺术家用 LIBRARY_BROWSE,歌单用 PLAYLIST_VIEW。
  // 两道门禁都挂 —— 保证未登录/无权的调用方无法进入(不会出现「无鉴权可访问」)。
  app.use("/v1/home/preload", permMiddleware(PERM.LIBRARY_BROWSE));
  app.use("/v1/home/preload", permMiddleware(PERM.PLAYLIST_VIEW));

  app.get("/v1/home/preload", (c) => {
    const user = c.get("user");
    // 与前端原 4 个预热请求完全同参,逐个触发(查询为进程内同步 SQL,无需并行)。
    // 单个列表触发失败不影响其它列表与 ack(预热是 best-effort,失败仅告警)。
    const tasks: Array<[string, () => unknown]> = [
      ["songs", () => buildSongsPage({ page: "1", pageSize: "25" })],
      ["albums", () => buildAlbumsPage({ page: "1", pageSize: "20" }, user?.id)],
      ["artists", () => buildArtistsPage({ page: "1", pageSize: "20" }, user?.id)],
      ["playlists", () => buildPlaylistsPage({ page: "1", pageSize: "20" }, user)],
    ];
    for (const [label, run] of tasks) {
      try {
        run();
      } catch (e: any) {
        console.warn(`[HOME-PRELOAD] ${label} 预热失败:`, e?.message || e);
      }
    }
    return c.json({ success: true });
  });

  // 首页「并排随机」用的全量歌单池(最小投影,2026-10-20)。
  // 权限与 /v1/playlists 一致(PLAYLIST_VIEW);一次返回全量 id+name+songCount,
  // 首页不再 pageSize=200 分页(生产 873 个歌单,分页会把随机池截到最新约 200 个)。
  // 封面由前端按 pl-<id> 派生懒加载,故响应体刻意不带 coverArt(省带宽/序列化)。
  app.use("/v1/home/playlist-pool", permMiddleware(PERM.PLAYLIST_VIEW));
  app.get("/v1/home/playlist-pool", (c) => {
    const user = c.get("user");
    // ?refresh=1 跳过索引 TTL 缓存强制重建:首页「重新生成漫游」后需要立刻看到新歌单,
    // 否则新建的歌单最迟要等 TTL(60s)过期才进并排随机池(旧实现直查 DB,无此延迟)。
    const force = c.req.query("refresh") === "1";
    const { total, items } = buildPlaylistPool(user, { force });
    return c.json({ success: true, total, items });
  });
}
