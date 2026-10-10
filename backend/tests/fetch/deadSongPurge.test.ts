// PATCH21 死链清理测试。
//
// 覆盖：
//   1. 阈值 0 = 关闭；未达阈值不动；
//   2. 达标：移除 web 行 + 歌单条目转未匹配（写明原因码）；
//   3. 快照回填：external_* 缺失时用 songs 行回填 —— 这是「一键在线匹配」能拉回来的前提
//      （match.ts 的候选集正是 `!playable && !songId && externalTitle 非空`）；
//   4. COALESCE 保护：条目原本带的 external_* 不被覆盖；
//   5. 本地/WebDAV 行受保护（有实体文件，绝不由下载流程删），且其台账行被一并清掉；
//   6. 关联清理：收藏 / 播放历史 / 音频分析一并删除（SQLite FK 开启，漏一张就删不掉整首）；
//   7. 幂等：台账行随歌曲一起清掉，二次调用不重复处理。
//
// 库表操作走真实 sqlite（tests/setup.ts 已按文件隔离 DATA_DIR 并建好全量 schema）。
// MUST be the first import。
import "../plugins/_env.js";

import { beforeEach, describe, expect, it } from "vitest";

import { sqlite } from "../../src/db/index.js";
import {
  downloadFailCount,
  ensureDownloadAttemptsTable,
  recordDownloadAttempt,
} from "../../src/services/fetch/attempts.js";
import { DEFAULT_FETCH_CONFIG } from "../../src/services/fetch/config.js";
import { purgeDeadSongs } from "../../src/services/fetch/deadSongPurge.js";

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

const cfgWith = (threshold: number) => ({
  ...DEFAULT_FETCH_CONFIG,
  deadSongPurgeThreshold: threshold,
});

function seedUser(id: string): void {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt) VALUES (?,?,?,?,?)`,
    )
    .run(id, id, "p", "s", "ss");
}

function seedPlaylist(id: string, ownerId: string): void {
  sqlite
    .prepare(`INSERT INTO playlists (id, name, owner_id) VALUES (?,?,?)`)
    .run(id, id, ownerId);
}

interface SongOver {
  type?: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
}

function seedSong(id: string, over: SongOver = {}): void {
  const type = over.type ?? "web";
  sqlite
    .prepare(
      `INSERT INTO songs (id, title, artist, album, duration, path, type) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      over.title ?? "T",
      over.artist ?? "A",
      over.album ?? "AL",
      over.duration ?? 200,
      `${type}:src:/x/${id}.flac`,
      type,
    );
}

interface EntryOver {
  playable?: number;
  externalSongId?: string | null;
  externalTitle?: string | null;
  externalArtist?: string | null;
  externalAlbum?: string | null;
  externalDuration?: number | null;
}

function seedEntry(playlistId: string, songId: string | null, over: EntryOver = {}): number {
  const r = sqlite
    .prepare(
      `INSERT INTO playlist_songs
         (playlist_id, song_id, position, playable,
          external_song_id, external_title, external_artist, external_album, external_duration)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      playlistId,
      songId,
      1,
      over.playable ?? (songId ? 1 : 0),
      over.externalSongId ?? null,
      over.externalTitle ?? null,
      over.externalArtist ?? null,
      over.externalAlbum ?? null,
      over.externalDuration ?? null,
    );
  return Number(r.lastInsertRowid);
}

/** 连续记 N 次永久失败（cooldownDays=0：只记不清）。 */
function failTimes(key: string, n: number, code = "HTTP_404"): void {
  for (let i = 0; i < n; i++) {
    recordDownloadAttempt(key, `b${i}`, "failed", 0, { errorCode: code, permanent: true });
  }
}

const songExists = (id: string): boolean =>
  !!sqlite.prepare(`SELECT id FROM songs WHERE id = ?`).get(id);

const entryOf = (id: number): Record<string, unknown> =>
  sqlite.prepare(`SELECT * FROM playlist_songs WHERE id = ?`).get(id) as Record<string, unknown>;

const countWhere = (sql: string, ...args: unknown[]): number =>
  Number((sqlite.prepare(sql).get(...args) as { n?: unknown } | undefined)?.n ?? 0);

describe("PATCH21 死链清理", () => {
  beforeEach(() => {
    // 台账表是惰性建的（首次 recordDownloadAttempt 才 CREATE），故先 ensure 再清空：
    // 否则前一个用例留下的失败计数会让后续的「候选数」断言失真。
    ensureDownloadAttemptsTable();
    sqlite.prepare(`DELETE FROM fetch_download_attempts`).run();
  });

  it("1. 阈值 0 = 关闭：不碰任何数据", () => {
    const s = uid("off");
    seedSong(s);
    failTimes(s, 3);

    const r = purgeDeadSongs(cfgWith(0));
    expect(r.enabled).toBe(false);
    expect(r.purged).toBe(0);
    expect(songExists(s)).toBe(true);
  });

  it("2. 未达阈值：不动（阈值 2，只失败 1 次）", () => {
    const s = uid("less");
    seedSong(s);
    failTimes(s, 1);

    const r = purgeDeadSongs(cfgWith(2));
    expect(r.purged).toBe(0);
    expect(songExists(s)).toBe(true);
  });

  it("3. 阈值 1：一击即移除 web 行，歌单条目转未匹配并回填快照", () => {
    const u = uid("u");
    const pl = uid("pl");
    seedUser(u);
    seedPlaylist(pl, u);
    const s = uid("dead");
    seedSong(s, { title: "歌名X", artist: "歌手Y", album: "专辑Z", duration: 231 });
    const eid = seedEntry(pl, s, { playable: 1 });

    failTimes(s, 1);

    const r = purgeDeadSongs(cfgWith(1));
    expect(r.purged).toBe(1);
    expect(r.playlistEntries).toBe(1);
    expect(r.details[0]?.songId).toBe(s);
    expect(songExists(s)).toBe(false);

    const e = entryOf(eid);
    expect(e.song_id).toBeNull();
    expect(e.playable).toBe(0);
    expect(String(e.unavailable_reason)).toContain("HTTP_404");
    // 快照回填 —— 「一键在线匹配」能把它拉回来的唯一依据，缺了这条就永远匹配不回来。
    expect(e.external_title).toBe("歌名X");
    expect(e.external_artist).toBe("歌手Y");
    expect(e.external_album).toBe("专辑Z");
    expect(e.external_duration).toBe(231);
  });

  it("4. COALESCE 保护：条目自带 external_* 时不被 songs 行覆盖，缺的才回填", () => {
    const u = uid("u");
    const pl = uid("pl");
    seedUser(u);
    seedPlaylist(pl, u);
    const s = uid("keep");
    seedSong(s, { title: "库内标题", artist: "库内歌手", album: "库内专辑" });
    const eid = seedEntry(pl, s, {
      playable: 1,
      externalTitle: "原有标题",
      externalArtist: "原有歌手",
    });

    failTimes(s, 1);
    expect(purgeDeadSongs(cfgWith(1)).purged).toBe(1);

    const e = entryOf(eid);
    expect(e.external_title).toBe("原有标题"); // 已有 → 保留
    expect(e.external_artist).toBe("原有歌手"); // 已有 → 保留
    expect(e.external_album).toBe("库内专辑"); // 原本为空 → 回填
  });

  it("5. 本地行受保护：不删，且台账行被一并清掉", () => {
    const s = uid("local");
    seedSong(s, { type: "local" });
    failTimes(s, 1);

    const r = purgeDeadSongs(cfgWith(1));
    expect(r.purged).toBe(0);
    expect(r.skippedLocal).toBe(1);
    expect(songExists(s)).toBe(true);
    expect(downloadFailCount(s)).toBe(0);
  });

  it("6. 关联清理：收藏 / 播放历史 / 音频分析一并删除（FK 开启，漏一张整首就删不掉）", () => {
    const u = uid("u");
    const pl = uid("pl");
    seedUser(u);
    seedPlaylist(pl, u);
    const s = uid("cascade");
    seedSong(s);
    sqlite.prepare(`INSERT INTO user_favorite_songs (user_id, song_id) VALUES (?,?)`).run(u, s);
    sqlite.prepare(`INSERT INTO play_history (user_id, song_id) VALUES (?,?)`).run(u, s);
    sqlite.prepare(`INSERT INTO audio_analysis (row_id) VALUES (?)`).run(s);

    failTimes(s, 1);
    const r = purgeDeadSongs(cfgWith(1));

    expect(r.purged).toBe(1);
    expect(countWhere(`SELECT COUNT(*) n FROM user_favorite_songs WHERE song_id = ?`, s)).toBe(0);
    expect(countWhere(`SELECT COUNT(*) n FROM play_history WHERE song_id = ?`, s)).toBe(0);
    expect(countWhere(`SELECT COUNT(*) n FROM audio_analysis WHERE row_id = ?`, s)).toBe(0);
  });

  it("7. 幂等：清理后台账行一并移除，二次调用不再处理", () => {
    const s = uid("idem");
    seedSong(s);
    failTimes(s, 1);

    expect(purgeDeadSongs(cfgWith(1)).purged).toBe(1);
    const r2 = purgeDeadSongs(cfgWith(1));
    expect(r2.candidates).toBe(0);
    expect(r2.purged).toBe(0);
  });

  it("8. 多种 A 类错误码都计入（NO_CANDIDATE / INTEGRITY_FAILED）", () => {
    const a = uid("nc");
    const b = uid("ig");
    seedSong(a);
    seedSong(b);
    failTimes(a, 1, "NO_CANDIDATE");
    failTimes(b, 1, "INTEGRITY_FAILED");

    const r = purgeDeadSongs(cfgWith(1));
    expect(r.purged).toBe(2);
    expect(songExists(a)).toBe(false);
    expect(songExists(b)).toBe(false);
  });
});
