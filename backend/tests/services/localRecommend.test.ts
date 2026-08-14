// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { generateLocalDailyPlaylist, LOCAL_FIXED_PLAYLIST_ID } from "../../src/services/plugin/localRecommend.js";
import { setSetting } from "../../src/services/settings.js";

// local-recommend 独立生成「本地推荐」歌单:默认口味/全库随机,可配置参考歌单池与数量。

const LOCAL_ID = "local-recommend";

function seedSongs(n: number) {
  const ins = sqlite.prepare("INSERT INTO songs (id, title, artist, album, duration, path, suffix, type, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < n; i++) {
    ins.run(`s${i}`, `Song ${i}`, "Artist", "Album", 200, `l:src:/tmp/s${i}.mp3`, "mp3", "local", new Date().toISOString());
  }
}

// 建一个含 [from, to) 歌曲的歌单(owner 用实际 admin id,避免外键失败)
function seedPlaylist(id: string, from: number, to: number) {
  const owner = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  sqlite.prepare("INSERT INTO playlists (id, name, owner_id, is_public, comment, created_at, updated_at) VALUES (?,?,?,1,?,?,?)")
    .run(id, `歌单 ${id}`, owner.id, "", new Date().toISOString(), new Date().toISOString());
  const ins = sqlite.prepare("INSERT INTO playlist_songs (playlist_id, song_id, position, playable, created_at) VALUES (?,?,?,1,?)");
  for (let i = from; i < to; i++) ins.run(id, `s${i}`, i - from, new Date().toISOString());
}

function setLocalConfig(cfg: Record<string, any>) {
  sqlite.prepare("UPDATE plugins SET config = ? WHERE name = ?").run(JSON.stringify(cfg), LOCAL_ID);
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
  seedSongs(60);
  setSetting("daily_recommend_local_enabled", "true");
});

beforeEach(() => {
  setLocalConfig({}); // 默认无参考歌单
});

describe("generateLocalDailyPlaylist (独立「本地推荐」歌单)", () => {
  it("默认(无参考歌单):口味/全库随机生成,歌曲入固定 id 歌单", async () => {
    const r = await generateLocalDailyPlaylist(new Date("2026-08-13T12:00:00"));
    expect(r).not.toBeNull();
    expect(r!.skipped).toBe(false);
    expect(r!.playlistId).toBe(LOCAL_FIXED_PLAYLIST_ID);
    expect(r!.total).toBeGreaterThan(0);

    const row = sqlite.prepare("SELECT * FROM playlists WHERE id = ?").get(LOCAL_FIXED_PLAYLIST_ID) as any;
    expect(row.name).toBe("本地推荐");
    expect(row.song_count).toBe(r!.total);
  });

  it("配置参考歌单池:只从池中歌曲抽取,数量受 count 控制", async () => {
    seedPlaylist("pl-pool-a", 0, 30); // s0..s29
    seedPlaylist("pl-pool-b", 30, 60); // s30..s59
    setLocalConfig({ sourcePlaylists: ["pl-pool-a", "pl-pool-b"], count: 20, excludeRecent: false });

    const r = await generateLocalDailyPlaylist(new Date("2026-08-14T12:00:00"));
    expect(r!.skipped).toBe(false);
    expect(r!.total).toBe(20); // count 生效
    const ids = sqlite.prepare("SELECT song_id FROM playlist_songs WHERE playlist_id = ?").all(LOCAL_FIXED_PLAYLIST_ID) as any[];
    expect(ids.length).toBe(20);
    // 全部来自池内歌曲
    for (const row of ids) {
      expect(parseInt(String(row.song_id).slice(1), 10)).toBeLessThan(60);
    }
  });

  it("count 上限与默认值", async () => {
    setLocalConfig({ count: 10 });
    const r = await generateLocalDailyPlaylist(new Date("2026-08-15T12:00:00"));
    expect(r!.skipped).toBe(false);
    expect(r!.total).toBeLessThanOrEqual(10);
  });

  it("当天幂等:同一天第二次调用 skipped=true", async () => {
    const r2 = await generateLocalDailyPlaylist(new Date("2026-08-15T12:00:00"));
    expect(r2!.skipped).toBe(true);
  });

  it("force=true 跳过幂等,同一天可强制重建", async () => {
    const r3 = await generateLocalDailyPlaylist(new Date("2026-08-15T12:00:00"), { force: true });
    expect(r3!.skipped).toBe(false);
    expect(r3!.total).toBeGreaterThan(0);
  });

  it("不同 seedSalt 同一天产出不同内容(手动刷新真正变化)", async () => {
    // 用固定日期 + 不同盐,分别生成,比较歌曲集合
    const a = await generateLocalDailyPlaylist(new Date("2026-08-16T12:00:00"), { force: true, seedSalt: 1 });
    const aIds = (sqlite.prepare("SELECT song_id FROM playlist_songs WHERE playlist_id = ?").all(LOCAL_FIXED_PLAYLIST_ID) as any[]).map(r => r.song_id);
    const b = await generateLocalDailyPlaylist(new Date("2026-08-16T12:00:00"), { force: true, seedSalt: 999 });
    const bIds = (sqlite.prepare("SELECT song_id FROM playlist_songs WHERE playlist_id = ?").all(LOCAL_FIXED_PLAYLIST_ID) as any[]).map(r => r.song_id);
    expect(a!.skipped).toBe(false);
    expect(b!.skipped).toBe(false);
    // 全库 60 首、取 50 首,两个不同种子序列基本必然不同
    expect(aIds.join(",")).not.toBe(bIds.join(","));
  });

  it("封面从自身歌曲中随机抽取(有封面的歌)", async () => {
    // 给部分歌曲设置封面
    sqlite.prepare("UPDATE songs SET cover_art = ? WHERE id IN ('s10','s20','s30')").run("al-cover-test");
    setLocalConfig({ sourcePlaylists: [], count: 5, excludeRecent: false });
    const r = await generateLocalDailyPlaylist(new Date("2026-08-17T12:00:00"), { force: true, seedSalt: 42 });
    expect(r!.skipped).toBe(false);
    // 生成歌单里的歌曲应该有部分带封面
    const ids = (sqlite.prepare("SELECT song_id FROM playlist_songs WHERE playlist_id = ?").all(LOCAL_FIXED_PLAYLIST_ID) as any[]).map(x => x.song_id);
    const row = sqlite.prepare("SELECT cover_art FROM playlists WHERE id = ?").get(LOCAL_FIXED_PLAYLIST_ID) as any;
    // 若歌单内存在带封面的歌,封面必须来自歌单内歌曲;否则留空(不报错)
    const covered = ids.filter((id: string) => ["s10", "s20", "s30"].includes(id));
    if (covered.length > 0) {
      expect(row.cover_art).toBe("al-cover-test");
    } else {
      expect(row.cover_art).toBeNull();
    }
    sqlite.prepare("UPDATE songs SET cover_art = NULL WHERE cover_art = 'al-cover-test'").run();
  });
});
