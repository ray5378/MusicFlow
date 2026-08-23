// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import {
  generateRandomSongsPlaylist,
  maybeRefreshRandomSongs,
  RANDOM_PLAYLIST_ID,
  RANDOM_PLUGIN_ID,
  DEFAULT_SONG_COUNT,
} from "../../src/services/plugin/randomSongs.js";

function seedSongs(n: number) {
  const ins = sqlite.prepare("INSERT INTO songs (id, title, artist, album, duration, path, suffix, type, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < n; i++) {
    ins.run(`s${i}`, `Song ${i}`, "Artist", "Album", 200, `l:src:/tmp/s${i}.mp3`, "mp3", "local", new Date().toISOString());
  }
}

function playlistSongIds(): string[] {
  return (sqlite.prepare("SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position").all(RANDOM_PLAYLIST_ID) as any[]).map(r => r.song_id);
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  registerBuiltinPlugins();
  if (!sqlite.prepare("SELECT id FROM users WHERE is_admin=1 LIMIT 1").get()) {
    sqlite.prepare(
      "INSERT INTO users (id, username, password, salt, subsonic_salt, pass_enc, is_admin, is_active, email, created_at, updated_at) VALUES ('u1','admin','','s','ss','',1,1,'a@b.c',?,?)",
    ).run(new Date().toISOString(), new Date().toISOString());
  }
  seedSongs(100);
});

describe("randomSongs 插件", () => {
  it("生成歌单:默认 48 首、全部可播、无重复、字段齐全", () => {
    sqlite.prepare("UPDATE plugins SET config = ? WHERE name = ?").run(JSON.stringify({}), RANDOM_PLUGIN_ID);
    const r = generateRandomSongsPlaylist();
    expect(r).not.toBeNull();
    expect(r!.skipped).toBe(false);
    expect(r!.total).toBe(DEFAULT_SONG_COUNT);

    const pl = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(RANDOM_PLAYLIST_ID) as any;
    expect(pl).toBeTruthy();
    expect(pl.name).toBe("随机歌曲");
    expect(pl.song_count).toBe(DEFAULT_SONG_COUNT);

    const ids = playlistSongIds();
    expect(ids.length).toBe(DEFAULT_SONG_COUNT);
    expect(new Set(ids).size).toBe(ids.length); // 无重复
    // 全部来自曲库
    const rows = sqlite.prepare("SELECT COUNT(*) AS n FROM songs WHERE id IN (" + ids.map(() => "?").join(",") + ")").get(...ids) as any;
    expect(rows.n).toBe(ids.length);
  });

  it("插件已注册为 recommender/recommendPlaylist,可配置数量", () => {
    const row = sqlite.prepare("SELECT enabled, manifest FROM plugins WHERE name = ?").get(RANDOM_PLUGIN_ID) as any;
    expect(row).toBeTruthy();
    expect(row.enabled).toBe(1);
    const manifest = JSON.parse(row.manifest);
    expect(manifest.type).toBe("recommender");
    expect(manifest.capabilities).toContain("recommendPlaylist");
    expect(manifest.homePlaylistId).toBe(RANDOM_PLAYLIST_ID);
    // showOnHome 默认隐藏(false),插件可配置
    const showOnHome = manifest.configSchema.find((f: any) => f.key === "showOnHome");
    expect(showOnHome.default).toBe(false);
    const count = manifest.configSchema.find((f: any) => f.key === "count");
    expect(count.default).toBe(48);
  });

  it("配置 count=10 时歌单生成 10 首", () => {
    sqlite.prepare("UPDATE plugins SET config = ? WHERE name = ?").run(JSON.stringify({ count: 10, refreshMinutes: 30 }), RANDOM_PLUGIN_ID);
    const r = generateRandomSongsPlaylist();
    expect(r!.total).toBe(10);
    expect(playlistSongIds().length).toBe(10);
  });

  it("惰性刷新:刚生成后不重建;改写 refreshMinutes 后重建内容变化", () => {
    // 置为 1 分钟刷新间隔,并先生成一次(updated_at=now)→ 距上次生成 < 1 分钟,不触发。
    sqlite.prepare("UPDATE plugins SET config = ? WHERE name = ?").run(JSON.stringify({ count: 20, refreshMinutes: 1 }), RANDOM_PLUGIN_ID);
    generateRandomSongsPlaylist();
    const triggered = maybeRefreshRandomSongs();
    expect(triggered).toBe(false);

    // 强制把上次生成时间改为很久以前 → 触发重建。
    sqlite.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * 60_000).toISOString(), RANDOM_PLAYLIST_ID);
    const triggered2 = maybeRefreshRandomSongs();
    expect(triggered2).toBe(true);
    expect(playlistSongIds().length).toBe(20);
  });
});
