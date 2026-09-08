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
import { crossVerifySongs } from "../source/online/match.js";
import { replacePlaylistSongs } from "../source/online/recommendImport.js";
import { refreshPlaylistCounts } from "./shared.js";
import { cacheRemoteCover } from "../playlistCover.js";
import { clearLibraryIndex } from "./libraryIndex.js";
import { matchSongsToLibrary } from "./libraryMatch.js";
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
    // 导入命中门禁:上游歌单自带 id/元数据不可信,逐首搜索交叉比对
    // (标题+歌手+专辑+时长全命中才导),拒导的不进歌单。
    const { verified, rejected } = await crossVerifySongs(providerId, config, plugin, list, { interactive: true });

    // 先匹配曲库已有行(方案A,与榜单同步 matchLocal 行为对齐):命中的歌直接
    // 绑旧行、不再插新行——否则已在曲库的歌(指纹含平台外部 id,榜单/歌单两个
    // 接口的 id 不同)会重复入库一行 source=本平台 的 web 行。未命中的才走入库。
    const libHits = matchSongsToLibrary(verified);
    const matchedIds = new Map<number, string>(); // verified 下标 → 已有 songId
    const toImport: typeof verified = [];
    verified.forEach((s, i) => {
      const hit = libHits[i];
      if (hit) matchedIds.set(i, hit);
      else toImport.push(s);
    });

    // 歌曲入库为在线歌曲(可播),返回 { songs, added, deduped, failed }
    const imp = await importOnlineSongs(providerId, toImport, { userId, interactive: true, gate: "verified" });

    // 合成歌单条目(保持原歌单顺序):命中的绑已有行;入库的按 imp.songs 顺序
    // 回填(importOnlineSongs 保序输出成功项,失败项自然跳过)。
    const entries: { id: string; title: string }[] = [];
    let impCursor = 0;
    verified.forEach((s, i) => {
      const hit = matchedIds.get(i);
      if (hit) {
        entries.push({ id: hit, title: s.name });
        return;
      }
      const imported = imp.songs[impCursor++];
      if (imported) entries.push({ id: imported.id, title: imported.title });
    });
    if (!entries.length) {
      throw new Error(
        rejected > 0
          ? `没有歌曲通过导入门禁(标题/歌手/专辑/时长校验),拒导 ${rejected} 首`
          : "歌曲入库失败,请检查在线源配置",
      );
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
      db.update(playlists).set(upd).where(eq(playlists.id, playlistId)).run();
    } else {
      playlistId = `pl-${Date.now()}`;
      db.insert(playlists).values({
        id: playlistId,
        name: fallbackName,
        ownerId: userId || "",
        sourceUrl,
        sourcePlatform: source,
        sourcePlugin: providerId,
        externalId: id,
        coverArt: undefined,
        syncEnabled: 0, // 搜索结果歌单默认不同步;用户可在歌单管理手动开启(由插件能力决定是否支持)
      }).run();
    }

    // 全量替换条目为本次拉取的歌曲(在线歌曲直接关联 songId,可播放;库内命中
    // 的绑已有行)。replacePlaylistSongs 内部会 clearPlaylistCoverCache 清掉旧
    // 封面,故导入封面必须在替换完成之后再缓存/回填,否则刚下载的歌单封面会被
    // 立即清空。
    await replacePlaylistSongs(playlistId, entries);
    refreshPlaylistCounts(playlistId);

    // 歌单封面:远程搜索命中时将该平台封面缓存到本地(失败静默,仍能回退到首曲封面)。
    if (cover) {
      const cached = await cacheRemoteCover(cover, `pl-${playlistId}`, true);
      if (cached) db.update(playlists).set({ coverArt: cached, updatedAt: new Date().toISOString() }).where(eq(playlists.id, playlistId)).run();
    }

    return {
      success: true,
      playlistId,
      name: fallbackName,
      platform: source,
      trackCount: entries.length,
      added: imp.added,
      deduped: imp.deduped,
      libraryMatched: matchedIds.size,
      failed: imp.failed,
      rejected,
      created: !existing,
    };
  } finally {
    clearLibraryIndex(); // 回收曲库索引缓存(避免大歌单残留内存)
    touch(); // 标记活动:搜索歌单/专辑导入
    markInteractiveEnd();
  }
}
