// Unit tests for services/source/online/service.ts importOnlineSongs —
// the batch-import fast path used by go-music-dl 歌单/私人歌单导入.
//   - 批量去重:同一列表内 fingerprint 相同只落一条,songsOut 含去重后的歌
//   - artist/album 批量解析:列表内重复歌手/专辑只建一行(不再逐首 SELECT/INSERT)
//   - 计数刷新:入库后 album.song_count/duration、artist.album_count 用聚合 SQL 正确更新
// 注意:vitest sequence.shuffle 打乱文件内测试顺序,故每个用例都 self-contained
// (beforeEach 清理各自数据),不依赖执行顺序/遗留行。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { songs, artists, albums, users } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import { importOnlineSongs, importOnlineSong } from "../../../src/services/source/online/service.js";

const PROVIDER = "go-music-dl";
const USER = "import-batch-test-user";
const TEST_ARTISTS = ["批量歌手", "另一歌手"];
const TEST_ALBUMS = ["同名专辑", "另张专辑"];

const manifestOf = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["search", "stream"],
  platforms: ["netease", "qq"],
  configSchema: [],
  permissions: ["net"],
} as const;

const provider = {
  id: PROVIDER,
  manifest: manifestOf,
  search: async () => ({ songs: [] }),
  streamUrl: (_config: any, song: any) =>
    `http://gm:18080/music/download?id=${song.id}&source=${song.source}&name=${encodeURIComponent(song.name)}`,
};

function resetRows() {
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  for (const a of TEST_ALBUMS) sqlite.prepare("DELETE FROM albums WHERE name = ?").run(a);
  for (const a of TEST_ARTISTS) sqlite.prepare("DELETE FROM artists WHERE name = ?").run(a);
}

beforeAll(() => {
  initDatabase();
  registerPlugin(manifestOf as any, provider);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config, manifest = excluded.manifest
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), JSON.stringify({}), new Date().toISOString(), new Date().toISOString());
  db.insert(users).values({ id: USER, username: "import-batch", password: "x", salt: "x", subsonicSalt: "x" }).run();
});

beforeEach(() => resetRows());

afterAll(() => {
  resetRows();
  sqlite.prepare("DELETE FROM users WHERE id = ?").run(USER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

describe("importOnlineSongs — 批量导入(歌单/私人歌单路径)", () => {
  it("列表内重复 fingerprint 只落一条;重复歌手/专辑只建一行;计数聚合更新", async () => {
    const res = await importOnlineSongs(PROVIDER, [
      { id: "a1", source: "netease", name: "歌1", artist: "批量歌手", album: "同名专辑", duration: 180, cover: "" },
      { id: "a2", source: "netease", name: "歌2", artist: "批量歌手", album: "同名专辑", duration: 200, cover: "" },
      { id: "a2", source: "netease", name: "歌2", artist: "批量歌手", album: "同名专辑", duration: 200, cover: "" }, // a2 重复
    ]);

    expect(res.added).toBe(2);
    expect(res.deduped).toBe(1);
    expect(res.failed).toBe(0);
    // songsOut 每输入行一条(含去重重复行,均指向既有 songId),唯一指纹 2 个
    expect(res.songs.map((s) => s.fingerprint).sort()).toEqual([
      "go-music-dl:netease:a1",
      "go-music-dl:netease:a2",
      "go-music-dl:netease:a2",
    ]);
    expect(new Set(res.songs.map((s) => s.fingerprint)).size).toBe(2);
    expect(new Set(res.songs.map((s) => s.id)).size).toBe(2);

    // 歌手只建一行
    const artistRows = db.select().from(artists).where(eq(artists.name, "批量歌手")).all();
    expect(artistRows.length).toBe(1);
    expect(artistRows[0].albumCount).toBe(1);

    // 专辑只建一行,计数用聚合 SQL 刷新(song_count=2, duration=180+200=380)
    const albumRows = db.select().from(albums).where(eq(albums.name, "同名专辑")).all();
    expect(albumRows.length).toBe(1);
    expect(albumRows[0].songCount).toBe(2);
    expect(albumRows[0].duration).toBe(380);

    // 两首歌共享同一 artistId/albumId
    const songRows = db.select().from(songs).where(eq(songs.pluginEntry, PROVIDER)).all();
    expect(songRows.length).toBe(2);
    expect(songRows.every((s) => s.artistId === artistRows[0].id)).toBe(true);
    expect(songRows.every((s) => s.albumId === albumRows[0].id)).toBe(true);
  });

  it("不同歌手/专辑各建独立行,album_count 分别计数", async () => {
    const res = await importOnlineSongs(PROVIDER, [
      { id: "b1", source: "netease", name: "歌X", artist: "批量歌手", album: "同名专辑", duration: 100, cover: "" },
      { id: "b2", source: "qq", name: "歌Y", artist: "另一歌手", album: "另张专辑", duration: 50, cover: "" },
    ]);

    expect(res.added).toBe(2);
    expect(res.deduped).toBe(0);
    expect(res.failed).toBe(0);

    expect((db.select().from(artists).where(eq(artists.name, "批量歌手")).get() as any).albumCount).toBe(1);
    expect((db.select().from(artists).where(eq(artists.name, "另一歌手")).get() as any).albumCount).toBe(1);

    expect((db.select().from(albums).where(eq(albums.name, "同名专辑")).get() as any).songCount).toBe(1);
    expect((db.select().from(albums).where(eq(albums.name, "同名专辑")).get() as any).duration).toBe(100);
    expect((db.select().from(albums).where(eq(albums.name, "另张专辑")).get() as any).songCount).toBe(1);
    expect((db.select().from(albums).where(eq(albums.name, "另张专辑")).get() as any).duration).toBe(50);
  });
});

describe("importOnlineSong — 单曲路径逐个 refresh", () => {
  it("插入单曲后 album/artist 计数即时刷新", async () => {
    const r = await importOnlineSong(PROVIDER, {
      id: "c1", source: "netease", name: "歌z", artist: "另一歌手", album: "另张专辑", duration: 10, cover: "",
    });
    expect(r.success).toBe(true);
    expect(r.deduped).toBe(false);

    const album = db.select().from(albums).where(eq(albums.name, "另张专辑")).get();
    expect(album?.songCount).toBe(1);
    expect(album?.duration).toBe(10);

    const artist = db.select().from(artists).where(eq(artists.name, "另一歌手")).get();
    expect(artist?.albumCount).toBe(1);
  });
});