// 自动生成 —— 由 index.ts 物理拆分而来（playlists 域，14 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  NATIVE_APP,
  PERM,
  RANDOM_PLAYLIST_ID,
  albums,
  and,
  apiError,
  apiErrorStatus,
  asc,
  attachGroupSources,
  clearLibraryIndex,
  clearPlaylistCoverCache,
  count,
  dailyRecommendTag,
  db,
  desc,
  eq,
  inArray,
  isDailyRecommendPlaylist,
  isFixedRecommendPlaylist,
  isImportedPlaylist,
  isNotNull,
  isNull,
  isPluginSyncPlaylist,
  like,
  log,
  maybeRefreshRandomSongs,
  or,
  parsePlaylistFile,
  permMiddleware,
  playlistFavorites,
  playlistSongs,
  playlists,
  resolveSongCover,
  runBatchJob,
  runPlaylistAutoMatch,
  serializeSongRow,
  songs,
  sql,
  startAsyncTask,
  syncApi,
  touch,
} from "./shared.js";

// ==================== 歌单列表查询的可复用实现(优化 #3) ====================
// 首页预热聚合接口(GET /v1/home/preload)要在服务端内部重新触发 /v1/playlists 的
// 第一页查询,让相关缓存就绪。抽出为「入参即原始 query 字符串 + 当前用户」的纯函数,
// 路由与预热器共用同一份实现 —— 不复制 SQL,也不重写过滤/排序逻辑。
export function buildPlaylistsPage(qp: {
  page?: string; pageSize?: string; query?: string; platform?: string;
  local?: string; favorite?: string; sort?: string;
}, user: { id?: string; isAdmin?: boolean } | undefined): { total: number; page: number; pageSize: number; items: any[] } {
  const page = Math.max(1, parseInt(qp.page || "1") || 1);
  // 单页上限 500:歌单选择器场景要一次性拿到全量(前端循环分页),100 太紧
  // (实测 761 个歌单时选择器只能看到前 100 个)。查询本身是 SQL LIMIT/OFFSET
  // + COUNT,放宽上限不增加额外开销。
  const pageSize = Math.min(500, Math.max(1, parseInt(qp.pageSize || "20") || 20));
  const query = (qp.query || "").trim();
  const platform = (qp.platform || "").trim();
  const localOnly = (qp.local || "").trim() === "1";
  const favOnly = (qp.favorite || "").trim() === "1";
  const sort = (qp.sort || "").trim();
  // 当前用户已收藏的歌单 id 集合:收藏过滤与每项 favorite 状态都按它判断。
  const favIds = new Set(db.select({ pid: playlistFavorites.playlistId })
    .from(playlistFavorites).where(eq(playlistFavorites.userId, user?.id ?? ""))
    .all().map(r => r.pid));
  // Push the ownership/visibility filter + name search + platform/local/favorite
  // filters to SQL. and() skips undefined conditions, so any subset works.
  // 音乐库对所有用户开放:任何登录用户都能看到「自己 + 公开 + 导入/插件歌单
  // (sourceUrl 非空,如 go-music-dl 等导入的曲库内容)」;私人普通歌单仍仅属主可见。
  const where = and(
    user?.isAdmin
      ? undefined
      : or(
          eq(playlists.ownerId, user?.id ?? ""),
          eq(playlists.isPublic, 1),
          isNotNull(playlists.sourceUrl),
        ),
    query ? like(playlists.name, `%${query}%`) : undefined,
    platform ? eq(playlists.sourcePlatform, platform) : undefined,
    localOnly ? isNull(playlists.sourceUrl) : undefined,
    // 收藏过滤改为按当前用户:只显示「我收藏的」歌单(不再是全局 favorite 标记)。
    favOnly ? inArray(playlists.id, [...favIds]) : undefined,
  );
  // Ordering. An explicit sort (by creation time / name) fully overrides the
  // default daily-recommend-first + recency ranking; unknown values fall back
  // to that default. Pushed to SQL with LIMIT/OFFSET so we never load the
  // whole table into JS just to slice it.
  let orderByExpr: any;
  switch (sort) {
    case "created_asc":  orderByExpr = [asc(playlists.createdAt)]; break;
    case "created_desc": orderByExpr = [desc(playlists.createdAt)]; break;
    case "name_asc":     orderByExpr = [asc(playlists.name)]; break;
    case "name_desc":    orderByExpr = [desc(playlists.name)]; break;
    default: {
      const dailyOrder = sql`CASE WHEN ${playlists.comment} LIKE ${`%${dailyRecommendTag() || "每日推荐"}%`} AND ${playlists.name} = ${dailyRecommendTag() || "每日推荐"} THEN 0 ELSE 1 END`;
      const recency = sql`COALESCE(${playlists.updatedAt}, ${playlists.createdAt})`;
      orderByExpr = [dailyOrder, desc(recency)];
    }
  }
  const rows = (where
    ? db.select().from(playlists).where(where)
    : db.select().from(playlists))
    .orderBy(...orderByExpr)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  const total = (where
    ? db.select({ c: count() }).from(playlists).where(where)
    : db.select({ c: count() }).from(playlists))
    .get()?.c ?? 0;
  const items = rows.map(p => ({
    id: p.id, name: p.name, owner: p.ownerId, public: !!p.isPublic,
    songCount: p.songCount || 0, duration: p.duration || 0,
    // Always expose a cover ref; getCoverArt falls back to a 4-grid collage for self-built playlists
    coverArt: `pl-${p.id}`, sourcePlatform: p.sourcePlatform || "",
    isImported: isImportedPlaylist(p), pluginSynced: isPluginSyncPlaylist(p), sourcePluginId: p.sourcePlugin || "", syncEnabled: !!p.syncEnabled,
    // favorite 改为「当前用户是否收藏」(按 playlist_favorites 判断),不再用全局标记。
    favorite: favIds.has(p.id),
    isDaily: isDailyRecommendPlaylist(p),
    created: p.createdAt, changed: p.updatedAt,
  }));
  return { total, page, pageSize, items };
}

// ==================== 常驻歌单索引(首页并排随机池,2026-10-20) ====================
// 背景:首页「并排随机」需要从全部歌单里随机抽。此前前端调 /v1/playlists?pageSize=200
// 拉「全量」——而服务端单页上限 500、生产库已有 873 个歌单,于是随机池实际只覆盖
// 最新约 200 个,其余 673 个永不出现(真实缺陷)。改由本模块常驻一份「最瘦索引」:
// 每条只留 id + name + songCount(封面由 id 派生 pl-<id>,交给客户端懒加载),
// 一次返回全量池,前端不再分页、不再截断。
//
// 常驻策略:进程内缓存 + 短 TTL 懒刷新,**不挂歌单变更钩子**——歌单增删后最迟 TTL 内
// 生效,首页随机池对「迟到几十秒」不敏感,省掉每条歌单写路径都来通知索引的复杂度。
// 启动后预热一轮,让首个首页请求不必自己付全表扫描的钱(实测 873 行投影 5 列 <2ms)。
//
// 可见性:索引额外存 owner/pub 两列(**不进响应体**),读出时按与 buildPlaylistsPage
// 相同的口径过滤——管理员全见;普通用户仅见「自己 + 公开 + 导入(sourceUrl 非空)」,
// 否则会向普通用户泄漏他人私密歌单。
export const PLAYLIST_POOL_TTL_MS = 60 * 1000;
/** 启动后多久做第一次索引预热(与 recommend 预热器同档,避开启动瞬间的资源争用)。 */
export const PLAYLIST_POOL_WARMER_INITIAL_MS = 4 * 1000;

type PlaylistPoolEntry = {
  id: string;
  name: string;
  songCount: number;
  owner: string;
  pub: boolean;
};

let playlistPoolCache: { ts: number; entries: PlaylistPoolEntry[] } | null = null;
let playlistPoolTimer: ReturnType<typeof setTimeout> | null = null;

/** 读常驻索引(超过 TTL 则同步重建)。单次全表 SELECT 只投影 6 列,重建成本远低于
 *  一次 HTTP 往返,故不为它引入后台刷新/单飞那套复杂度。
 *  force=true 时跳过 TTL 缓存强制重建(供「重新生成漫游」这类显式刷新拿到最新歌单)。 */
function readPlaylistPoolEntries(force = false): PlaylistPoolEntry[] {
  if (!force && playlistPoolCache && Date.now() - playlistPoolCache.ts < PLAYLIST_POOL_TTL_MS) {
    return playlistPoolCache.entries;
  }
  const rows = db
    .select({
      id: playlists.id,
      name: playlists.name,
      songCount: playlists.songCount,
      owner: playlists.ownerId,
      isPublic: playlists.isPublic,
      sourceUrl: playlists.sourceUrl,
    })
    .from(playlists)
    .all();
  const entries = rows.map((r) => ({
    id: r.id,
    name: r.name,
    songCount: r.songCount || 0,
    owner: r.owner || "",
    // pub 的口径必须与 buildPlaylistsPage 的 SQL 逐字对齐(`eq(isPublic, 1)` + `isNotNull(sourceUrl)`):
    // 放宽成 `!!r.isPublic`(非 0 即真)一旦 isPublic 出现非 0/1 的脏值,就会向普通用户多放歌单。
    pub: r.isPublic === 1 || r.sourceUrl != null,
  }));
  playlistPoolCache = { ts: Date.now(), entries };
  return entries;
}

/** 按当前用户可见性过滤后返回全量最小投影池({id,name,songCount})——供首页一次性拿到全量。
 *  opts.force=true 跳过索引 TTL 缓存强制重建(见 readPlaylistPoolEntries)。 */
export function buildPlaylistPool(
  user: { id?: string; isAdmin?: boolean } | undefined,
  opts?: { force?: boolean },
): { total: number; items: { id: string; name: string; songCount: number }[] } {
  const all = readPlaylistPoolEntries(opts?.force === true);
  const visible = user?.isAdmin
    ? all
    : all.filter((e) => e.owner === (user?.id ?? "") || e.pub);
  const items = visible.map((e) => ({ id: e.id, name: e.name, songCount: e.songCount }));
  return { total: items.length, items };
}

/** 预热一轮索引(供启动预热器与单测复用)。 */
export function warmPlaylistPoolOnce(): void {
  readPlaylistPoolEntries();
}

/** 测试钩子:清空索引缓存与定时器,让各用例互不干扰地覆盖 TTL 懒刷新口径。 */
export function __resetPlaylistPoolForTest(): void {
  playlistPoolCache = null;
  if (playlistPoolTimer) {
    clearTimeout(playlistPoolTimer as any);
    playlistPoolTimer = null;
  }
}

// 启动预热:只在启动后预热一轮(单发定时器 + unref,不阻进程退出),**不做周期 re-arm**——
// 索引重建实测 <2ms(873 行只投影 6 列),过期后的首个首页请求自付这点成本即可;常驻周期
// 定时器既无收益,又会在每个 import 本模块的测试进程里留下永远待触发的定时器(噪声)。
export function startPlaylistPoolWarmer(): void {
  if (playlistPoolTimer) return;
  playlistPoolTimer = setTimeout(() => {
    playlistPoolTimer = null; // 单发:触发后清句柄,便于测试钩子与幂等判断。
    try {
      warmPlaylistPoolOnce();
    } catch (e: any) {
      console.warn("[PLAYLIST-POOL] 索引预热失败:", e?.message || e);
    }
  }, PLAYLIST_POOL_WARMER_INITIAL_MS);
  playlistPoolTimer?.unref?.();
}

startPlaylistPoolWarmer();

export function registerPlaylists(app: Hono): void {
app.use("/v1/playlist-search", permMiddleware(PERM.LIBRARY_SEARCH));

app.post("/v1/playlists/import", permMiddleware(PERM.PLAYLIST_IMPORT), async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const url = (body.url || "").trim();
  const native = body.native; // MusicFlow-exported JSON (object) for native files
  if (!url && !native) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.playlist.linkOrFileRequired"), apiErrorStatus(BusinessErrorCode.INVALID_PARAM));
  if (native) {
      // Uploaded playlist file — routed to whichever enabled importer plugin
      // recognizes the payload (built-in: MusicFlow export, one or many playlists).
      const nativeList = parsePlaylistFile(native);
      const created: { id: string; name: string }[] = [];
      const totals = { total: 0, matched: 0, unmatched: 0, wishAdded: 0 };
      for (let i = 0; i < nativeList.length; i++) {
        const imp = nativeList[i];
        const name = imp.name.trim() || "导入歌单";
        const id = `pl-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
        db.insert(playlists).values({
          id, name, ownerId: user?.id || "",
          sourceUrl: null, sourcePlatform: imp.platform, externalId: null,
          syncEnabled: 0,
        }).run();
        if (!syncApi()) return c.json(apiError(BusinessErrorCode.UNAVAILABLE, "errors.playlist.syncNotEnabled"), apiErrorStatus(BusinessErrorCode.UNAVAILABLE));
        const result = await syncApi().rebuildPlaylistEntries(id, imp, {
          userId: user?.id,
          notes: `从本地歌单文件导入「${name}」`,
        });
        totals.total += result.total;
        totals.matched += result.matched;
        totals.unmatched += result.unmatched;
        totals.wishAdded += result.wishAdded;
        created.push({ id, name });
      }
      clearLibraryIndex(); // 本批本地歌单文件导入结束,立即回收曲库索引缓存
      touch(); // 标记活动:歌单导入
      return c.json({
        success: true,
        playlistId: created[0]?.id,
        name: created[0]?.name || "导入歌单",
        platform: "local",
        trackCount: totals.total,
        matched: totals.matched,
        unmatched: totals.unmatched,
        wishAdded: totals.wishAdded,
        created: created.length,
      });
    }
    if (syncApi()?.checkImportCooldown(user?.id || "", url) ?? false) {
      return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.playlist.importDup"), apiErrorStatus(BusinessErrorCode.CONFLICT));
    }
    if (!syncApi()) return c.json(apiError(BusinessErrorCode.UNAVAILABLE, "errors.playlist.syncNotEnabled"), apiErrorStatus(BusinessErrorCode.UNAVAILABLE));
    const ownerKey = `${url}:${user?.id || ""}`;
    // URL 导入跑在一次性批量子进程里(方案3):子进程内 importPlaylistFromUrl +
    // 增量重建,进度/结果经 IPC 回传;clearLibraryIndex/touch 由 runBatchJob 收尾。
    const started = startAsyncTask("playlist-import", `url:${ownerKey}`, {
      kind: "playlist-import",
      args: { url, userId: user?.id, name: typeof body.name === "string" ? body.name : undefined, autoSync: !!body.autoSync },
    });
    if (!started.started) return c.json({ success: false, alreadyRunning: true, taskId: started.taskId });
    return c.json({ success: true, taskId: started.taskId });
});

// Export a playlist as a MusicFlow-native JSON file that round-trips back
// through the import endpoint.

app.get("/v1/playlists/:id/export", permMiddleware(PERM.PLAYLIST_IMPORT), (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.playlist.notFound"), apiErrorStatus(BusinessErrorCode.NOT_FOUND));
  if (playlist.ownerId !== user?.id && !user?.isAdmin) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.user.exportForbidden"), 403);
  const exported = syncApi()?.exportPlaylistEntries(id);
  if (!exported) return c.json(apiError(BusinessErrorCode.UNAVAILABLE, "errors.playlist.syncNotEnabled"), apiErrorStatus(BusinessErrorCode.UNAVAILABLE));
  const { name, tracks } = exported;
  const payload = { app: NATIVE_APP, version: 1, exportedAt: new Date().toISOString(), name, tracks };
  const filename = `${(name || "歌单").replace(/[\\/:*?"<>|]/g, "_")}.json`;
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return c.json(payload);
});

// Export ALL of the current user's playlists into a single MusicFlow-native
// file (raw.playlists array). Re-imports through the same /import endpoint,
// which recreates each playlist.

app.get("/v1/playlists/export-all", permMiddleware(PERM.PLAYLIST_IMPORT), (c) => {
  const user = c.get("user");
  const mine = db.select().from(playlists)
    .where(eq(playlists.ownerId, user?.id || ""))
    .all();
  const playlistsOut = mine.map((p) => {
    const exp = syncApi()?.exportPlaylistEntries(p.id);
    return { name: exp?.name ?? "", tracks: exp?.tracks ?? [] };
  });
  const filename = `MusicFlow全部歌单_${new Date().toISOString().slice(0, 10)}.json`;
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return c.json({ app: NATIVE_APP, version: 1, exportedAt: new Date().toISOString(), exportAll: true, playlists: playlistsOut });
});

// ==================== Playlist sync ====================
// 手动同步走异步任务(触发即返回 taskId,前端轮询):大歌单同步可能耗时,避免 HTTP 长时间挂起。

app.post("/v1/playlists/:id/sync", permMiddleware(PERM.PLAYLIST_IMPORT), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.playlist.notFound"), apiErrorStatus(BusinessErrorCode.NOT_FOUND));
  // Only owner (or admin) can sync
  if (playlist.ownerId !== user?.id && !user?.isAdmin) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.playlist.syncForbidden"), apiErrorStatus(BusinessErrorCode.FORBIDDEN));
  if (!syncApi()) return c.json(apiError(BusinessErrorCode.UNAVAILABLE, "errors.playlist.syncNotEnabled"), apiErrorStatus(BusinessErrorCode.UNAVAILABLE));
  const started = startAsyncTask("playlist-sync", `pl:${id}`, {
    kind: "playlist-sync",
    args: { playlistId: id, userId: user?.id },
  });
  if (!started.started) return c.json({ success: false, alreadyRunning: true, taskId: started.taskId });
  return c.json({ success: true, taskId: started.taskId });
});

// 异步任务状态查询(前端轮询):GET /v1/tasks/:taskId

app.put("/v1/playlists/:id", permMiddleware(PERM.PLAYLIST_MANAGE), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.playlist.notFound"), apiErrorStatus(BusinessErrorCode.NOT_FOUND));
  if (playlist.ownerId !== user?.id && !user?.isAdmin) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.playlist.modifyForbidden"), apiErrorStatus(BusinessErrorCode.FORBIDDEN));
  const update: any = { updatedAt: new Date().toISOString() };
  if (body.name !== undefined) update.name = String(body.name).trim() || playlist.name;
  if (body.isPublic !== undefined) update.isPublic = body.isPublic ? 1 : 0;
  if (body.syncEnabled !== undefined) update.syncEnabled = body.syncEnabled ? 1 : 0;
  db.update(playlists).set(update).where(eq(playlists.id, id)).run();
  return c.json({ success: true });
});

// Convert a platform-imported playlist (go-music-dl daily-recommend etc.) into a
// permanent local playlist: detach its source link so the daily rotation neither
// replaces its contents nor deletes it. Entries/cover/name are kept as-is.

app.post("/v1/playlists/:id/convert-to-local", permMiddleware(PERM.PLAYLIST_MANAGE), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.playlist.notFound"), apiErrorStatus(BusinessErrorCode.NOT_FOUND));
  if (playlist.ownerId !== user?.id && !user?.isAdmin) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.playlist.modifyForbidden"), apiErrorStatus(BusinessErrorCode.FORBIDDEN));
  if (!playlist.sourceUrl) return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.playlist.alreadyLocal"), apiErrorStatus(BusinessErrorCode.CONFLICT));
  const update: any = {
    sourceUrl: null,
    externalId: null,
    sourcePlatform: "",
    syncEnabled: 0,
    updatedAt: new Date().toISOString(),
  };
  // Daily-recommend imports carry a "每日推荐歌单·<source>" comment — clear it so
  // the converted playlist isn't mistaken for a rotating daily-recommend playlist.
  if (playlist.comment && playlist.comment.startsWith("每日推荐歌单·")) {
    update.comment = "";
  }
  db.update(playlists).set(update).where(eq(playlists.id, id)).run();
  return c.json({ success: true });
});

// 收藏 / 取消收藏歌单。Body: { favorite: boolean }。
// 收藏平台歌单(sourceUrl 非空):保留来源信息供每天自动同步,置 favorite + syncEnabled=1
// 收藏歌单按用户隔离:任意登录用户都能收藏/取消(不再限 owner/admin),
// 写入 playlist_favorites(user_id × playlist_id)。收藏后的副作用与原先一致:
// 平台歌单收藏后转本地并开启每天自动同步(每天同步默认打开),并脱离每日推荐轮换。
// 取消收藏平台歌单:仅移除当前用户的收藏标记,恢复每日推荐轮换身份(syncAll 重新管理)。

app.post("/v1/playlists/:id/favorite", permMiddleware(PERM.FAVORITES_MANAGE), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => ({}));
  const favorite = body.favorite === true;
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.playlist.notFound"), apiErrorStatus(BusinessErrorCode.NOT_FOUND));

  const now = new Date().toISOString();
  if (favorite) {
    // 收藏:写入当前用户 × 该歌单的多对多关系。
    try {
      db.insert(playlistFavorites).values({ userId: user.id, playlistId: id, createdAt: now }).run();
    } catch {
      // 已收藏过(唯一键冲突)则忽略,幂等。
    }
    const isPlatform = !!playlist.sourceUrl;
    db.update(playlists).set({
      // 兼容旧全局字段:仍置 1(有用户收藏),供每日推荐轮换保护等旧逻辑判断。
      favorite: 1,
      // 平台歌单收藏后每天自动同步(默认打开);本地歌单保持原 syncEnabled 不变。
      syncEnabled: isPlatform ? 1 : playlist.syncEnabled || 0,
      updatedAt: now,
    }).where(eq(playlists.id, id)).run();
  } else {
    // 取消收藏:仅移除当前用户的收藏记录。
    db.delete(playlistFavorites).where(and(
      eq(playlistFavorites.userId, user.id),
      eq(playlistFavorites.playlistId, id),
    )).run();
    // 若无任何用户收藏该歌单,清除全局收藏标记(恢复可被每日推荐轮换的资格)。
    const others = db.select({ c: count() }).from(playlistFavorites).where(eq(playlistFavorites.playlistId, id)).get()?.c ?? 0;
    if (others === 0) {
      db.update(playlists).set({ favorite: 0, updatedAt: now }).where(eq(playlists.id, id)).run();
    }
  }
  return c.json({ success: true, favorite });
});

// ==================== Playlists (paginated) ====================

app.get("/v1/playlists", permMiddleware(PERM.PLAYLIST_VIEW), (c) => {
  return c.json(buildPlaylistsPage({
    page: c.req.query("page"),
    pageSize: c.req.query("pageSize"),
    query: c.req.query("query"),
    platform: c.req.query("platform"),
    local: c.req.query("local"),
    favorite: c.req.query("favorite"),
    sort: c.req.query("sort"),
  }, c.get("user")));
});

// ==================== Navidrome compatible ====================

app.get("/playlist", (c) => {
  const user = c.get("user");
  const all = db.select().from(playlists).all().filter(p => p.ownerId === user?.id || p.isPublic || p.sourceUrl);
  const dailyRank = (p: any) => {
    const c = p.comment || "";
    const tag = dailyRecommendTag() || "每日推荐";
    if (c.includes(tag) && p.name === tag) return 0;
    return 1;
  };
  return c.json(all.sort((a, b) => {
    const ra = dailyRank(a), rb = dailyRank(b);
    if (ra !== rb) return ra - rb;
    return (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "");
  }));
});

app.get("/playlist/:id/tracks", (c) => c.json(db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, c.req.param("id"))).all().filter(e => e.playable && e.songId)));

app.delete("/playlist/:id", (c) => { const user = c.get("user"); const id = c.req.param("id")!; if (isFixedRecommendPlaylist(id)) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.playlist.fixedNotDeleteable"), 400); const pl = db.select().from(playlists).where(eq(playlists.id, id)).get(); if (!pl) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.playlist.notFound"), apiErrorStatus(BusinessErrorCode.NOT_FOUND)); if (pl.ownerId !== user?.id && !user?.isAdmin) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.user.deleteForbidden"), 403); db.delete(playlistSongs).where(eq(playlistSongs.playlistId, id)).run(); db.delete(playlists).where(eq(playlists.id, id)).run(); clearPlaylistCoverCache(id); return c.json({ success: true }); });

// ==================== Playlist tracks (paginated) ====================

app.get("/v1/playlists/:id/tracks", permMiddleware(PERM.PLAYLIST_VIEW), (c) => {
  const id = c.req.param("id")!;
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.playlist.notFound"), apiErrorStatus(BusinessErrorCode.NOT_FOUND));
  // 「随机歌曲」固定歌单惰性刷新:客户端(音流随心听)读取曲目列表时若超过
  // 刷新间隔则立即重建,播完一轮再来取时歌单必然已刷新好 → 无空白等待。
  if (playlist.id === RANDOM_PLAYLIST_ID) maybeRefreshRandomSongs();
  // Push total / matched counts + the page slice to SQL instead of pulling
  // every entry and slicing in JS. orderBy(position, id) keeps pagination
  // stable and follows the playlist's intended track order.
  const baseWhere = eq(playlistSongs.playlistId, id);
  const total = (db.select({ c: count() }).from(playlistSongs).where(baseWhere).get()?.c) ?? 0;
  const matchedWhere = and(
    baseWhere,
    eq(playlistSongs.playable, 1),
    sql`${playlistSongs.songId} IS NOT NULL AND ${playlistSongs.songId} != ''`,
  );
  const matched = (db.select({ c: count() }).from(playlistSongs).where(matchedWhere).get()?.c) ?? 0;
  const pageEntries = db.select().from(playlistSongs)
    .where(baseWhere)
    .orderBy(playlistSongs.position, playlistSongs.id)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  // Batch song + album lookups (was N+1: one songs query + one albums query
  // per track). Order is preserved by mapping back through pageEntries.
  const songIds = pageEntries.filter((e) => e.playable && e.songId).map((e) => e.songId as string);
  const songMap = songIds.length
    ? new Map(db.select().from(songs).where(inArray(songs.id, songIds)).all().map((s) => [s.id, s]))
    : new Map<string, any>();
  const albumIds: string[] = [];
  for (const s of songMap.values()) if (s.albumId) albumIds.push(s.albumId as string);
  const albumMap = albumIds.length
    ? new Map(db.select().from(albums).where(inArray(albums.id, albumIds)).all().map((a) => [a.id, a]))
    : new Map<string, any>();
  const items = pageEntries.map((e) => {
    if (e.playable && e.songId) {
      const song = songMap.get(e.songId);
      if (song) {
        const album = song.albumId ? albumMap.get(song.albumId) : undefined;
        return {
          ...serializeSongRow(
            song,
            // 歌曲自带封面优先;否则回退专辑封面。只要专辑行存在就给 al-<id>,
            // 最终图片由 getCoverArt 的 al- 分支解析(专辑自带 → 同专辑首支带封面
            // 曲目),与专辑详情页头部同源。此前要求专辑自带封面才给 al-,于是专辑
            // 头部有图(二级回退)而歌单曲目行空白。
            song.coverArt ? `so-${song.id}` : (album ? `al-${album.id}` : undefined),
          ),
          playable: true, isMatched: true,
        };
      }
    }
    return {
      id: e.externalSongId || `ext-${e.id}`, entryId: e.id, title: e.externalTitle || "", artist: e.externalArtist || "",
      album: e.externalAlbum || "", duration: Math.round((e.externalDuration || 0) / 1000),
      playable: false, isMatched: false, unavailableReason: e.unavailableReason || "曲库中未找到",
    };
  });
  // 组内多源:一次查询页内成员行,按组合并附加(前端按此合并展示/展开)
  const trackGroupIds = [...new Set(items.filter((i) => (i as any).groupId).map((i) => (i as any).groupId as string))];
  if (trackGroupIds.length) {
    try {
      const memberRows = db.select().from(songs).where(inArray(songs.groupId, trackGroupIds)).all();
      attachGroupSources(items as any, memberRows, resolveSongCover);
    } catch (e) {
      log.error("歌单曲目组内多源查询失败", { err: (e as Error)?.message || e });
    }
  }
  return c.json({ total, matched, page, pageSize, items, playlist: { id: playlist.id, name: playlist.name, songCount: playlist.songCount || 0, matched, duration: playlist.duration || 0, coverArt: `pl-${playlist.id}`, sourcePlatform: playlist.sourcePlatform || "", isImported: isImportedPlaylist(playlist), pluginSynced: isPluginSyncPlaylist(playlist), sourcePluginId: playlist.sourcePlugin || "", syncEnabled: !!playlist.syncEnabled, public: !!playlist.isPublic, owner: playlist.ownerId, isDaily: isDailyRecommendPlaylist(playlist) } });
});

// ==================== Play history (paginated) ====================

app.post("/v1/playlist/:id/auto-match", permMiddleware(PERM.PLAYLIST_IMPORT), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  const playlist = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!playlist) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.playlist.notFound"), apiErrorStatus(BusinessErrorCode.NOT_FOUND));
  if (playlist.ownerId !== user?.id && !user?.isAdmin) {
    return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.playlist.modifyForbidden"), apiErrorStatus(BusinessErrorCode.FORBIDDEN));
  }
  // fire-and-forget:拿全局批量闸可能要排队,绝不能把触发方挂住。
  //
  // 走 runPlaylistAutoMatch 而非直接 matchPlaylistInBackground,目的只有一个:
  // 与 /v1/play 那条快路径**共用同一份 24h 节流**,避免客户端每次本机起播歌单都真打
  // 一轮在线源(连点即 429,正是节流要防的场景)。不传 playerId/contentContext =>
  // 只做匹配、不做服务端补齐,队列由调用方本机自行 diff 追加队尾,语义不变。
  void runPlaylistAutoMatch(id).then((r) => {
    console.info(
      `[auto-match] ${id} 完成: total=${r.total} matched=${r.matched}` +
      ` appended=${r.appended} skipped=${r.skipped || "-"}${r.lockTimeout ? " lockTimeout" : ""}`,
    );
  });
  return c.json({ success: true, started: true, playlistId: id });
});

// ==================== 音流(MusicFlow) ====================
// 每条音流 = 目标设备/组(多选) + 等上线 + 音量 + 播放模式 + 播歌单,
// 通过唯一 token 的公开 webhook 链接(/api/v1/webhooks/flows/:token)异步触发。
}
