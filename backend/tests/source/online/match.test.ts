// Unit tests for services/source/online/match.ts — P0「已知平台 id 直通」。
//   - onlineSongFromExternalId:source:id 解析(有效格式/非法格式)
//   - matchUnmatchedPlaylistEntries:已知 source:id 的条目免搜索直通导入并链接;
//     无 source:id 的条目仍走在线搜索(调用次数可验证)。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { eq, and } from "drizzle-orm";
import { songs, playlists, playlistSongs, users } from "../../../src/db/schema.js";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import {
  onlineSongFromExternalId,
  matchUnmatchedPlaylistEntries,
  searchBestMatch,
} from "../../../src/services/source/online/match.js";

const PROVIDER = "go-music-dl";
const USER = "match-test-user";
const PL = "pl-match-test";

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

const fakeConfig = { baseUrl: "http://gm:18080" };

function enableProvider() {
  const searchCalls: string[] = [];
  const provider = {
    id: PROVIDER,
    manifest: manifestOf,
    search: async (_config: any, params: any) => {
      searchCalls.push(params.query || "");
      return { songs: [] };
    },
    streamUrl: (_config: any, song: any) =>
      `http://gm:18080/music/download?id=${song.id}&source=${song.source}&name=${encodeURIComponent(song.name)}`,
  };
  registerPlugin(manifestOf as any, provider);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config, manifest = excluded.manifest
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), JSON.stringify(fakeConfig), new Date().toISOString(), new Date().toISOString());
  return { searchCalls, provider };
}

function resetRows() {
  sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(PL);
  sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(PL);
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM users WHERE id = ?").run(USER);
}

function seed(entries: { id: string; title: string; artist: string; extId: string | null }[]) {
  db.insert(users).values({ id: USER, username: "match-test", password: "x", salt: "x", subsonicSalt: "x" }).run();
  db.insert(playlists).values({ id: PL, name: "match-test", ownerId: USER, createdAt: new Date().toISOString() }).run();
  entries.forEach((e, i) => {
    db.insert(playlistSongs).values({
      playlistId: PL,
      position: i,
      playable: 0,
      songId: null,
      externalSongId: e.extId,
      externalTitle: e.title,
      externalArtist: e.artist,
      externalDuration: 180000,
    }).run();
  });
}

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  resetRows();
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

describe("onlineSongFromExternalId", () => {
  it("解析合法 source:id 并映射字段(时长 ms→s)", () => {
    const s = onlineSongFromExternalId({
      externalSongId: "netease:123456",
      externalTitle: "T",
      externalArtist: "A",
      externalAlbum: "AL",
      externalDuration: 180000,
    });
    expect(s).toEqual({
      id: "123456",
      source: "netease",
      name: "T",
      artist: "A",
      album: "AL",
      duration: 180,
      cover: "",
    });
  });

  it("非法格式返回 null(走搜索兜底)", () => {
    for (const bad of [null, "", "no-colon", ":id", "netease:", "has space:1", "http://x/y", "a.b:c"]) {
      expect(onlineSongFromExternalId({ externalSongId: bad, externalTitle: "T", externalArtist: "A" }), `input=${bad}`).toBeNull();
    }
  });
});

describe("matchUnmatchedPlaylistEntries — 已知 source:id 直通", () => {
  it("已知 source:id 条目免搜索直通导入并链接;无 id 条目仍走搜索", async () => {
    const { searchCalls, provider } = enableProvider();
    seed([
      { id: "k1", title: "直通曲", artist: "直通人", extId: "netease:111" },
      { id: "k2", title: "未知曲", artist: "未知人", extId: "ext-only" }, // 非 source:id → 走搜索
    ]);

    const res = await matchUnmatchedPlaylistEntries(PROVIDER, fakeConfig, provider as any, PL);

    // 直通条目:matched 且不触发搜索
    const known = res.results.find((r) => r.entryId === (db.select().from(playlistSongs).where(and(eq(playlistSongs.playlistId, PL), eq(playlistSongs.externalSongId, "netease:111"))).get() as any).id);
    expect(known?.status).toBe("matched");

    // 无 id 条目:走了搜索(调用 1 次,空结果 → no-match)
    expect(searchCalls.length).toBe(1);
    expect(searchCalls[0]).toContain("未知曲");
    const unknown = res.results.find((r) => r.status === "no-match");
    expect(unknown).toBeTruthy();

    // 直通条目已链接为可播 + 歌曲落库(fingerprint/streamUrl 正确构造)
    const row = db.select().from(playlistSongs).where(and(eq(playlistSongs.playlistId, PL), eq(playlistSongs.externalSongId, "netease:111"))).get() as any;
    expect(row.playable).toBe(1);
    expect(row.songId).toBeTruthy();
    const song = db.select().from(songs).where(eq(songs.id, row.songId)).get() as any;
    expect(song).toBeTruthy();
    expect(song.fingerprint).toBe("go-music-dl:netease:111");
    expect(song.title).toBe("直通曲");
    expect(song.artist).toBe("直通人");
    expect(song.duration).toBe(180);
    expect(song.url).toBe("http://gm:18080/music/download?id=111&source=netease&name=%E7%9B%B4%E9%80%9A%E6%9B%B2");
    expect(song.type).toBe("web");

    resetRows();
  });
});

describe("searchBestMatch — 同名异曲(歌手不符)拒绑", () => {
  function providerReturning(cands: any[]) {
    return {
      id: PROVIDER,
      manifest: manifestOf,
      search: async (_config: any, _params: any) => ({ songs: cands }),
      streamUrl: (_config: any, s: any) => `http://gm:18080/music/download?id=${s.id}&source=${s.source}`,
    };
  }

  it("标题命中但歌手不符 → no-match(不把同名异曲误绑进歌单)", async () => {
    const provider = providerReturning([
      { id: "r1", source: "netease", name: "同名曲", artist: "不同人", duration: 180 },
    ]);
    const m = await searchBestMatch(PROVIDER, fakeConfig, provider as any, {
      entryId: 1, title: "同名曲", artist: "期望歌手", duration: 180000,
    });
    expect(m.status).toBe("no-match");
  });

  it("标题+歌手一致 → matched", async () => {
    const provider = providerReturning([
      { id: "r2", source: "netease", name: "同名曲", artist: "期望歌手", duration: 180 },
    ]);
    const m = await searchBestMatch(PROVIDER, fakeConfig, provider as any, {
      entryId: 1, title: "同名曲", artist: "期望歌手", duration: 180000,
    });
    expect(m.status).toBe("matched");
    expect(m.best!.id).toBe("r2");
  });

  it("期望无歌手 → 仅标题命中即 matched", async () => {
    const provider = providerReturning([
      { id: "r3", source: "netease", name: "同名曲", artist: "随便谁", duration: 180 },
    ]);
    const m = await searchBestMatch(PROVIDER, fakeConfig, provider as any, {
      entryId: 1, title: "同名曲", artist: "", duration: 180000,
    });
    expect(m.status).toBe("matched");
    expect(m.best!.id).toBe("r3");
  });

  it("期望无后缀(Live)候选带后缀 → no-match(有后缀只能配带相同后缀)", async () => {
    const provider = providerReturning([
      { id: "r4", source: "netease", name: "听妈妈的话(Live)", artist: "周杰伦", duration: 180 },
    ]);
    const m = await searchBestMatch(PROVIDER, fakeConfig, provider as any, {
      entryId: 1, title: "听妈妈的话", artist: "周杰伦", duration: 180000,
    });
    expect(m.status).toBe("no-match");
  });

  it("期望带(Live)候选带相同后缀(大小写/空格/括号差异) → matched", async () => {
    const provider = providerReturning([
      { id: "r5", source: "netease", name: "听妈妈的话 (LIVE)", artist: "周杰伦", duration: 180 },
    ]);
    const m = await searchBestMatch(PROVIDER, fakeConfig, provider as any, {
      entryId: 1, title: "听妈妈的话(Live)", artist: "周杰伦", duration: 180000,
    });
    expect(m.status).toBe("matched");
    expect(m.best!.id).toBe("r5");
  });

  it("期望带(Live)候选无后缀 → no-match(无后缀只能配无后缀)", async () => {
    const provider = providerReturning([
      { id: "r6", source: "netease", name: "听妈妈的话", artist: "周杰伦", duration: 180 },
    ]);
    const m = await searchBestMatch(PROVIDER, fakeConfig, provider as any, {
      entryId: 1, title: "听妈妈的话(Live)", artist: "周杰伦", duration: 180000,
    });
    expect(m.status).toBe("no-match");
  });
});
