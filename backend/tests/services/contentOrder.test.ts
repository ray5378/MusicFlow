// resolveContentSongs 顺序契约守卫。
//
// 背景(2026-09-10)：`POST /v1/play {peerId, type, id, startIndex}` 与「音流」content
// 节点都按 **startIndex 取第 N 首**，该索引来自调用方看到的行序。歌单行序的权威是
// `/rest/api/v1/playlists/:id/tracks` 的 `orderBy(playlistSongs.position, id)`。
// 而 resolveContentSongs 的 playlist 分支此前**没有 ORDER BY**，SQLite 返回 rowid 序
// (插入序)。两者一旦不一致就是**静默播错歌**——且 /v1/play 的 startIndex 越界会
// 静默归 0，不给任何提示。真实环境实测：24 个歌单抽样 6 个「同集异序」(集合相同、
// 顺序不同)，长度校验一个都抓不到(长度相同)。album/artist/genre 分支本来都有 ORDER BY。
//
// 本测试构造 position 序 ≠ 插入序(rowid 序)的数据，锁死「必须按 position 返回」。
// 删掉 content.ts 里的 orderBy 即红。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { db, initDatabase, sqlite } from "../../src/db/index.js";
import { resolveContentSongs } from "../../src/services/content.js";

const PL_ID = "pl-order-guard";
const AL_ID = "al-order-guard";
const AR_ID = "ar-order-guard";
const OWNER = "u-order";

/** songs 表最小可用行(必填: id/title/path)。 */
function seedSong(
  id: string,
  title: string,
  opts: { albumId?: string; artistId?: string; track?: number; discNumber?: number } = {},
) {
  sqlite
    .prepare(
      "INSERT OR REPLACE INTO songs (id, title, artist, album_id, artist_id, track, disc_number, duration, path, suffix, type) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      title,
      "测试歌手",
      opts.albumId ?? null,
      opts.artistId ?? null,
      opts.track ?? null,
      opts.discNumber ?? null,
      200,
      `l:src:/tmp/${id}.mp3`,
      "mp3",
      "local",
    );
}

function seedPlaylistEntry(songId: string, position: number, playable = 1) {
  sqlite
    .prepare(
      "INSERT INTO playlist_songs (playlist_id, song_id, position, playable) VALUES (?,?,?,?)",
    )
    .run(PL_ID, songId, position, playable);
}

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(PL_ID);
  sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(PL_ID);
  sqlite.prepare("DELETE FROM songs WHERE id LIKE 'sg-%'").run();
  sqlite.prepare("DELETE FROM albums WHERE id = ?").run(AL_ID);
  sqlite.prepare("DELETE FROM artists WHERE id = ?").run(AR_ID);
  sqlite.prepare("DELETE FROM users WHERE id = ?").run(OWNER);
});

describe("resolveContentSongs 顺序契约", () => {
  it("歌单：按 position 返回，而非插入序(rowid)", async () => {
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO users (id, username, password, salt, subsonic_salt) VALUES (?,?,?,?,?)",
      )
      .run(OWNER, OWNER, "x", "x", "x");
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO playlists (id, name, owner_id, source_url, source_platform, song_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(PL_ID, "顺序契约歌单", OWNER, "https://test/pl", "qq", 3, new Date().toISOString(), new Date().toISOString());

    // 关键：**插入序(rowid)与 position 序刻意相反**。
    // 若查询没有 ORDER BY，SQLite 按 rowid 返回 → 得到 C, B, A（与 position 序相反）。
    seedSong("sg-a", "A");
    seedSong("sg-b", "B");
    seedSong("sg-c", "C");
    seedPlaylistEntry("sg-a", 2);
    seedPlaylistEntry("sg-b", 1);
    seedPlaylistEntry("sg-c", 0);

    const res = await resolveContentSongs("playlist", PL_ID);
    expect(res).not.toBeNull();
    // position 升序 → C(pos0), B(pos1), A(pos2)
    expect(res!.rows.map((r: any) => r.id)).toEqual(["sg-c", "sg-b", "sg-a"]);
  });

  it("歌单：不可播条目被剔除，但顺序仍按 position", async () => {
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO users (id, username, password, salt, subsonic_salt) VALUES (?,?,?,?,?)",
      )
      .run(OWNER, OWNER, "x", "x", "x");
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO playlists (id, name, owner_id, source_url, source_platform, song_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(PL_ID, "含不可播条目", OWNER, "https://test/pl", "qq", 3, new Date().toISOString(), new Date().toISOString());

    seedSong("sg-a", "A");
    seedSong("sg-b", "B");
    seedSong("sg-c", "C");
    seedPlaylistEntry("sg-a", 0);
    seedPlaylistEntry("sg-b", 1, 0); // 不可播 → 必须被剔除
    seedPlaylistEntry("sg-c", 2);

    const res = await resolveContentSongs("playlist", PL_ID);
    expect(res!.rows.map((r: any) => r.id)).toEqual(["sg-a", "sg-c"]);
  });

  it("专辑：按 discNumber, track 返回", async () => {
    // albums.artist_id 有 FK，先建艺术家行。
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO artists (id, name, created_at, updated_at) VALUES (?,?,?,?)",
      )
      .run(AR_ID, "测试歌手", new Date().toISOString(), new Date().toISOString());
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO albums (id, name, artist, artist_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(AL_ID, "顺序契约专辑", "测试歌手", AR_ID, new Date().toISOString(), new Date().toISOString());

    // 插入序 = 1,3,2；期望序 = track 1,2,3
    seedSong("sg-t1", "T1", { albumId: AL_ID, track: 1, discNumber: 1 });
    seedSong("sg-t3", "T3", { albumId: AL_ID, track: 3, discNumber: 1 });
    seedSong("sg-t2", "T2", { albumId: AL_ID, track: 2, discNumber: 1 });

    const res = await resolveContentSongs("album", AL_ID);
    expect(res!.rows.map((r: any) => r.id)).toEqual(["sg-t1", "sg-t2", "sg-t3"]);
  });

  it("歌曲：按 id 精确解析单曲", async () => {
    seedSong("sg-one", "单曲");
    const res = await resolveContentSongs("song", "sg-one");
    expect(res).not.toBeNull();
    expect(res!.rows.map((r: any) => r.id)).toEqual(["sg-one"]);
    expect(res!.name).toBe("单曲");
  });

  it("未知类型返回 null(/v1/play 据此回 404)", async () => {
    expect(await resolveContentSongs("nope", "x")).toBeNull();
  });
});

/** 空测试占位守卫：确保 db 已初始化(避免 import 顺序问题导致的隐性跳过)。 */
describe("测试环境自检", () => {
  it("db 可用", () => {
    expect(db).toBeTruthy();
  });
});
