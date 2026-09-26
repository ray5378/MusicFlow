// 自动生成 —— 由 index.ts 物理拆分而来（library 域，20 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  PERM,
  SCRAPE_JOB_ID,
  albumCoverRef,
  albums,
  and,
  apiError,
  artists,
  artistsMissingCovers,
  artistsMissingInfo,
  asc,
  attachGroupSources,
  buildArtistList,
  count,
  db,
  deleteSongDb,
  desc,
  eq,
  genreIdFor,
  genres,
  getArtistList,
  inArray,
  like,
  log,
  or,
  path,
  permMiddleware,
  resolveLyricContent,
  resolveSongCover,
  runBatchJob,
  scrapeArtist,
  scrapeJobs,
  serializeSongRow,
  songs,
  sql,
  userFavoriteAlbums,
  userFavoriteArtists,
  users,
} from "./shared.js";

export function registerLibrary(app: Hono): void {
app.use("/v1/songs", permMiddleware(PERM.LIBRARY_BROWSE));

app.use("/v1/genres", permMiddleware(PERM.LIBRARY_BROWSE));

app.use("/v1/albums", permMiddleware(PERM.LIBRARY_BROWSE));

app.use("/v1/artists", permMiddleware(PERM.LIBRARY_BROWSE));

app.use("/v1/stats", permMiddleware(PERM.LIBRARY_BROWSE));

app.use("/v1/song-search", permMiddleware(PERM.LIBRARY_SEARCH));

app.use("/v1/artist-search", permMiddleware(PERM.LIBRARY_SEARCH));

app.use("/v1/album-search", permMiddleware(PERM.LIBRARY_SEARCH));

app.get("/v1/stats", (c) => {
  const songCount = db.select().from(songs).all().length;
  const albumCount = db.select().from(albums).all().length;
  const artistCount = db.select().from(artists).all().length;
  const userCount = db.select().from(users).all().length;
  return c.json({ songCount, albumCount, artistCount, userCount });
});

// ==================== Songs (paginated + searchable) ====================

app.get("/v1/songs", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  const genre = (c.req.query("genre") || "").trim();
  // sort=recentAdded: 最新添加入库的歌曲（按入库时间倒序，封顶 500 首，新入库自动进入列表）
  const sort = (c.req.query("sort") || "").trim();
  const recentAdded = sort === "recentAdded";
  // 通用排序:sortField(名称/时长/入库时间/艺术家/专辑/播放次数) + order(asc|desc)
  const sortField = (c.req.query("sortField") || "").trim();
  const sortOrder = (c.req.query("order") || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const SORT_COLUMNS: Record<string, unknown> = {
    name: songs.title,
    duration: songs.duration,
    addedAt: songs.createdAt,
    artist: songs.artist,
    album: songs.album,
    playCount: songs.playCount,
  };
  // 排序字段对应的排序列;未知字段回退为按名称
  const sortCol = (SORT_COLUMNS[sortField] || songs.title) as any;
  const orderBy = sortOrder === "desc" ? desc(sortCol) : asc(sortCol);
  // SQL-level filtering + pagination (avoids loading the whole table into memory)
  const conds = [];
  if (genre) conds.push(eq(songs.genre, genre));
  if (query) {
    const q = `%${query}%`;
    conds.push(or(like(songs.title, q), like(songs.artist, q), like(songs.album, q)));
  }
  const where = conds.length > 0 ? (conds.length === 1 ? conds[0] : and(...conds)) : undefined;
  // 最近添加模式最多只取 500 首（超出部分不算在总数内）
  const RECENT_ADDED_CAP = 500;
  const start = (page - 1) * pageSize;
  // Fast SQL count for the total
  const totalRow = where
    ? db.select({ n: sql<number>`count(*)` }).from(songs).where(where).get()
    : db.select({ n: sql<number>`count(*)` }).from(songs).get();
  const rawTotal = totalRow?.n ?? 0;
  const total = recentAdded ? Math.min(RECENT_ADDED_CAP, rawTotal) : rawTotal;
  // 最近添加模式的分页不超出 500 首范围
  const safeStart = recentAdded ? Math.min(start, Math.max(0, total - pageSize)) : start;
  // SQL-level pagination
  const pageSongs = recentAdded
    ? (where
        ? db.select().from(songs).where(where).orderBy(desc(songs.createdAt)).limit(pageSize).offset(safeStart).all()
        : db.select().from(songs).orderBy(desc(songs.createdAt)).limit(pageSize).offset(safeStart).all())
    : (where
        ? db.select().from(songs).where(where).orderBy(orderBy).limit(pageSize).offset(start).all()
        : db.select().from(songs).orderBy(orderBy).limit(pageSize).offset(start).all());
  // Batch album existence lookups for songs without their own cover (avoids N+1
  // album queries on every page). 这里只判定专辑行是否存在,不判断它有没有封面:
  // 具体图片一律由 getCoverArt 的 al- 分支解析(专辑自带封面 → 回退同专辑首支带
  // 封面曲目),与专辑详情页头部同源。此前在此判空,导致「专辑头部有封面、曲目行
  // 却空白」——头部那张图正是二级回退借来的。
  const coverAlbumIds = [...new Set(pageSongs.filter((s) => !s.coverArt && s.albumId).map((s) => s.albumId as string))];
  const coverMap = coverAlbumIds.length
    ? new Map(db.select({ id: albums.id }).from(albums).where(inArray(albums.id, coverAlbumIds)).all().map((a) => [a.id, `al-${a.id}` as string]))
    : new Map<string, string>();
  const items = pageSongs.map(s => serializeSongRow(
    s,
    s.coverArt ? `so-${s.id}` : (s.albumId ? coverMap.get(s.albumId) : undefined),
  ));
  // 组内多源:一次查询页内所有 group_id 的成员行,按组合并附加(前端按此合并展示)
  const pageGroupIds = [...new Set(pageSongs.filter((s) => s.groupId).map((s) => s.groupId as string))];
  if (pageGroupIds.length) {
    try {
      const memberRows = db.select().from(songs).where(inArray(songs.groupId, pageGroupIds)).all();
      attachGroupSources(items, memberRows, resolveSongCover);
    } catch (e) {
      // 组查询失败不影响列表主体,来源合并降级为单行展示
      log.error("歌曲组内多源查询失败", { err: (e as Error)?.message || e });
    }
  }
  return c.json({ total, page, pageSize, items });
});

// 单曲详情:在列表行字段之上补两类「体积大、不适合逐行返回」的东西 ——
// ① tags:扫描时从文件头落库的全部原始标签 JSON(平均 0.5~2KB,含封面/歌词长度摘录);
// ② lyrics 概况:是否已有歌词、是否为带时间轴的 LRC、字符数(歌词正文仍走原有
//   歌词接口/文件,不在详情里回传)。
// 前端「歌曲信息」弹窗据此展示原始标签;列表接口刻意不返回这两个字段。

app.get("/v1/songs/:id", (c) => {
  const id = c.req.param("id")!;
  const song = db.select().from(songs).where(eq(songs.id, id)).get();
  if (!song) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.song.notFound"), 404);
  const row = serializeSongRow(song, resolveSongCover(song));
  let tags: Record<string, unknown> | null = null;
  const rawTags = (song as any).tags;
  if (typeof rawTags === "string" && rawTags.trim()) {
    try {
      const parsed = JSON.parse(rawTags);
      if (parsed && typeof parsed === "object") tags = parsed as Record<string, unknown>;
    } catch {
      // tags 损坏(手工改库/半截写入)时降级为 null,不影响详情主体
      tags = null;
    }
  }
  // 歌词:库里只有「文件引用」或「存在性标注」,正文在 online-lyrics/<id>.lrc 或源文件里。
  // 内嵌歌词只标注(has_lyrics=1)不存正文 → 这类歌 present=true 但 length/timed 取不到,
  // 时间轴判断仅在歌词文件实际存在时有效。
  const lyricsRef = (song as any).lyrics || "";
  const hasLyrics = (song as any).hasLyrics === 1 || !!lyricsRef;
  const lyricsBody = lyricsRef ? resolveLyricContent(lyricsRef) || "" : "";
  return c.json({
    ...row,
    /** 文件在源上的路径(歌曲信息里用来看来源文件) */
    path: song.path || "",
    tags,
    lyrics: {
      present: hasLyrics,
      /** 是否有可读的歌词正文(内嵌歌词只标注存在性时为 false) */
      inLibrary: lyricsBody.length > 0,
      timed: /\[\d{1,2}:\d{2}/.test(lyricsBody),
      length: lyricsBody.length,
    },
  });
});

// 删除库内单曲(含插件匹配的 web 歌曲):级联清理歌单条目/收藏/播放历史后删除,
// 再清理孤儿专辑/艺人。web 歌曲删除后需重新搜索匹配才会回来;本地歌曲由媒体源
// 重新扫描时会自然恢复(删除只移除记录,不触碰源文件)。

app.delete("/v1/songs/:id", (c) => {
  const id = c.req.param("id")!;
  const ok = deleteSongDb(id);
  if (!ok) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.song.notFound"), 404);
  return c.json({ success: true });
});

// 批量删除库内歌曲:级联清理歌单/收藏/播放历史后删除记录,并清理孤儿专辑/艺人。
// 前端「多选 → 从音乐库删除」仅针对 web 歌曲;本地歌曲由媒体源重扫自动恢复。

app.post("/v1/songs/delete", async (c) => {
  const body = await c.req.json().catch(() => ({}) as any);
  const ids = Array.isArray(body?.ids) ? body.ids.map((v: unknown) => String(v)).filter(Boolean) : [];
  if (ids.length === 0) return c.json({ success: true, deleted: 0 });
  let deleted = 0;
  for (const id of ids) {
    if (deleteSongDb(id)) deleted++;
  }
  return c.json({ success: true, deleted });
});

// 删除单曲的级联清理:先清关联表,再删歌曲记录与孤儿数据。返回是否存在该曲。
// export 供单测直调(P0-6 回写联动不断言路由层,只断言"删行即清回写")。

app.get("/v1/genres", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  const rows = db.select({
    name: songs.genre,
    songCount: sql<number>`count(*)`,
  }).from(songs)
    .where(sql`genre != ''`)
    .groupBy(songs.genre)
    .orderBy(sql`count(*) DESC`)
    .all();
  const mapped = rows.filter((r) => r.name).map(r => ({ id: genreIdFor(r.name as string), name: r.name, songCount: r.songCount }));
  const filtered = query ? mapped.filter(g => (g.name || "").toLowerCase().includes(query.toLowerCase())) : mapped;
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  return c.json({ total, page, pageSize, items: filtered.slice(start, start + pageSize) });
});

// ==================== Albums (paginated + searchable) ====================

app.get("/v1/albums", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  // SQL-level filter (name/artist LIKE) + ORDER BY created_at DESC + pagination,
  // so we no longer load the whole albums table into memory on every request.
  const where = query
    ? or(like(albums.name, `%${query}%`), like(albums.artist, `%${query}%`))
    : undefined;
  const totalRow = where
    ? db.select({ n: sql<number>`count(*)` }).from(albums).where(where).get()
    : db.select({ n: sql<number>`count(*)` }).from(albums).get();
  const total = totalRow?.n ?? 0;
  const start = (page - 1) * pageSize;
  const rows = where
    ? db.select().from(albums).where(where).orderBy(desc(albums.createdAt)).limit(pageSize).offset(start).all()
    : db.select().from(albums).orderBy(desc(albums.createdAt)).limit(pageSize).offset(start).all();
  // 收藏标记:按当前页专辑 ID 批量查收藏表(避免每行一次查询)。
  const albumUser = c.get("user");
  const albumStarredSet = new Set<string>();
  if (albumUser?.id && rows.length) {
    const favs = db.select({ albumId: userFavoriteAlbums.albumId }).from(userFavoriteAlbums)
      .where(and(eq(userFavoriteAlbums.userId, albumUser.id), inArray(userFavoriteAlbums.albumId, rows.map(r => r.id)))).all();
    for (const f of favs) albumStarredSet.add(f.albumId);
  }
  const items = rows.map(a => ({
    id: a.id, name: a.name, artist: a.artist, artistId: a.artistId, year: a.year,
    songCount: a.songCount, duration: a.duration, playCount: a.playCount,
    coverArt: albumCoverRef(a),
    starred: albumStarredSet.has(a.id) ? true : undefined,
  }));
  return c.json({ total, page, pageSize, items });
});

// ==================== Artists (paginated + searchable) ====================

app.get("/v1/artists", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(c.req.query("pageSize") || "50") || 50));
  const query = (c.req.query("query") || "").trim();
  // Push the name search to SQL to shrink the working set; the final sort stays
  // in JS (localeCompare) so Chinese/locale ordering is preserved exactly.
  // 无限滚动每块都调此端点:全量取数+排序是每块延迟主因(17k 行实测 ~90ms)。
  // 按 query 缓存「排好序的完整数组」,滚动期间各块直接切片复用;写入后缓存失效。
  const cacheKey = query.toLowerCase();
  const rows = (getArtistList(cacheKey) as typeof artists.$inferSelect[]) || buildArtistList(cacheKey, query);
  const total = rows.length;
  const start = (page - 1) * pageSize;
  // 收藏标记:按当前页艺人 ID 批量查收藏表(避免每行一次查询)。
  const artistUser = c.get("user");
  const artistStarredSet = new Set<string>();
  if (artistUser?.id && rows.length) {
    const favs = db.select({ artistId: userFavoriteArtists.artistId }).from(userFavoriteArtists)
      .where(and(eq(userFavoriteArtists.userId, artistUser.id), inArray(userFavoriteArtists.artistId, rows.map(r => r.id)))).all();
    for (const f of favs) artistStarredSet.add(f.artistId);
  }
  const items = rows.slice(start, start + pageSize).map(a => ({
    id: a.id, name: a.name, albumCount: a.albumCount, coverArt: a.coverArt ? `ar-${a.id}` : undefined,
    scrapeMissing: a.scrapeMissing === 1,
    starred: artistStarredSet.has(a.id) ? true : undefined,
  }));
  return c.json({ total, page, pageSize, items });
});

// 取全量/搜索艺术家并做 JS localeCompare 排序(保留中文序),结果按 query 缓存供后续块复用。

app.post("/v1/artists/scrape", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = (body.name || "").trim();
  try {
    if (name) {
      const result = await scrapeArtist(name, body.artistId || undefined);
      if (!result) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.artist.notFound"));
      return c.json({ success: true, name: result.name, platform: result.platform, coverArt: result.coverArt, bio: result.bio || undefined });
    }
    // Full scrape: all artists missing covers, run in background with progress
    if (scrapeJobs.get(SCRAPE_JOB_ID)?.status === "running") {
      return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.scraper.busy"));
    }
    const missing = artistsMissingCovers();
    const job = { status: "running", startedAt: new Date().toISOString(), progress: undefined as any };
    scrapeJobs.set(SCRAPE_JOB_ID, job);
    const onProgress = (p: any) => { job.progress = { ...p }; };
    (async () => {
      try {
        const { result } = await runBatchJob("scrape-artists", { artistIds: missing.map(a => a.id) }, { onProgress });
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "done", startedAt: job.startedAt, finishedAt: new Date().toISOString(), progress: result });
      } catch (e: any) {
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "failed", startedAt: job.startedAt, error: e.message || "errors.scraper.failed", progress: job.progress });
      }
    })();
    return c.json({ success: true, total: missing.length, message: "开始刮削" });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.scraper.failed"));
  }
});

app.get("/v1/artists/scrape-status", (c) => {
  const job = scrapeJobs.get(SCRAPE_JOB_ID);
  if (!job) return c.json({ status: "idle", progress: null });
  return c.json({ status: job.status, progress: job.progress || null, error: job.error || null, startedAt: job.startedAt });
});

// Retry scraping ONLY artists marked as missing-info (fallback cover in use).
// If the platform now has the artist, the avatar is replaced with the real one
// and the missing flag is cleared.

app.post("/v1/artists/scrape-missing", async (c) => {
  try {
    if (scrapeJobs.get(SCRAPE_JOB_ID)?.status === "running") {
      return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.scraper.busy"));
    }
    const missing = artistsMissingInfo();
    if (missing.length === 0) {
      return c.json({ success: true, total: 0, message: "没有缺失歌手信息的歌手" });
    }
    const job = { status: "running", startedAt: new Date().toISOString(), progress: undefined as any };
    scrapeJobs.set(SCRAPE_JOB_ID, job);
    const onProgress = (p: any) => { job.progress = { ...p }; };
    (async () => {
      try {
        const { result } = await runBatchJob("scrape-artists", { artistIds: missing.map(a => a.id) }, { onProgress });
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "done", startedAt: job.startedAt, finishedAt: new Date().toISOString(), progress: result });
      } catch (e: any) {
        scrapeJobs.set(SCRAPE_JOB_ID, { status: "failed", startedAt: job.startedAt, error: e.message || "errors.scraper.failed", progress: job.progress });
      }
    })();
    return c.json({ success: true, total: missing.length, message: "开始刮削缺失歌手信息" });
  } catch (e: any) {
    return c.json(apiError(BusinessErrorCode.UPSTREAM_ERROR, e.message || "errors.scraper.failed"));
  }
});

// Count of artists marked missing-info (for the frontend badge)

app.get("/v1/artists/missing-info-count", (c) => {
  return c.json({ count: artistsMissingInfo().length });
});

// ==================== Settings ====================
}
