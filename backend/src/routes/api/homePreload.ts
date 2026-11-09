// ==================== 首页数据接口 ====================
// 曾在此提供 GET /v1/home/preload:登录后一次性触发 songs/albums/artists/playlists
// 四个列表的第一页查询做「预热」。实测该接口在服务端**同步串行**执行 4 次列表查询,
// 单次请求阻塞 Node 事件循环 370–490ms,导致首页所有同源请求(封面 / getStarred2 /
// playlist-pool / peers)排队到它之后才返回(2026-11-09 CDP 实测:这些请求齐刷刷在
// 1.2s 同时完成,FCP 1088ms、LCP 4052ms)。预热收益远小于阻塞代价,已整体移除;
// 列表首访由各页面自身的请求完成。
import type { Hono } from "hono";
import { PERM, permMiddleware } from "./shared.js";
import { buildPlaylistPool } from "./playlists.js";

export function registerHomePreload(app: Hono): void {
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
