// Playlist sync service: re-fetch remote playlist, rebuild entries with library matching
import { db, sqlite } from "../../db/index.js";
import { songs, playlists, playlistSongs, wishes } from "../../db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { importPlaylistFromUrl, findUrlImporter, ImportedPlaylist, ImportedTrack } from "./playlistImport.js";
import { cacheRemoteCover, clearPlaylistCoverCache } from "../playlistCover.js";
import type { PluginManifest, SyncPlugin } from "../../plugins/types.js";
// 共享匹配/计数工具已收敛到 services/plugin/shared.ts(宿主中性模块),本插件只消费,
// 不再持有定义,以免核心路由被迫直接 import 本实现文件(check-core 规则 B)。
import { normalizeKey, matchPlaylistInBackground, refreshPlaylistCounts } from "./shared.js";
import { getLibraryIndex, clearLibraryIndex } from "./libraryIndex.js";
import { sleepBetweenBatch } from "./batchPacer.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("auto-match");
export interface SyncResult {
  total: number;
  matched: number;
  unmatched: number;
  wishAdded: number;
  platform?: string;
}

// Per-playlist sync lock to prevent concurrent duplicate requests
const syncLocks = new Set<string>();
// Per-user+url cooldown for duplicate imports (10s)
const importCooldowns = new Map<string, number>();

export function isSyncing(playlistId: string): boolean {
  return syncLocks.has(playlistId);
}

export function checkImportCooldown(userId: string, url: string): boolean {
  const key = `${userId}|${url}`;
  const last = importCooldowns.get(key);
  const now = Date.now();
  if (last && now - last < 10000) return true;
  importCooldowns.set(key, now);
  if (importCooldowns.size > 500) importCooldowns.clear();
  return false;
}

// 曲库匹配索引已迁移到 ./libraryIndex.ts(getLibraryIndex / clearLibraryIndex):
// 只索引「可播放」歌曲的最小列(id/title/artist/suffix/path),带进程级单例缓存
// 与显式回收,避免把整张 songs 表(含在线歌曲的大文本列)全量加载进内存。
// 严禁在此处再写 db.select().from(songs).all() 式的全量索引。

// Match a single remote track against the library index
export function matchTrack(track: ImportedTrack, index: Map<string, any[]>): any | null {
  const candidates = index.get(normalizeKey(track.title, track.artist)) || [];
  return candidates.find(s => s.suffix && s.path) || candidates[0] || null;
}

export interface RebuildOptions {
  userId?: string;
  autoWish?: boolean; // add unmatched tracks to wish list
  notes?: string; // note for wish entries
}

// Stable per-track key for diffing: prefer the platform external id; fall back to
// a normalized title|artist key when it is empty (some importers omit it).
function trackKey(externalId?: string | null, title?: string | null, artist?: string | null): string {
  if (externalId) return `e:${externalId}`;
  return `k:${normalizeKey(title || "", artist || "")}`;
}

// Add pending wishes in bulk. Dedupes against already-pending wishes (same
// songTitle+artist) with ONE grouped SELECT instead of one SELECT per track, then
// inserts the genuinely-new ones with a single multi-row INSERT. Returns count.
function addWishesBulk(candidates: ImportedTrack[], opts: RebuildOptions): number {
  if (candidates.length === 0) return 0;
  // 批内自身去重:同一 (title,artist) 只建一条 pending(也避免下面 IN 条件重复)。
  const dedupe = new Map<string, ImportedTrack>();
  for (const t of candidates) {
    const k = `${t.title}||${t.artist || ""}`;
    if (!dedupe.has(k)) dedupe.set(k, t);
  }
  const unique = [...dedupe.values()];

  // 一次查出已存在 pending(与待补同 title 的)——替代逐条 SELECT。
  const existingPending = new Set<string>();
  // 大列表下 IN 可能超长,按块分批查询(每块仍一次 SELECT,远少于逐条)。
  const CHUNK = 300;
  for (let off = 0; off < unique.length; off += CHUNK) {
    const slice = unique.slice(off, off + CHUNK);
    const rows = db.select().from(wishes)
      .where(and(
        eq(wishes.status, "pending"),
        inArray(wishes.songTitle, slice.map((t) => t.title)),
      ))
      .all();
    for (const r of rows) existingPending.add(`${r.songTitle}||${r.artist || ""}`);
  }

  // 真正缺失的 → 多行一次 INSERT(替代逐条 INSERT)。
  const now = new Date().toISOString();
  const rows = unique
    .filter((t) => !existingPending.has(`${t.title}||${t.artist || ""}`))
    .map((t) => ({
      id: uuidv4(), userId: opts.userId || "", songTitle: t.title, artist: t.artist || "",
      album: t.album || "", status: "pending", notes: opts.notes || "来自歌单导入",
      createdAt: now, updatedAt: now,
    }));
  if (rows.length) db.insert(wishes).values(rows).run();
  return rows.length;
}

// Rebuild a playlist's entries from a remote playlist *incrementally*:
//   - already-matched (playable) entries are REUSED — no library re-match, no rewrite
//   - only newly-added / removed / position-changed / newly-unmatched rows are written
//   - the library index (a full songs scan, the expensive part) is built lazily,
//     only when a track actually needs matching
// This turns a re-sync of an unchanged playlist into a pure read (zero writes) and
// keeps large-playlist refreshes cheap. All writes are wrapped in one transaction
// so a failure rolls back cleanly (no "entries cleared but song_count stale").
export async function rebuildPlaylistEntries(
  playlistId: string,
  imported: ImportedPlaylist,
  opts: RebuildOptions = {}
): Promise<SyncResult> {
  // Existing entries keyed by a stable per-track key.
  const existingRows = db.select().from(playlistSongs)
    .where(eq(playlistSongs.playlistId, playlistId)).all();
  const existMap = new Map<string, any>();
  for (const e of existingRows) {
    existMap.set(trackKey(e.externalSongId, e.externalTitle, e.externalArtist), e);
  }

  // Lazily-built library index: only touched when at least one track needs matching.
  let libraryIndex: Map<string, any[]> | null = null;
  const needIndex = (): Map<string, any[]> => {
    if (!libraryIndex) libraryIndex = getLibraryIndex();
    return libraryIndex;
  };

  let matched = 0, unmatched = 0, wishAdded = 0, newUnmatched = 0;
  type Row = {
    playlistId: string; songId: string | null; position: number; playable: number;
    externalSongId?: string; externalTitle?: string; externalArtist?: string;
    externalAlbum?: string; externalDuration?: number; unavailableReason?: string;
  };
  const inserts: Row[] = [];
  const updates: (Row & { id: number })[] = [];
  const deleteIds: number[] = [];
  const seenKeys = new Set<string>();
  // 待补 wish 的候选(未匹配且首次出现的条目)。批量收集后一次查询/插入,
  // 避免逐条对 wishes 表 SELECT+INSERT(大歌单大量未匹配时省下 N 次 DB 往返)。
  const wishCandidates: ImportedTrack[] = [];

  imported.tracks.forEach((t, i) => {
    const key = trackKey(t.externalId, t.title, t.artist);
    seenKeys.add(key);
    const prev = existMap.get(key);

    // Already matched & playable -> reuse, skip the (expensive) library match.
    if (prev && prev.songId) {
      matched++;
      if (prev.position !== i) {
        updates.push({
          id: prev.id, playlistId, songId: prev.songId, position: i, playable: 1,
          externalSongId: t.externalId ?? undefined, externalTitle: t.title,
          externalArtist: t.artist, externalAlbum: t.album, externalDuration: t.duration,
        });
      }
      return;
    }

    // Needs matching: new track, or a previous stub we re-evaluate.
    const match = matchTrack(t, needIndex());
    if (match) {
      matched++;
      const row: Row = {
        playlistId, songId: match.id, position: i, playable: 1,
        externalSongId: t.externalId, externalTitle: t.title, externalArtist: t.artist,
        externalAlbum: t.album, externalDuration: t.duration,
      };
      if (prev) updates.push({ ...row, id: prev.id });
      else inserts.push(row);
    } else {
      unmatched++;
      if (!prev && opts.autoWish !== false) wishCandidates.push(t);
      const row: Row = {
        playlistId, songId: null, position: i, playable: 0,
        externalSongId: t.externalId, externalTitle: t.title, externalArtist: t.artist,
        externalAlbum: t.album, externalDuration: t.duration, unavailableReason: "曲库中未找到",
      };
      if (prev) updates.push({ ...row, id: prev.id });
      else { inserts.push(row); newUnmatched++; }
    }
  });

  // Entries present before but absent from the new remote list -> remove.
  for (const e of existingRows) {
    const key = trackKey(e.externalSongId, e.externalTitle, e.externalArtist);
    if (!seenKeys.has(key)) deleteIds.push(e.id);
  }

  // 写入分片:删除/更新/插入各按 TX_CHUNK 拆小事务,chunk 间 sleepBetweenBatch() 让行,
  // 避免几千行单事务同步阻塞主线程(同步刷新时前端假死的根因之一)。小差异走单 chunk,
  // 行为与旧路径一致。
  const TX_CHUNK = 300;
  const chunkTx = (fn: () => void) => db.transaction(fn);
  if (deleteIds.length) {
    for (let off = 0; off < deleteIds.length; off += TX_CHUNK) {
      const ids = deleteIds.slice(off, off + TX_CHUNK);
      chunkTx(() => {
        db.delete(playlistSongs)
          .where(and(eq(playlistSongs.playlistId, playlistId), inArray(playlistSongs.id, ids)))
          .run();
      });
      if (off + TX_CHUNK < deleteIds.length) await sleepBetweenBatch();
    }
  }
  // updates 逐条 drizzle UPDATE -> 单条 CASE 批量 UPDATE。updates 的列在同一行上
  // 并非全部携带(如 matched 行无 unavailable_reason),CASE 若强行逐列会改动 drizzle
  // 未携带列的原值语义差异;且全列 CASE 参数会超 SQLite 变量上限(999)。故拆两段:
  //   ① 公共列 song_id/position/playable/external_*(8 列) 用较短分块(50)写 CASE;
  //   ② 仅带 unavailable_reason 的行再单独 CASE 补它。
  {
    const UPD_CHUNK = 50; // 8 列 CASE ≈ 17 参数/行,50 行 ≈ 850 < 999 上限
    const sets: string[] = [];
    const cols: [keyof Row & string, string][] = [
      ["songId", "song_id"],
      ["position", "position"],
      ["playable", "playable"],
      ["externalSongId", "external_song_id"],
      ["externalTitle", "external_title"],
      ["externalArtist", "external_artist"],
      ["externalAlbum", "external_album"],
      ["externalDuration", "external_duration"],
    ];
    for (let off = 0; off < updates.length; off += UPD_CHUNK) {
      const chunk = updates.slice(off, off + UPD_CHUNK);
      const ids = chunk.map((u) => u.id);
      const args: (number | string | null)[] = [];
      for (const [k, col] of cols) {
        sets.push(`${col} = CASE id ${chunk.map(() => "WHEN ? THEN ?").join(" ")} END`);
        for (const u of chunk) args.push(u.id, (u as any)[k] ?? null);
      }
      const idPh = ids.map(() => "?").join(",");
      chunkTx(() => {
        sqlite.prepare(`UPDATE playlist_songs SET ${sets.join(", ")} WHERE id IN (${idPh})`).run(...args, ...ids);
      });
      if (off + UPD_CHUNK < updates.length) await sleepBetweenBatch();
    }
    // 仅 unavailable_reason 非空的行:单独 CASE 写回(与 drizzle 语义一致——matched 行
    // 不携带该列即不改动)。
    const withReason = updates.filter((u) => (u as any).unavailableReason != null);
    for (let off = 0; off < withReason.length; off += UPD_CHUNK) {
      const chunk = withReason.slice(off, off + UPD_CHUNK);
      const ids = chunk.map((u) => u.id);
      const args: (number | string)[] = [];
      sets.length = 0;
      sets.push(`unavailable_reason = CASE id ${chunk.map(() => "WHEN ? THEN ?").join(" ")} END`);
      for (const u of chunk) args.push(u.id, (u as any).unavailableReason);
      const idPh = ids.map(() => "?").join(",");
      chunkTx(() => {
        sqlite.prepare(`UPDATE playlist_songs SET ${sets.join(", ")} WHERE id IN (${idPh})`).run(...args, ...ids);
      });
      if (off + UPD_CHUNK < withReason.length) await sleepBetweenBatch();
    }
  }
  for (let off = 0; off < inserts.length; off += TX_CHUNK) {
    const chunk = inserts.slice(off, off + TX_CHUNK);
    chunkTx(() => {
      if (chunk.length) db.insert(playlistSongs).values(chunk).run();
    });
    if (off + TX_CHUNK < inserts.length) await sleepBetweenBatch();
  }
  // 批量补 wish(一次性去重 + 多行 INSERT),替代此前逐条 SELECT/INSERT。
  wishAdded += addWishesBulk(wishCandidates, opts);
  refreshPlaylistCounts(playlistId);

  // Fire background auto-match only when genuinely new unmatched tracks appeared
  // (skip re-firing for previously-known stubs that are still unmatched).
  if (newUnmatched > 0) {
    matchPlaylistInBackground(playlistId).catch((e) => {
      log.error(`playlist ${playlistId} 自动匹配失败`, { err: e?.message || e });
    });
  }

  return { total: imported.tracks.length, matched, unmatched, wishAdded, platform: imported.platform };
}

// matchPlaylistInBackground 已收敛到 services/plugin/shared.ts(宿主中性模块)。
// 本插件只消费(rebuildPlaylistEntries 的 fire-and-forget 调用),不持有定义。

// Sync a playlist: re-fetch remote data and rebuild entries.
// Returns null if the playlist is not remote-imported, or throws on error.
export async function syncPlaylist(playlistId: string, opts: RebuildOptions = {}): Promise<SyncResult> {
  const playlist = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();
  if (!playlist) throw new Error("歌单不存在");
  if (!playlist.sourceUrl || !playlist.sourcePlatform) throw new Error("该歌单不是导入歌单,无法同步");

  if (syncLocks.has(playlistId)) throw new Error("该歌单正在同步中,请稍候");
  syncLocks.add(playlistId);
  try {
    const imported = await importPlaylistFromUrl(playlist.sourceUrl);
    const result = await rebuildPlaylistEntries(playlistId, imported, {
      ...opts,
      notes: `来自歌单「${playlist.name}」同步`,
    });
    // Refresh remote cover: force re-download on manual sync so platform cover updates apply
    let coverRef = playlist.coverArt;
    if (imported.coverUrl) {
      const cached = await cacheRemoteCover(imported.coverUrl, `pl-${playlistId}`, true);
      if (cached) coverRef = cached;
    }
    // Playlist entries changed -> clear the collage cache so it regenerates with new covers
    clearPlaylistCoverCache(playlistId);
    // Keep playlist name in sync with the platform if user hasn't renamed it
    db.update(playlists).set({
      updatedAt: new Date().toISOString(),
      coverArt: coverRef,
      sourcePlatform: imported.platform || playlist.sourcePlatform,
    }).where(eq(playlists.id, playlistId)).run();
    return result;
  } finally {
    syncLocks.delete(playlistId);
  }
}

// Sync all playlists with syncEnabled=1 (used by the scheduled task)
export async function syncAllEnabledPlaylists(opts: RebuildOptions = {}): Promise<{ synced: number; results: SyncResult[]; errors: string[] }> {
  const enabled = db.select().from(playlists).where(eq(playlists.syncEnabled, 1)).all();
  const results: SyncResult[] = [];
  const errors: string[] = [];
  let synced = 0;
  try {
    for (const pl of enabled) {
      if (syncLocks.has(pl.id)) continue;
      // Playlists whose sourceUrl no importer plugin claims are owned by someone
      // else — e.g. a source plugin's own recommend playlists (its manifest
      // `recommendPrefix` ref), refreshed by syncAllRecommendPlaylists instead.
      // Capability-driven skip: no hardcoded URL scheme.
      if (!pl.sourceUrl || !findUrlImporter(pl.sourceUrl)) continue;
      try {
        results.push(await syncPlaylist(pl.id, opts));
        synced++;
      } catch (e: any) {
        errors.push(`${pl.name}: ${e.message || "同步失败"}`);
      }
    }
  } finally {
    // 整轮同步结束,显式释放曲库索引缓存,立即回收其内存(避免缓存长驻,
    // 也防止下一轮/其他请求误用已过时索引)。
    clearLibraryIndex();
  }
  return { synced, results, errors };
}

// refreshPlaylistCounts 已收敛到 services/plugin/shared.ts(宿主中性模块)。

// Export a playlist's ordered tracks as MusicFlow-native ImportedTrack[], so
// the resulting JSON can be imported back (into this or another instance) via
// parseNativePlaylist + rebuildPlaylistEntries. Prefers external track metadata
// (kept from a platform import) for the richest re-match, else falls back to the
// matched local song's fields.
export function exportPlaylistEntries(playlistId: string): { name: string; tracks: ImportedTrack[] } {
  const playlist = db.select().from(playlists).where(eq(playlists.id, playlistId)).get();
  if (!playlist) throw new Error("歌单不存在");
  const entries = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, playlistId)).all()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const tracks: ImportedTrack[] = [];
  for (const e of entries) {
    let title = e.externalTitle || "";
    let artist = e.externalArtist || "";
    let album = e.externalAlbum || undefined;
    let duration = e.externalDuration || undefined;
    let extId = e.externalSongId || "";
    if (!title && e.songId) {
      const s = db.select().from(songs).where(eq(songs.id, e.songId)).get();
      if (s) {
        title = s.title || "";
        artist = s.artist || "";
        album = s.album || undefined;
        duration = (s.duration || 0) * 1000;
        extId = s.id;
      }
    }
    if (title) tracks.push({ externalId: extId, title, artist, album, duration });
  }
  return { name: playlist.name, tracks };
}

// ==================== Plugin (sync) ====================
//
// Registered as a `sync` plugin so the maintenance loop schedules it by
// capability instead of importing syncAllEnabledPlaylists directly. Disabling
// this plugin in the admin UI turns automatic playlist re-sync off; manual
// per-playlist sync (POST /v1/playlists/:id/sync) keeps working.

export const PLAYLIST_SYNC_PLUGIN_ID = "playlist-sync";

export const playlistSyncManifest: PluginManifest = {
  id: PLAYLIST_SYNC_PLUGIN_ID,
  name: "歌单自动同步",
  version: "1.0.0",
  type: "sync",
  description: "定期重新拉取已开启同步的导入歌单,按曲库重建条目并自动匹配在线源",
  capabilities: ["playlistSync"],
  defaultEnabled: true,
  configSchema: [],
  documentation: `### 功能介绍
定期重新拉取「已开启同步」的导入歌单（QQ / 网易等），按当前曲库重建条目，并自动匹配可播放的在线源。

### 处理逻辑
1. 维护定时器按 \`playlistSync\` 能力调用 \`runSyncJob()\`（周期见系统设置）；
2. 遍历所有带 \`sourceUrl\` 且开启同步的歌单，用 \`findUrlImporter(url)\` 反查该链接归属哪个 importer 插件；
3. 交给对应 importer 拉取最新曲目，重建本地条目（保留已收藏 / 已匹配的歌曲，尽量不丢）；
4. 源站失效或没有 importer 认领的歌单跳过，不中断整轮同步。

### 说明
- 只同步「导入」的歌单；手动新建 / 本地歌单不受影响；
- 自动匹配优先用具备 \`autoMatch\` 能力的插件，退而求其次用 \`search\` 能力做匹配。`,
};

export const playlistSyncPlugin: SyncPlugin = {
  manifest: playlistSyncManifest,
  async runSyncJob(): Promise<string | null> {
    const r = await syncAllEnabledPlaylists();
    if (r.synced === 0 && r.errors.length === 0) return null;
    return `synced ${r.synced} playlists, errors: ${r.errors.length}`;
  },
  // 参数化同步能力:路由经 registry 门面调用,核心不直连本文件。
  async syncPlaylist(playlistId: string, opts?: RebuildOptions): Promise<SyncResult> {
    return syncPlaylist(playlistId, opts);
  },
  async rebuildPlaylistEntries(playlistId: string, imported: any, opts?: RebuildOptions): Promise<any> {
    return rebuildPlaylistEntries(playlistId, imported, opts);
  },
  refreshPlaylistCounts(playlistId: string): void {
    refreshPlaylistCounts(playlistId);
  },
  exportPlaylistEntries(playlistId: string): { name: string; tracks: ImportedTrack[] } {
    return exportPlaylistEntries(playlistId);
  },
  checkImportCooldown(userId: string, url: string): boolean {
    return checkImportCooldown(userId, url);
  },
};
