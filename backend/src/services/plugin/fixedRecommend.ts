// ==================== 固定推荐歌单注册表 ====================
//
// 「今日推荐 / 本地推荐 / 今日漫游」等 recommender 插件在首页展示的歌单使用
// **固定 id**(manifest.homePlaylistId 声明):pl-daily-today / pl-daily-local /
// pl-daily-roam。客户端(音流 Flows / OpenSubsonic / HA 集成)可长期稳定引用,
// 这些 id **永远固定**,不随日期/重建变化(内容每日 UPDATE,id 不变)。
//
// 本模块集中提供:
//   isFixedRecommendPlaylist(id) — 判断某歌单是否固定推荐歌单
//   ensureHomePlaylist(id)       — 歌单缺失/无内容时自动触发生成(自愈,Flows 用)
//
// 契约:
//   - 核心其它代码一律不得写死 pl-daily-* 字面量(check-fixed-playlist-ids.mjs
//     CI 守卫);固定 id 只存在于三个插件服务文件的常量 + 本模块经 manifest 收集;
//   - 固定推荐歌单不可被删除(管理端 / OpenSubsonic DELETE 均拒绝)。

import { getEnabledByCapability } from "../../plugins/registry.js";
import { PluginCapability } from "../../plugins/types.js";
import { runPluginJob } from "./jobRunner.js";
import { sqlite } from "../../db/index.js";
import { sleep } from "./batchPacer.js";
import { FIXED_TODAY_ID } from "./dailyRecommend.js";
import { LOCAL_FIXED_PLAYLIST_ID } from "./localRecommend.js";
import { ROAM_PLAYLIST_ID } from "./dailyRoam.js";
import { RANDOM_PLAYLIST_ID } from "./randomSongs.js";

/** 内置固定推荐歌单(兜底:即使插件未注册/禁用也能识别)。顺序即依赖倾向(漫游依赖前两者)。 */
const BUILTIN_FIXED = [FIXED_TODAY_ID, LOCAL_FIXED_PLAYLIST_ID, ROAM_PLAYLIST_ID, RANDOM_PLAYLIST_ID];
const BUILTIN_FIXED_SET = new Set<string>(BUILTIN_FIXED);

const HOME_RECOMMENDER_CAPS: PluginCapability[] = ["dailyPlaylist", "localPlaylist", "recommendPlaylist"];

/** 某 id 是否固定推荐歌单(内置兜底 + 任意启用插件 manifest.homePlaylistId)。 */
export function isFixedRecommendPlaylist(id: string): boolean {
  if (!id) return false;
  if (BUILTIN_FIXED_SET.has(id)) return true;
  for (const cap of HOME_RECOMMENDER_CAPS) {
    for (const { manifest } of getEnabledByCapability(cap)) {
      if (manifest?.homePlaylistId === id) return true;
    }
  }
  return false;
}

/** 找声明该 homePlaylistId 的推荐插件(启用);无则 null。 */
function findHomePlugin(playlistId: string): any {
  for (const cap of HOME_RECOMMENDER_CAPS) {
    for (const reg of getEnabledByCapability(cap)) {
      if (reg.manifest?.homePlaylistId === playlistId) return reg;
    }
  }
  return null;
}

/** 歌单是否有可播条目(与 resolveContentSongs 同款标准:playable + 已链接歌曲)。 */
function hasPlayableContent(playlistId: string): boolean {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS n FROM playlist_songs ps
    WHERE ps.playlist_id = ? AND ps.playable = 1 AND ps.song_id IS NOT NULL
  `).get(playlistId) as any;
  return !!row && row.n > 0;
}

export interface EnsureResult {
  ok: boolean;
  reason?: string;
  triggered?: boolean;
}

/**
 * 确保固定推荐歌单存在且有可播内容。歌单缺失/为空时:
 *   - 触发声明该歌单的插件 runDailyJob(force) 后台生成;
 *   - 其余内置固定歌单若无内容则顺带非 force 触发(今日漫游依赖今日/本地推荐,
 *     先让源歌单生成,漫游重建才有内容;非 force 有当天幂等,不重复全量);
 *   - 轮询等待目标歌单出现可播条目(默认上限 90s,超时返回原因)。
 * 非固定歌单不做任何生成,直接返回失败。
 */
export async function ensureHomePlaylist(playlistId: string, opts?: { timeoutMs?: number }): Promise<EnsureResult> {
  if (hasPlayableContent(playlistId)) return { ok: true };
  if (!isFixedRecommendPlaylist(playlistId)) return { ok: false, reason: "非固定推荐歌单,不做自动生成" };

  const plugin = findHomePlugin(playlistId);
  if (!plugin || typeof plugin.impl?.runDailyJob !== "function") {
    return { ok: false, reason: "无可用插件生成该歌单(插件未启用?)" };
  }

  // 目标插件 force 重建;其余内置固定歌单顺带非 force 触发(源依赖兜底)。
  runPluginJob(plugin.manifest.id, "runDailyJob", { force: true });
  for (const id of BUILTIN_FIXED) {
    if (id === playlistId || hasPlayableContent(id)) continue;
    const p2 = findHomePlugin(id);
    if (p2 && typeof p2.impl?.runDailyJob === "function") {
      runPluginJob(p2.manifest.id, "runDailyJob", { force: false });
    }
  }

  // 轮询等待目标歌单出现可播条目。
  const deadline = Date.now() + (opts?.timeoutMs ?? 90000);
  while (Date.now() < deadline) {
    await sleep(2000);
    if (hasPlayableContent(playlistId)) return { ok: true, triggered: true };
  }
  return { ok: false, reason: "等待生成超时(推荐歌单仍在后台生成中),可稍后重试", triggered: true };
}
