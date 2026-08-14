// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import {
  generateRoamPlaylist,
  ROAM_PLAYLIST_ID,
  ROAM_TAG,
  DAILY_ROAM_PLUGIN_ID,
} from "../../src/services/plugin/dailyRoam.js";
import { FIXED_TODAY_ID } from "../../src/services/plugin/dailyRecommend.js";
import { LOCAL_FIXED_PLAYLIST_ID } from "../../src/services/plugin/localRecommend.js";

// daily-roam「今日漫游」:合并 每日推荐 + 本地推荐 可播放条目,去重重建。
// 源歌单默认取两个固定 id(配置 sourcePlaylists 可改)。

function seedSongs(n: number) {
  const ins = sqlite.prepare("INSERT INTO songs (id, title, artist, album, duration, path, suffix, type, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < n; i++) {
    ins.run(`s${i}`, `Song ${i}`, "Artist", "Album", 200, `l:src:/tmp/s${i}.mp3`, "mp3", "local", new Date().toISOString());
  }
}

// 建一个歌单并加入 [from, to) 歌曲(可指定 playable)
function seedPlaylist(id: string, name: string, from: number, to: number, playable = 1) {
  const owner = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  const now = new Date().toISOString();
  if (!sqlite.prepare("SELECT id FROM playlists WHERE id = ?").get(id)) {
    sqlite.prepare("INSERT INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES (?,?,?,1,?,?,?)")
      .run(id, name, owner.id, "", now, now);
  }
  const ins = sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?,?,?,?,?)");
  for (let i = from; i < to; i++) ins.run(id, `s${i}`, i - from, playable, now);
}

function setRoamConfig(cfg: Record<string, any>) {
  sqlite.prepare("UPDATE plugins SET config = ? WHERE name = ?").run(JSON.stringify(cfg), DAILY_ROAM_PLUGIN_ID);
}

function roamSongIds(): string[] {
  return (sqlite.prepare("SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position").all(ROAM_PLAYLIST_ID) as any[]).map(r => r.song_id);
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

// 每个用例前清空涉及歌单,保证隔离(歌单行保留即可,清 entries)。
beforeEach(() => {
  for (const id of [ROAM_PLAYLIST_ID, FIXED_TODAY_ID, LOCAL_FIXED_PLAYLIST_ID, "pl-x"]) {
    sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(id);
    sqlite.prepare("UPDATE playlists SET song_count = 0, duration = 0, comment = '' WHERE id = ?").run(id);
  }
});

describe("generateRoamPlaylist (今日漫游组合)", () => {
  it("默认合并 每日推荐+本地推荐,跨源去重", () => {
    setRoamConfig({}); // 默认两个固定源
    // 每日推荐:s0..s4;本地推荐:s3..s7(与每日有交集 s3,s4)
    seedPlaylist(FIXED_TODAY_ID, "每日推荐", 0, 5);
    seedPlaylist(LOCAL_FIXED_PLAYLIST_ID, "本地推荐", 3, 8);

    const r = generateRoamPlaylist({ force: true });
    expect(r.skipped).toBe(false);
    expect(r.total).toBe(8); // s0..s7 去重
    const ids = roamSongIds();
    expect(new Set(ids).size).toBe(8);
    expect(ids[0]).toBe("s0"); // 每日推荐在前
    expect(ids).toContain("s3");
    expect(ids).toContain("s7");

    const row = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(ROAM_PLAYLIST_ID) as any;
    expect(row.name).toBe("今日漫游");
    expect(row.song_count).toBe(8);
    expect((row.comment || "").includes(ROAM_TAG)).toBe(true);
  });

  it("只合并可播放条目(playable=0 的跳过)", () => {
    setRoamConfig({});
    seedPlaylist(FIXED_TODAY_ID, "每日推荐", 0, 3, 1);
    seedPlaylist(LOCAL_FIXED_PLAYLIST_ID, "本地推荐", 1, 5, 0); // 全部不可播
    const r = generateRoamPlaylist({ force: true });
    expect(r.total).toBe(3); // 只来自每日推荐
    const ids = roamSongIds();
    expect(ids).toEqual(["s0", "s1", "s2"]);
  });

  it("当天幂等:同一天第二次 skipped=true", () => {
    const r = generateRoamPlaylist(); // 不带 force,同一天已生成过
    expect(r.skipped).toBe(true);
  });

  it("force 强制重建(跳过幂等)", () => {
    setRoamConfig({});
    seedPlaylist(FIXED_TODAY_ID, "每日推荐", 0, 3);
    seedPlaylist(LOCAL_FIXED_PLAYLIST_ID, "本地推荐", 1, 4);
    const r = generateRoamPlaylist({ force: true });
    expect(r.skipped).toBe(false);
    expect(r.total).toBeGreaterThan(0);
    // 同一天再 force 一次仍可重建(幂等被跳过)
    const r2 = generateRoamPlaylist({ force: true });
    expect(r2.skipped).toBe(false);
  });

  it("自定义 sourcePlaylists 配置生效", () => {
    seedPlaylist("pl-x", "自定义源", 10, 12);
    setRoamConfig({ sourcePlaylists: ["pl-x"] });
    const r = generateRoamPlaylist({ force: true });
    expect(r.skipped).toBe(false);
    expect(roamSongIds()).toEqual(["s10", "s11"]);
  });

  it("源歌单全为空:保留旧内容,skipped=true", () => {
    // 先把内容清空
    sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id IN (?, ?)").run(FIXED_TODAY_ID, LOCAL_FIXED_PLAYLIST_ID);
    setRoamConfig({});
    const r = generateRoamPlaylist({ force: true });
    expect(r.skipped).toBe(true); // 无可播放内容,保留旧歌单不重建
  });

  it("封面从自身合并歌曲中随机抽取(有封面的歌)", () => {
    setRoamConfig({});
    // 给源歌单歌曲设置封面
    sqlite.prepare("UPDATE songs SET cover_art = ? WHERE id IN ('s0','s1','s2')").run("al-roam-cover");
    seedPlaylist(FIXED_TODAY_ID, "每日推荐", 0, 3);
    seedPlaylist(LOCAL_FIXED_PLAYLIST_ID, "本地推荐", 3, 5);
    const r = generateRoamPlaylist({ force: true });
    expect(r.skipped).toBe(false);
    const row = sqlite.prepare("SELECT cover_art FROM playlists WHERE id = ?").get(ROAM_PLAYLIST_ID) as any;
    // 合并结果含 s0/s1/s2(带封面)→ 封面必须来自自身歌曲
    expect(row.cover_art).toBe("al-roam-cover");
    sqlite.prepare("UPDATE songs SET cover_art = NULL WHERE cover_art = 'al-roam-cover'").run();
  });

  it("自身歌曲无封面时封面留空(不报错)", () => {
    setRoamConfig({});
    seedPlaylist(FIXED_TODAY_ID, "每日推荐", 0, 2);
    const r = generateRoamPlaylist({ force: true });
    expect(r.skipped).toBe(false);
    const row = sqlite.prepare("SELECT cover_art FROM playlists WHERE id = ?").get(ROAM_PLAYLIST_ID) as any;
    expect(row.cover_art).toBeNull();
  });

  it("封面确定性:同内容重复生成封面不变(不再随机抖动)", () => {
    setRoamConfig({});
    sqlite.prepare("UPDATE songs SET cover_art = ? WHERE id IN ('s0','s1','s2')").run("al-stable");
    seedPlaylist(FIXED_TODAY_ID, "每日推荐", 0, 3);
    seedPlaylist(LOCAL_FIXED_PLAYLIST_ID, "本地推荐", 3, 5);
    generateRoamPlaylist({ force: true });
    const first = (sqlite.prepare("SELECT cover_art FROM playlists WHERE id = ?").get(ROAM_PLAYLIST_ID) as any).cover_art;
    generateRoamPlaylist({ force: true }); // 同内容再刷一次(force)
    const second = (sqlite.prepare("SELECT cover_art FROM playlists WHERE id = ?").get(ROAM_PLAYLIST_ID) as any).cover_art;
    expect(first).toBe("al-stable"); // 取第一首有封面的歌(s0)
    expect(second).toBe(first);      // 内容没变 → 封面必须不变
    sqlite.prepare("UPDATE songs SET cover_art = NULL WHERE cover_art = 'al-stable'").run();
  });
});
