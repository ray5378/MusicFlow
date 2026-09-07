// Unit tests for services/source/online/match.ts — 导入命中门禁时代。
//   - matchUnmatchedPlaylistEntries:平台 id 直通已废除,所有条目(含带 source:id 的)
//     一律在线搜索 + 门禁交叉比对;搜不到全命中候选 → no-match(保持未匹配占位)。
//   - searchBestMatch:绑定门禁 = passesImportGate(标题+歌手强制、专辑一致、时长容差)。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { eq, and } from "drizzle-orm";
import { songs, playlists, playlistSongs, users } from "../../../src/db/schema.js";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import {
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

function enableProvider(searchImpl?: (_config: any, params: any) => Promise<any>) {
  const searchCalls: string[] = [];
  const provider = {
    id: PROVIDER,
    manifest: manifestOf,
    search: async (_config: any, params: any) => {
      searchCalls.push(params.query || "");
      return searchImpl ? searchImpl(_config, params) : { songs: [] };
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

function seed(entries: { id: string; title: string; artist: string; album?: string; extId: string | null }[]) {
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
      externalAlbum: e.album ?? null,
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

describe("matchUnmatchedPlaylistEntries — 平台 id 直通已废除,一律搜索交叉比对", () => {
  it("带 source:id 的条目也必须经搜索命中才导入(命中后以搜索验证过的候选落库)", async () => {
    const { searchCalls, provider } = enableProvider(async (_c: any, params: any) => ({
      songs: (params.query || "").includes("直通曲")
        ? [{ id: "cand-1", source: "netease", name: "直通曲", artist: "直通人", album: "真专辑", duration: 180 }]
        : [],
    }));
    seed([
      { id: "k1", title: "直通曲", artist: "直通人", album: "真专辑", extId: "netease:111" },
      { id: "k2", title: "未知曲", artist: "未知人", extId: null },
    ]);

    const res = await matchUnmatchedPlaylistEntries(PROVIDER, fakeConfig, provider as any, PL);

    // 两条目都发了真实搜索(直通已废除)。
    expect(searchCalls.length).toBe(2);
    // 带上游 id 的条目:搜索命中且过门禁 → matched。
    const row = db.select().from(playlistSongs).where(and(eq(playlistSongs.playlistId, PL), eq(playlistSongs.externalSongId, "netease:111"))).get() as any;
    expect(row.playable).toBe(1);
    expect(row.songId).toBeTruthy();
    // 落库的是【搜索验证过的候选】,不是上游 id。
    const song = db.select().from(songs).where(eq(songs.id, row.songId)).get() as any;
    expect(song.fingerprint).toBe("go-music-dl:netease:cand-1");
    expect(song.title).toBe("直通曲");
    expect(song.type).toBe("web");
    // 无候选条目 → no-match,保持未匹配占位。
    const row2 = db.select().from(playlistSongs).where(and(eq(playlistSongs.playlistId, PL), eq(playlistSongs.externalTitle, "未知曲"))).get() as any;
    expect(row2.playable).toBe(0);
    expect(row2.songId).toBeNull();
    const unknown = res.results.find((r) => r.entryId === row2.id);
    expect(unknown?.status).toBe("no-match");

    resetRows();
  });

  it("搜索无候选(如元数据冒名的假源在搜索里不存在)→ 即使带 source:id 也拒导", async () => {
    const { provider } = enableProvider(); // 恒空结果
    seed([{ id: "f1", title: "我们的歌", artist: "王力宏", album: "K情歌 5", extId: "qq:fake-id" }]);

    const res = await matchUnmatchedPlaylistEntries(PROVIDER, fakeConfig, provider as any, PL);

    expect(res.matched).toBe(0);
    expect(res.noMatch).toBe(1);
    const row = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, PL)).get() as any;
    expect(row.playable).toBe(0);
    expect(row.songId).toBeNull();

    resetRows();
  });

  it("假源回放:候选标题/歌手/时长全对上但专辑是合辑(与期望不一致)→ 门禁拒绑", async () => {
    const { provider } = enableProvider(async (_c: any, params: any) => ({
      songs: (params.query || "").includes("我们的歌")
        ? [{ id: "fake-1", source: "qq", name: "我们的歌", artist: "王力宏", album: "K情歌 5", duration: 247 }]
        : [],
    }));
    seed([{ id: "g1", title: "我们的歌", artist: "王力宏", album: "改变自己", extId: "qq:whatever" }]);

    const res = await matchUnmatchedPlaylistEntries(PROVIDER, fakeConfig, provider as any, PL);

    expect(res.matched).toBe(0);
    expect(res.noMatch).toBe(1);
    expect(res.results[0]!.message).toContain("album");
    const row = db.select().from(playlistSongs).where(eq(playlistSongs.playlistId, PL)).get() as any;
    expect(row.playable).toBe(0);
    expect(row.songId).toBeNull();

    resetRows();
  });

  it("候选无专辑字段(无法核实)→ 门禁拒绑", async () => {
    const { provider } = enableProvider(async (_c: any, params: any) => ({
      songs: (params.query || "").includes("某首歌")
        ? [{ id: "na-1", source: "qq", name: "某首歌", artist: "某人", album: "", duration: 180 }]
        : [],
    }));
    seed([{ id: "h1", title: "某首歌", artist: "某人", album: "正经专辑", extId: null }]);

    const res = await matchUnmatchedPlaylistEntries(PROVIDER, fakeConfig, provider as any, PL);

    expect(res.matched).toBe(0);
    expect(res.results[0]!.message).toContain("album");

    resetRows();
  });
});

describe("searchBestMatch — 导入命中门禁", () => {
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

  it("期望带专辑而候选专辑不一致 → no-match(专辑门禁)", async () => {
    const provider = providerReturning([
      { id: "r7", source: "netease", name: "我们的歌", artist: "王力宏", album: "K情歌 5", duration: 247 },
    ]);
    const m = await searchBestMatch(PROVIDER, fakeConfig, provider as any, {
      entryId: 1, title: "我们的歌", artist: "王力宏", album: "改变自己", duration: 247000,
    });
    expect(m.status).toBe("no-match");
  });

  it("专辑一致(含括号/空白差异)→ matched", async () => {
    const provider = providerReturning([
      { id: "r8", source: "netease", name: "我们的歌", artist: "王力宏", album: "改变自己 (Change Me)", duration: 247 },
    ]);
    const m = await searchBestMatch(PROVIDER, fakeConfig, provider as any, {
      entryId: 1, title: "我们的歌", artist: "王力宏", album: "改变自己(Change Me)", duration: 247000,
    });
    expect(m.status).toBe("matched");
    expect(m.best!.id).toBe("r8");
  });

  it("候选时长超容差 → no-match(时长门禁)", async () => {
    const provider = providerReturning([
      { id: "r9", source: "netease", name: "同名曲", artist: "期望歌手", album: "同专辑", duration: 300 },
    ]);
    const m = await searchBestMatch(PROVIDER, fakeConfig, provider as any, {
      entryId: 1, title: "同名曲", artist: "期望歌手", album: "同专辑", duration: 180000,
    });
    expect(m.status).toBe("no-match");
  });

  it("候选无时长但期望有时长 → no-match(无法核实不放过)", async () => {
    const provider = providerReturning([
      { id: "r10", source: "netease", name: "同名曲", artist: "期望歌手", album: "同专辑", duration: 0 },
    ]);
    const m = await searchBestMatch(PROVIDER, fakeConfig, provider as any, {
      entryId: 1, title: "同名曲", artist: "期望歌手", album: "同专辑", duration: 180000,
    });
    expect(m.status).toBe("no-match");
  });
});
