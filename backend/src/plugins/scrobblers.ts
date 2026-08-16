// ==================== Scrobbler plugins ====================
//
// Reports playback events to external services (Last.fm, ListenBrainz, ...).
// The core calls notifyScrobble() from the scrobble REST route; every enabled
// scrobbler plugin with a matching handler receives the event. A scrobbler is
// a thin plugin: it only gets the controlled `host` context and the event.

import { getEnabledByCapability, getPluginConfig } from "./registry.js";
import { createPluginHost } from "./host.js";
import { recordSuccess, recordFailure } from "./health.js";
import type { ScrobbleEvent } from "./types.js";

const APP_VERSION = process.env.APP_VERSION || "dev";

/** All enabled scrobbler plugins. */
export function getScrobblerPlugins(): { id: string; name: string }[] {
  return getEnabledByCapability("scrobbler").map((p) => ({ id: p.manifest.id, name: p.manifest.name }));
}

// ---- 派发去重(防重复上报) ----
// OpenSubsonic 客户端常对同一首歌连发多个 /scrobble(now-playing 多发、
// submission 偶发重复)。播放历史(playHistory)只在 DB 写入时去重,挡不住
// 插件派发——若不做这层去重,每次调用都会真实地把一条 single/playing_now
// 提交到 Last.fm / ListenBrainz,造成重复收听记录。这里按「用户+歌曲+阶段」
// 在窗口内只放行一次派发。
// - scrobble(正式收听):与播放历史去重窗口一致(10 分钟),保证每曲每窗口
//   最多一条 single —— 直接根治「播放记录重复上传」。
// - play(正在播放):60s 窗口压掉客户端连发/断线重连的 now-playing 风暴
//   (ListenBrainz 端 playing_now 是瞬时态,少报无副作用,多报无意义)。
// 内存态即可:重启后最多多报一次,可接受(不追求跨重启记忆)。
const SCROBBLE_DEDUPE_MS = 10 * 60 * 1000; // 与 rest 路由 HISTORY_DEDUPE_WINDOW_MS 对齐
const PLAY_DEDUPE_MS = 60 * 1000;
const scrobbleDispatched = new Map<string, number>();
const playDispatched = new Map<string, number>();

function dedupeMark(map: Map<string, number>, key: string, windowMs: number): boolean {
  const now = Date.now();
  // 惰性 GC:顺带清掉超出窗口的旧键,防长期运行内存膨胀。
  for (const [k, t] of map) if (now - t > windowMs) map.delete(k);
  if (map.has(key)) return false; // 窗口内已派发过 → 本次跳过
  map.set(key, now);
  return true;
}

/**
 * 正式收听派发去重:同一用户同一首歌在 10 分钟内只放行一次 onScrobble 派发。
 * @returns true = 本次应派发(且已记账);false = 窗口内已派发过,调用方应跳过。
 */
export function dedupeScrobbleDispatch(userId: string, songId: string): boolean {
  return dedupeMark(scrobbleDispatched, `${userId}:${songId}`, SCROBBLE_DEDUPE_MS);
}

/**
 * 「正在播放」派发去重:同一用户同一首歌 60s 内只放行一次 onPlay 派发。
 * @returns true = 本次应派发(且已记账);false = 窗口内已派发过,调用方应跳过。
 */
export function dedupePlayDispatch(userId: string, songId: string): boolean {
  return dedupeMark(playDispatched, `${userId}:${songId}`, PLAY_DEDUPE_MS);
}

/**
 * Dispatch a playback event to all enabled scrobblers.
 * @param phase "play" → onPlay, "scrobble" → onScrobble
 */
export async function notifyScrobble(phase: "play" | "scrobble", event: ScrobbleEvent): Promise<void> {
  const handler = phase === "play" ? "onPlay" : "onScrobble";
  for (const { manifest, impl } of getEnabledByCapability("scrobbler")) {
    if (typeof impl?.[handler] !== "function") continue;
    const cfg = getPluginConfig(manifest.id) || {};
    const host = createPluginHost(manifest, cfg, APP_VERSION);
    try {
      await impl[handler](host, event);
      recordSuccess(manifest.id);
    } catch (e: any) {
      recordFailure(manifest.id, e?.message || String(e));
      console.error(`[scrobbler] ${manifest.id} ${handler} failed:`, e?.message || e);
    }
  }
}
