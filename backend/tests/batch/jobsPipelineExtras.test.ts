// ==================== batch/jobs 管线异常收口 与 歌单导入幂等 ====================
//
// 为什么补这一层:
//   ① 每日管线里,单个能力的插件抛错**不得**中断整条管线(try 逐段包住),
//      这条「一个坏插件不拖垮全站同步」的护栏此前零覆盖 —— 一旦退化,某个
//      第三方插件的 bug 会让所有用户的每日推荐/清理全部停摆;
//   ② `playlist-import` 的「同链接重复导入 → 原位增量重建(不产生重复歌单)」
//      是幂等契约,重导时封面刷新分支也未测;
//   ③ 亲选道二次门禁(core-import-gate.reverifyUserPicked)失败不得阻断导入;
//   ④ 批量适配某一张歌单失败时,必须把错误写进该歌单的结果项而不是整体失败。
//
// 手法:与 jobsBehavior.test.ts 同款 —— mock registry/pluginAccess/各 service,
// 直接驱动 batchJobHandlers(与生产子进程 dispatch 走同一份 handler)。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { db, initDatabase, sqlite } from "../../src/db/index.js";
import { playlists, playlistSongs } from "../../src/db/schema.js";

const H = vi.hoisted(() => ({
  caps: [] as Array<{ cap: string; manifest: any; impl: any }>,
  sources: [] as any[],
  cfg: {} as Record<string, any>,
  plugins: {} as Record<string, any>,
  manifests: {} as Record<string, any>,
  provider: null as any,
  calls: [] as Array<{ fn: string; args: any[] }>,
  imported: { name: "导入歌单", platform: "qq", coverUrl: "", songs: [] as any[] } as any,
  importOnline: { added: 1, deduped: 0, failed: 0, songs: [{ id: "s1", fingerprint: "f1" }] } as any,
  crossVerifyThrows: false,
  crossVerify: { verified: [] as any[], rejected: 0 } as any,
  matchThrows: false,
  matchResult: { matched: 1, total: 1, unmatched: 0 } as any,
  purgeResult: { purged: 0, covers: 0, errors: 0 } as any,
  purgeThrows: false,
  syncAllResult: { synced: 1, failed: 0 } as any,
  syncAllThrows: false,
  cover: "pl-cover-xyz" as string | null,
  syncApi: null as any,
}));

vi.mock("../../src/plugins/registry.js", () => ({
  getEnabledByCapability: (cap: string) => H.caps.filter((c) => c.cap === cap).map((c) => ({ manifest: c.manifest, impl: c.impl })),
  getEnabledSourcePlugins: () => H.sources,
  getPluginConfig: (id: string) => H.cfg[id],
  getPlugin: (id: string) => H.plugins[id],
  getPluginManifest: (id: string) => H.manifests[id],
}));

vi.mock("../../src/services/pluginAccess.js", () => ({
  playlistSyncApi: () => H.syncApi,
  dailyRecommendApi: () => null,
  localRecommendApi: () => null,
  comboPlaylistApi: () => null,
}));

vi.mock("../../src/services/plugin/playlistImport.js", () => ({
  importPlaylistFromUrl: async (url: string) => {
    H.calls.push({ fn: "importPlaylistFromUrl", args: [url] });
    return H.imported;
  },
}));

vi.mock("../../src/services/plugin/remoteImport.js", () => ({
  importRemotePlaylistLike: async (o: any) => ({ playlistId: "pl-remote", ...o }),
}));

vi.mock("../../src/services/playlistCover.js", () => ({
  cacheRemoteCover: async (...a: any[]) => {
    H.calls.push({ fn: "cacheRemoteCover", args: a });
    return H.cover;
  },
}));

vi.mock("../../src/services/source/online/index.js", () => ({
  getConfiguredProvider: () => H.provider,
}));

vi.mock("../../src/services/source/online/service.js", () => ({
  importOnlineSongs: async (...a: any[]) => {
    H.calls.push({ fn: "importOnlineSongs", args: a });
    return H.importOnline;
  },
}));

vi.mock("../../src/services/source/online/match.js", () => ({
  matchUnmatchedPlaylistEntries: async (...a: any[]) => {
    H.calls.push({ fn: "matchUnmatchedPlaylistEntries", args: a.slice(0, 4) });
    if (H.matchThrows) throw new Error("匹配某歌单失败");
    return H.matchResult;
  },
  crossVerifySongs: async (...a: any[]) => {
    H.calls.push({ fn: "crossVerifySongs", args: a.slice(0, 4) });
    if (H.crossVerifyThrows) throw new Error("在线静默重验超时");
    return H.crossVerify;
  },
}));

vi.mock("../../src/services/source/online/recommendImport.js", () => ({
  syncAllRecommendPlaylists: async (id: string) => {
    H.calls.push({ fn: "syncAllRecommendPlaylists", args: [id] });
    if (H.syncAllThrows) throw new Error("推荐重导失败");
    return H.syncAllResult;
  },
}));

vi.mock("../../src/services/source/online/purge.js", () => ({
  // 真实实现是**同步**的（purge.ts: `export function purgeExpiredWebSongs(): PurgeResult`），
  // 所以 mock 必须同步返回/同步 throw。若误写成 async，同步调用点拿到的 Promise 无人 await，
  // 抛错会变成 unhandled rejection —— 既抓不到真实契约，又会被 Node 视为进程级错误。
  purgeExpiredWebSongs: (id: string) => {
    H.calls.push({ fn: "purgeExpiredWebSongs", args: [id] });
    if (H.purgeThrows) throw new Error("网页歌清理失败");
    return H.purgeResult;
  },
}));

vi.mock("../../src/services/source/scanner.js", () => ({
  scanLocalSource: async () => ({ added: 0, updated: 0, removed: 0 }),
  scanWebDAVSource: async () => ({ added: 0, updated: 0, removed: 0 }),
  // orchestrator 的 DEFAULT_DEPS 在模块加载期就取它（点名单曲入库用），mock 里必须补齐。
  scanLocalFiles: async () => ({ added: 0, updated: 0 }),
}));

vi.mock("../../src/services/scraper/artist.js", () => ({
  scrapeArtistList: async () => ({ scraped: 0, errors: [] }),
}));

vi.mock("../../src/services/backfill.js", () => ({
  collectCandidates: () => [],
  runBackfillLoop: async () => ({ ok: true }),
  runBackfillChunked: async () => ({ ok: true }),
}));

import { batchJobHandlers } from "../../src/batch/jobs.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  sqlite.prepare("INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt) VALUES (?, ?, ?, ?, ?)")
    .run("u1", "batchowner2", "", "s", "ss");
});

function ctx() {
  const progress: any[] = [];
  const ac = new AbortController();
  return { progress, c: { onProgress: (p: any) => progress.push(p), signal: ac.signal } };
}

function addPlugin(cap: string, id: string, impl: any, manifestExtra: any = {}) {
  const manifest = { id, capabilities: [cap], ...manifestExtra };
  H.caps.push({ cap, manifest, impl });
  H.manifests[id] = manifest;
  H.plugins[id] = { manifest, impl };
}

beforeEach(() => {
  H.caps = [];
  H.sources = [];
  H.cfg = {};
  H.plugins = {};
  H.manifests = {};
  H.provider = { config: { baseUrl: "http://fake" }, provider: { search: async () => ({ songs: [] }) } };
  H.calls = [];
  H.crossVerifyThrows = false;
  H.matchThrows = false;
  H.purgeThrows = false;
  H.syncAllThrows = false;
  H.cover = "pl-cover-xyz";
  H.imported = { name: "导入歌单", platform: "qq", coverUrl: "", songs: [] };
  H.importOnline = { added: 1, deduped: 0, failed: 0, songs: [{ id: "s1", fingerprint: "f1" }] };
  H.crossVerify = { verified: [], rejected: 0 };
  H.matchResult = { matched: 1, total: 1, unmatched: 0 };
  H.purgeResult = { purged: 0, covers: 0, errors: 0 };
  H.syncAllResult = { synced: 1, failed: 0 };
  H.syncApi = {
    rebuildPlaylistEntries: async () => ({ total: 1, matched: 1, unmatched: 0, wishAdded: 0 }),
    syncPlaylist: async () => ({ ok: true }),
  };
});

// ---------------------------------------------------------------------------
// 6a. 管线:单插件抛错不得中断后续能力
// ---------------------------------------------------------------------------
describe("每日管线:单项失败隔离", () => {
  it("comboPlaylist 抛错 → 被吞,其后 playlistCleanup 仍照常执行", async () => {
    let cleaned = 0;
    addPlugin("comboPlaylist", "p-combo-bad", { runDailyJob: async () => { throw new Error("combo 炸了"); } });
    addPlugin("playlistCleanup", "p-clean-ok", { runDailyJob: async () => { cleaned++; return "cleaned 3"; } });
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    // 关键护栏:一个能力的插件失败,不能把整条管线带走。
    expect(cleaned).toBe(1);
    expect(r.ok).toBe(true);
  });

  it("playlistCleanup 抛错 → 同样被吞,管线整体成功", async () => {
    addPlugin("playlistCleanup", "p-clean-bad", { runDailyJob: async () => { throw new Error("清理炸了"); } });
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(r.ok).toBe(true);
  });

  it("推荐重导抛错 → 不阻断网页歌清理(两种 source 能力互不牵连)", async () => {
    H.sources = [{ manifest: { id: "src-1", capabilities: ["recommend", "webRotation"] } }];
    H.syncAllThrows = true;
    H.purgeResult = { purged: 5, covers: 2, errors: 1 };
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(H.calls.some((c) => c.fn === "syncAllRecommendPlaylists")).toBe(true);
    expect(H.calls.some((c) => c.fn === "purgeExpiredWebSongs")).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("网页歌清理抛错 → 被吞(不因清理失败让整日同步报错)", async () => {
    H.sources = [{ manifest: { id: "src-1", capabilities: ["webRotation"] } }];
    H.purgeThrows = true;
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6b. playlist-import:同链接重导必须原位更新(幂等),且刷新封面
// ---------------------------------------------------------------------------
describe("playlist-import:重复导入同链接不产生新歌单", () => {
  it("已存在同 (sourceUrl, ownerId) → 复用 id,写回新名字与封面", async () => {
    const url = "http://example.com/pl/idem-1";
    db.insert(playlists).values({
      id: "pl-idem", name: "旧名字", ownerId: "u1", isPublic: 0, sourceUrl: url,
    }).run();
    H.imported = { name: "远端名字", platform: "qq", coverUrl: "http://cover/x.jpg", songs: [] };
    H.cover = "pl-cover-idem";

    const r = await batchJobHandlers["playlist-import"]({ url, userId: "u1", name: "新名字" }, ctx().c);
    expect(r.playlistId).toBe("pl-idem");
    // 封面以 (url, pl-<id>, true) 缓存 —— 第三个 true 表示「覆盖已有封面」
    const coverCall = H.calls.find((c) => c.fn === "cacheRemoteCover");
    expect(coverCall).toBeTruthy();
    expect(coverCall!.args[0]).toBe("http://cover/x.jpg");
    expect(coverCall!.args[1]).toBe("pl-pl-idem");
    expect(coverCall!.args[2]).toBe(true);

    const rows = db.select().from(playlists).all().filter((p: any) => p.sourceUrl === url);
    expect(rows.length).toBe(1); // 幂等:没有新增第二行
    expect(rows[0].name).toBe("新名字");
    expect(rows[0].coverArt).toBe("pl-cover-idem");
  });
});

// ---------------------------------------------------------------------------
// 6c. song-search-import:亲选道二次门禁失败不得阻断导入
// ---------------------------------------------------------------------------
describe("song-search-import:二次门禁 best-effort", () => {
  it("reverifyUserPicked 开启但上游重验抛错 → 仍按亲选语义入库", async () => {
    H.cfg["core-import-gate"] = { reverifyUserPicked: true };
    H.crossVerifyThrows = true;
    const r = await batchJobHandlers["song-search-import"](
      { providerId: "go-music-dl", userId: "u1", songs: [{ id: "o1", source: "netease", name: "歌", artist: "人" }] },
      ctx().c,
    );
    expect(r.success).toBe(true);
    expect(H.calls.some((c) => c.fn === "importOnlineSongs")).toBe(true);
    // 门禁失败 → 不得产出 reverify 计数(避免上报伪造的"已验证"数字)
    expect(r.reverify).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6d. match-playlists:单歌单失败进结果项,整体仍完成
// ---------------------------------------------------------------------------
describe("match-playlists:逐歌单失败隔离", () => {
  it("某歌单匹配抛错 → 该项带 error,其余照常,整体 done 完整", async () => {
    db.insert(playlists).values({ id: "pl-m1", name: "待匹配", ownerId: "u1", isPublic: 0 }).run();
    db.insert(playlistSongs).values({ playlistId: "pl-m1", songId: null, position: 0, playable: 0, externalTitle: "未匹配" }).run();
    H.matchThrows = true;
    const r = await batchJobHandlers["match-playlists"]({ providerId: "go-music-dl" }, ctx().c);
    expect(r.alreadyMatched).toBe(false);
    expect(r.done).toBe(r.total);
    const item = r.results.find((x: any) => x.playlistId === "pl-m1");
    expect(item).toBeTruthy();
    expect(String(item.error)).toContain("匹配某歌单失败");
  });
});
