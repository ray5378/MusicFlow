// ==================== Expired web-song purge ====================
//
// Songs imported from an online source (go-music-dl) are stored as songs rows
// with type="web". Without cleanup they accumulate forever — old daily-recommend
// tracks that leave the playlists are never deleted, and neither are their
// cached cover files. This module deletes expired web songs and their covers,
// gated by the source plugin's config:
//
//   webSongsMode: "keep"   (default) — never purge
//   webSongsMode: "rotate"            — purge songs older than
//                                       webSongsRetentionDays days that are no
//                                       longer referenced by any playlist or
//                                       user favorite.
//
// Referenced songs (any playlist, including the combined "今日推荐", or user
// favorites) are always kept regardless of age, so playlists never break.
// Age is measured from the song row's created_at (deduped re-imports reuse the
// same row, so the first-import time is authoritative).

import { sqlite } from "../../../db/index.js";
import { getSourcePluginConfig } from "./index.js";
import { deleteSongCover } from "../../playlistCover.js";
import { cleanupOrphans } from "../scanner.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeResult {
  mode: string;
  retentionDays: number;
  checked: number;
  purged: number;
  covers: number;
  errors: number;
}

/**
 * Delete expired, unreferenced web songs for a source plugin (go-music-dl).
 * No-op unless the plugin config enables rotation (webSongsMode === "rotate").
 */
export function purgeExpiredWebSongs(providerId: string): PurgeResult {
  const config = getSourcePluginConfig(providerId);
  if (!config) {
    return { mode: "unconfigured", retentionDays: 0, checked: 0, purged: 0, covers: 0, errors: 0 };
  }
  const mode = config.webSongsMode === "rotate" ? "rotate" : "keep";
  if (mode !== "rotate") {
    return { mode, retentionDays: 0, checked: 0, purged: 0, covers: 0, errors: 0 };
  }

  const rawDays = Number(config.webSongsRetentionDays);
  const retentionDays = Number.isFinite(rawDays) && rawDays >= 0 ? Math.floor(rawDays) : 7;
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS).toISOString();

  const candidates = sqlite.prepare(`
    SELECT s.id, s.cover_art
    FROM songs s
    WHERE s.type = 'web'
      AND s.plugin_entry = ?
      AND s.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM playlist_songs ps WHERE ps.song_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM user_favorite_songs uf WHERE uf.song_id = s.id)
  `).all(providerId, cutoff) as { id: string; cover_art: string | null }[];

  const delHistory = sqlite.prepare("DELETE FROM play_history WHERE song_id = ?");
  const delSong = sqlite.prepare("DELETE FROM songs WHERE id = ?");

  let purged = 0, covers = 0, errors = 0;
  try {
    const tx = sqlite.transaction((rows: { id: string; cover_art: string | null }[]) => {
      for (const s of rows) {
        // FK-first: dependent rows must go before the song itself.
        delHistory.run(s.id);
        delSong.run(s.id);
      }
    });
    tx(candidates);
    purged = candidates.length;
  } catch (e: any) {
    errors++;
    console.error(`[web-purge] ${providerId} 批量清理失败:`, e?.message || e);
  }

  // Covers only when the DB transaction committed (all-or-nothing), so we never
  // delete cover files of songs that are still in the library.
  if (purged > 0) {
    for (const s of candidates) covers += deleteSongCover(s.id);
    cleanupOrphans();
  }

  if (purged > 0 || errors > 0) {
    console.log(`[web-purge] ${providerId}: mode=${mode} retention=${retentionDays}d checked=${candidates.length} purged=${purged} covers=${covers} errors=${errors}`);
  }
  return { mode, retentionDays, checked: candidates.length, purged, covers, errors };
}
