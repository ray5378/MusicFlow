// ==================== Shared remote-playlist import (歌单 / 专辑共用) ====================
//
// 歌单搜索「加入库」与专辑搜索「加入库」是同一套流程:插件 playlistSongs 拉歌曲 →
// importOnlineSongs 入库(可播在线歌曲)→ 以「平台歌单」行 upsert(合成 sourceUrl 幂等,
// 重复导入=增量更新)→ replacePlaylistSongs 全量替换条目 + refreshPlaylistCounts。
//
// 两个入口(playlistSearch.ts 与 entitySearch.ts 的专辑导入)都走这里,消除跨模块重复。
// 核心只按 capability 查插件,不写死插件 id。

import { db } from "../../db/index.js";
import { playlists } from "../../db/schema.js";
import { eq, and } from "drizzle-orm";
import { importOnlineSongs } from "../source/online/service.js";
import { replacePlaylistSongs } from "../source/online/recommendImport.js";
import { refreshPlaylistCounts } from "./shared.js";
import { cacheRemoteCover } from "../playlistCover.js";
import { clearLibraryIndex } from "./libraryIndex.js";
import { markInteractiveStart, markInteractiveEnd } from "./batchPacer.js";
import { touch } from "../memory/reclaim.js";

export interface RemotePlaylistImportInput {
  providerId: string;
  /** 插件 impl 对象(须暴露 playlistSongs(config, source, id)) */
  plugin: any;
  config: Record<string, unknown>;
  userId?: string;
  source: string;
  id: string;
  name?: string;
  cover?: string;
  /** 合成 sourceUrl:幂等 upsert 键。歌单/专辑用不同 scheme(playlist:// vs album://),
   *  避免同一平台下歌单 id 与专辑 id 撞键。 */
  sourceUrl: string;
}

/** 拉取远程歌单/专辑歌曲并入库,以平台歌单形式持久化。返回任务结果(供异步任务回传)。 */
export async function importRemotePlaylistLike(input: RemotePlaylistImportInput): Promise<any> {
  const { providerId, plugin, config, userId, source, id, name, cover, sourceUrl } = input;
  markInteractiveStart(); // 用户交互窗口:后台批量任务让路;自身走 interactive 全速并发
  try {
    const { songs: list } = await plugin.playlistSongs(config, source, id);
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("该歌单没有可导入的歌曲");
    }
    // 歌曲入库为在线歌曲(可播),返回 { songs, added, deduped, failed }
    const imp = await importOnlineSongs(providerId, list, { userId, interactive: true });
    if (!imp?.songs?.length) {
      throw new Error("歌曲入库失败,请检查在线源配置");
    }

    const fallbackName = (name && name.trim()) || `歌单 ${source}/${id}`;
    const existing = db.select().from(playlists)
      .where(and(eq(playlists.sourceUrl, sourceUrl), eq(playlists.ownerId, userId || "")))
      .get();

    let playlistId: string;
    if (existing) {
      playlistId = existing.id;
      const upd: any = { updatedAt: new Date().toISOString() };
      if (name && name.trim()) upd.name = fallbackName;
      if (cover) {
        const cached = await cacheRemoteCover(cover, `pl-${playlistId}`, true);
        if (cached) upd.coverArt = cached;
      }
      db.update(playlists).set(upd).where(eq(playlists.id, playlistId)).run();
    } else {
      playlistId = `pl-${Date.now()}`;
      let coverRef: string | undefined = undefined;
      if (cover) {
        const cached = await cacheRemoteCover(cover, `pl-${playlistId}`);
        if (cached) coverRef = cached;
      }
      db.insert(playlists).values({
        id: playlistId,
        name: fallbackName,
        ownerId: userId || "",
        sourceUrl,
        sourcePlatform: source,
        sourcePlugin: providerId,
        externalId: id,
        coverArt: coverRef,
        syncEnabled: 0, // 搜索结果歌单默认不同步;用户可在歌单管理手动开启(由插件能力决定是否支持)
      }).run();
    }

    // 全量替换条目为本次拉取的歌曲(在线歌曲直接关联 songId,可播放)
    await replacePlaylistSongs(playlistId, imp.songs);
    refreshPlaylistCounts(playlistId);
    return {
      success: true,
      playlistId,
      name: fallbackName,
      platform: source,
      trackCount: imp.songs.length,
      added: imp.added,
      deduped: imp.deduped,
      failed: imp.failed,
      created: !existing,
    };
  } finally {
    clearLibraryIndex(); // 回收曲库索引缓存(避免大歌单残留内存)
    touch(); // 标记活动:搜索歌单/专辑导入
    markInteractiveEnd();
  }
}
