// ==================== batch/jobs 处理器行为测试 ====================
// 目标:覆盖 src/batch/jobs.ts 的各 handler 主路径 / 门控 / 异常分支。
// 手法:用 vi.mock 替换 registry / pluginAccess / 各 service 依赖,直接驱动
// batchJobHandlers —— 与生产子进程 dispatch 走的是同一份 handler 代码。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { db, initDatabase, sqlite } from "../../src/db/index.js";
import { mediaSources } from "../../src/db/schema.js";

const H = vi.hoisted(() => ({
  caps: [] as Array<{ cap: string; manifest: any; impl: any }>,
  sources: [] as any[],
  cfg: {} as Record<string, any>,
  plugins: {} as Record<string, any>,
  manifests: {} as Record<string, any>,
  access: {
    playlistSync: null as any,
    dailyRecommend: null as any,
    localRecommend: null as any,
    comboPlaylist: null as any,
  },
  provider: null as any,
  calls: [] as Array<{ fn: string; args: any[] }>,
  scanResult: { added: 3, updated: 0, removed: 0 } as any,
  onScan: null as any,
  scrapeResult: { scraped: 2, errors: [] as any[] } as any,
  scrapeThrows: false as boolean,
  imported: { name: "导入歌单", platform: "qq", coverUrl: "", songs: [] as any[] } as any,
  importOnline: { added: 1, deduped: 0, failed: 0, songs: [{ id: "s1", fingerprint: "f1" }] } as any,
  importOnlineEmpty: false as boolean,
  crossVerify: { verified: [] as any[], rejected: 0 } as any,
  matchResult: { matched: 1, total: 1, unmatched: 0 } as any,
  matchThrows: false as boolean,
  purgeResult: { purged: 0, covers: 0, errors: 0 } as any,
  syncAll: { synced: 1, failed: 0 } as any,
  cover: "pl-cover-1" as string | null,
  backfillRows: [] as any[],
}));

vi.mock("../../src/plugins/registry.js", () => ({
  getEnabledByCapability: (cap: string) =>
    H.caps.filter((c) => c.cap === cap).map((c) => ({ manifest: c.manifest, impl: c.impl })),
  getEnabledSourcePlugins: () => H.sources,
  getPluginConfig: (id: string) => H.cfg[id],
  getPlugin: (id: string) => H.plugins[id],
  getPluginManifest: (id: string) => H.manifests[id],
}));

vi.mock("../../src/services/pluginAccess.js", () => ({
  playlistSyncApi: () => H.access.playlistSync,
  dailyRecommendApi: () => H.access.dailyRecommend,
  localRecommendApi: () => H.access.localRecommend,
  comboPlaylistApi: () => H.access.comboPlaylist,
}));

vi.mock("../../src/services/plugin/playlistImport.js", () => ({
  importPlaylistFromUrl: async (url: string) => {
    H.calls.push({ fn: "importPlaylistFromUrl", args: [url] });
    return H.imported;
  },
}));

vi.mock("../../src/services/plugin/remoteImport.js", () => ({
  importRemotePlaylistLike: async (o: any) => {
    H.calls.push({ fn: "importRemotePlaylistLike", args: [o] });
    return { playlistId: "pl-remote", ...o };
  },
}));

vi.mock("../../src/services/playlistCover.js", () => ({
  cacheRemoteCover: async (u: string, id: string) => {
    H.calls.push({ fn: "cacheRemoteCover", args: [u, id] });
    return H.cover;
  },
}));

vi.mock("../../src/services/source/online/index.js", () => ({
  getConfiguredProvider: (id: string) => {
    H.calls.push({ fn: "getConfiguredProvider", args: [id] });
    return H.provider;
  },
}));

vi.mock("../../src/services/source/online/service.js", () => ({
  importOnlineSongs: async (...a: any[]) => {
    H.calls.push({ fn: "importOnlineSongs", args: a });
    return H.importOnlineEmpty
      ? { added: 0, deduped: 0, failed: 0, songs: [] }
      : H.importOnline;
  },
}));

vi.mock("../../src/services/source/online/match.js", () => ({
  matchUnmatchedPlaylistEntries: async (...a: any[]) => {
    H.calls.push({ fn: "matchUnmatchedPlaylistEntries", args: a.slice(0, 4) });
    if (H.matchThrows) throw new Error("匹配服务炸了");
    return H.matchResult;
  },
  crossVerifySongs: async (...a: any[]) => {
    H.calls.push({ fn: "crossVerifySongs", args: a.slice(0, 4) });
    return H.crossVerify;
  },
}));

vi.mock("../../src/services/source/online/recommendImport.js", () => ({
  syncAllRecommendPlaylists: async (id: string) => {
    H.calls.push({ fn: "syncAllRecommendPlaylists", args: [id] });
    return H.syncAll;
  },
}));

vi.mock("../../src/services/source/online/purge.js", () => ({
  purgeExpiredWebSongs: async (id: string) => {
    H.calls.push({ fn: "purgeExpiredWebSongs", args: [id] });
    return H.purgeResult;
  },
}));

vi.mock("../../src/services/source/scanner.js", () => ({
  scanLocalSource: async (...a: any[]) => {
    H.calls.push({ fn: "scanLocalSource", args: a.slice(0, 3) });
    if (H.onScan) H.onScan();
    return H.scanResult;
  },
  scanWebDAVSource: async (...a: any[]) => {
    H.calls.push({ fn: "scanWebDAVSource", args: a.slice(0, 3) });
    if (H.onScan) H.onScan();
    return H.scanResult;
  },
}));

vi.mock("../../src/services/scraper/artist.js", () => ({
  scrapeArtistList: async (ids: string[], onProgress?: any) => {
    H.calls.push({ fn: "scrapeArtistList", args: [ids] });
    if (onProgress) onProgress({ done: ids.length, total: ids.length });
    if (H.scrapeThrows) throw new Error("刮削服务炸了");
    return H.scrapeResult;
  },
}));

vi.mock("../../src/services/backfill.js", () => ({
  collectCandidates: (kind: string) => {
    H.calls.push({ fn: "collectCandidates", args: [kind] });
    return H.backfillRows;
  },
  runBackfillLoop: async (...a: any[]) => {
    H.calls.push({ fn: "runBackfillLoop", args: a.slice(0, 1) });
    return { ok: true, kind: a[0] };
  },
  runBackfillChunked: async (...a: any[]) => {
    H.calls.push({ fn: "runBackfillChunked", args: [a[0]] });
    return { ok: true, chunked: true };
  },
}));

import { batchJobHandlers } from "../../src/batch/jobs.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  // playlists.owner_id 有外键到 users → 预置一个用户
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO users (id, username, password, salt, subsonic_salt) VALUES (?, ?, ?, ?, ?)",
    )
    .run("u1", "batchowner", "", "s", "ss");
});

function ctx() {
  const progress: any[] = [];
  const ac = new AbortController();
  return {
    progress,
    c: { onProgress: (p: any) => progress.push(p), signal: ac.signal },
    abort: () => ac.abort(),
  };
}

function addPlugin(cap: string, id: string, impl: any, manifestExtra: any = {}) {
  const manifest = { id, capabilities: [cap], ...manifestExtra };
  H.caps.push({ cap, manifest, impl });
  // pluginDeclaresSchedule 走 getPluginManifest(而非 capability 列表) → 必须同步注册
  H.manifests[id] = manifest;
  H.plugins[id] = { manifest, impl };
}

function resetMocks() {
  H.caps = [];
  H.sources = [];
  H.cfg = {};
  H.plugins = {};
  H.manifests = {};
  H.access.playlistSync = null;
  H.access.dailyRecommend = null;
  H.access.localRecommend = null;
  H.access.comboPlaylist = null;
  H.provider = null;
  H.calls = [];
  H.scrapeThrows = false;
  H.matchThrows = false;
  H.importOnlineEmpty = false;
  H.cover = "pl-cover-1";
  H.backfillRows = [];
  H.imported = { name: "导入歌单", platform: "qq", coverUrl: "", songs: [] };
  H.crossVerify = { verified: [], rejected: 0 };
  H.scrapeResult = { scraped: 2, errors: [] };
  H.matchResult = { matched: 1, total: 1, unmatched: 0 };
  H.purgeResult = { purged: 0, covers: 0, errors: 0 };
  H.syncAll = { synced: 1, failed: 0 };
  H.scanResult = { added: 3, updated: 0, removed: 0 };
  H.onScan = null;
}

beforeEach(resetMocks);

// ---------------- 门控:scheduleEnabledFor / runOnBootFor ----------------
describe("每日定点 / 启动补拉门控", () => {
  it("无插件时:ran=0 skipped=0", async () => {
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(r).toEqual({ ok: true, ran: 0, skipped: 0 });
  });

  it("manifest.schedules 缺省 + 无 config → 默认参与(老用户升级行为连续)", async () => {
    let called = 0;
    addPlugin("dailyPlaylist", "p-def", { runDailyJob: async () => { called++; return "ok"; } });
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(called).toBe(1);
    expect(r.ran).toBe(1);
    expect(r.skipped).toBe(0);
  });

  it("manifest.schedules=false → 不参与(skipped)", async () => {
    let called = 0;
    addPlugin("dailyPlaylist", "p-no", { runDailyJob: async () => { called++; } }, { schedules: false });
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(called).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("manifest.schedules={scheduleEnabled:false} → 不参与", async () => {
    let called = 0;
    addPlugin("dailyPlaylist", "p-se", { runDailyJob: async () => { called++; } }, { schedules: { scheduleEnabled: false } });
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(called).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("config.scheduleEnabled=false → 不参与(config 显式关优先)", async () => {
    let called = 0;
    addPlugin("dailyPlaylist", "p-cfg", { runDailyJob: async () => { called++; } });
    H.cfg["p-cfg"] = { scheduleEnabled: false };
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(called).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("impl 未实现 runDailyJob → 既不算 ran 也不算 skipped", async () => {
    addPlugin("dailyPlaylist", "p-nofn", {});
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(r.ran).toBe(0);
    expect(r.skipped).toBe(0);
  });

  it("runDailyJob 抛错 → 单插件失败不影响整体,ran 不增", async () => {
    addPlugin("dailyPlaylist", "p-boom", { runDailyJob: async () => { throw new Error("boom"); } });
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(r.ran).toBe(0);
    expect(r.ok).toBe(true);
  });

  it("comboPlaylist / playlistCleanup 能力同样受门控", async () => {
    let combo = 0, clean = 0;
    addPlugin("comboPlaylist", "p-combo", { runDailyJob: async () => { combo++; } });
    addPlugin("playlistCleanup", "p-clean", { runDailyJob: async () => { clean++; } }, { schedules: false });
    const r = await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(combo).toBe(1);
    expect(clean).toBe(0);
    expect(r.ran).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("source 插件 recommend/webRotation 能力在每日管线中执行", async () => {
    H.sources = [
      { manifest: { id: "src-rec", capabilities: ["recommend", "webRotation"] } },
      { manifest: { id: "src-plain", capabilities: [] } },
    ];
    await batchJobHandlers["daily-jobs"]({}, ctx().c);
    expect(H.calls.filter((c) => c.fn === "syncAllRecommendPlaylists").length).toBe(1);
    expect(H.calls.filter((c) => c.fn === "purgeExpiredWebSongs").length).toBe(1);
  });

  it("boot-sync 默认一个都不跑(runOnBoot 缺失=关)", async () => {
    let called = 0;
    addPlugin("dailyPlaylist", "p-boot", { runDailyJob: async () => { called++; } });
    const r = await batchJobHandlers["boot-sync"]({}, ctx().c);
    expect(called).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("boot-sync:config.runOnBoot=true → 执行", async () => {
    let called = 0;
    addPlugin("dailyPlaylist", "p-boot2", { runDailyJob: async () => { called++; } });
    H.cfg["p-boot2"] = { runOnBoot: true };
    const r = await batchJobHandlers["boot-sync"]({}, ctx().c);
    expect(called).toBe(1);
    expect(r.ran).toBe(1);
  });

  it("boot-sync 同时补跑维护型步骤(playlistSync + 歌手刮削)", async () => {
    let synced = 0;
    addPlugin("playlistSync", "p-sync", { runSyncJob: async () => { synced++; return "synced"; } });
    H.cfg["p-sync"] = { runOnBoot: true };
    const r = await batchJobHandlers["boot-sync"]({}, ctx().c);
    expect(synced).toBe(1);
    expect(r.ran).toBe(1);
  });
});

// ---------------- maintenance ----------------
describe("6h 维护(maintenance)", () => {
  it("playlistSync 插件执行 runSyncJob", async () => {
    addPlugin("playlistSync", "p-s", { runSyncJob: async () => "done" });
    const r = await batchJobHandlers["maintenance"]({}, ctx().c);
    expect(r.ran).toBe(1);
    expect(r.ok).toBe(true);
  });

  it("runSyncJob 抛错 → 捕获,ran 不增", async () => {
    addPlugin("playlistSync", "p-s2", { runSyncJob: async () => { throw new Error("x"); } });
    const r = await batchJobHandlers["maintenance"]({}, ctx().c);
    expect(r.ran).toBe(0);
  });

  it("artistInfo 插件:近期新增且无封面的歌手才触发刮削", async () => {
    const aid = "artist-batch-" + Date.now();
    sqlite.prepare("INSERT INTO artists (id, name, created_at) VALUES (?, ?, ?)").run(aid, "Batch Artist", new Date().toISOString());
    sqlite.prepare("UPDATE artists SET created_at = ? WHERE id = ?").run(new Date().toISOString(), aid);
    addPlugin("artistInfo", "p-ai", {});
    const r = await batchJobHandlers["maintenance"]({}, ctx().c);
    const calls = H.calls.filter((c) => c.fn === "scrapeArtistList");
    expect(calls.length).toBe(1);
    expect(calls[0].args[0]).toContain(aid);
    expect(r.ran).toBe(1);
    sqlite.prepare("DELETE FROM artists WHERE id = ?").run(aid);
  });

  it("artistInfo 插件被门控跳过 → 不刮削", async () => {
    addPlugin("artistInfo", "p-ai2", {}, { schedules: false });
    const r = await batchJobHandlers["maintenance"]({}, ctx().c);
    expect(H.calls.filter((c) => c.fn === "scrapeArtistList").length).toBe(0);
    expect(r.skipped).toBe(1);
  });
});

// ---------------- scan ----------------
describe("媒体源扫描(scan)", () => {
  function mkSource(type: string, id?: string) {
    const sid = id || "src-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    sqlite
      .prepare("INSERT INTO media_sources (id, name, type, config, enabled) VALUES (?, ?, ?, ?, 1)")
      .run(sid, "s-" + sid, type, JSON.stringify({ path: "/tmp/x" }));
    return sid;
  }

  it("媒体源不存在 → 抛错", async () => {
    await expect(batchJobHandlers["scan"]({ sourceId: "nope" }, ctx().c)).rejects.toThrow("媒体源不存在");
  });

  it("不支持的源类型 → 抛错", async () => {
    const sid = mkSource("ftp");
    await expect(batchJobHandlers["scan"]({ sourceId: sid }, ctx().c)).rejects.toThrow("不支持的媒体源类型");
  });

  it("local 源 → 调 scanLocalSource", async () => {
    const sid = mkSource("local");
    const c = ctx();
    const r = await batchJobHandlers["scan"]({ sourceId: sid }, c.c);
    expect(H.calls.some((x) => x.fn === "scanLocalSource")).toBe(true);
    expect(r.result).toEqual(H.scanResult);
    expect(r.aborted).toBe(false);
  });

  it("webdav 源 → 调 scanWebDAVSource;mode=incremental 原样下传", async () => {
    const sid = mkSource("webdav");
    await batchJobHandlers["scan"]({ sourceId: sid, mode: "incremental" }, ctx().c);
    const call = H.calls.find((x) => x.fn === "scanWebDAVSource")!;
    expect(call.args[2]).toBe("incremental");
  });

  it("扫描中被 abort → aborted=true 且不做后续刮削", async () => {
    const sid = mkSource("local");
    const c = ctx();
    c.abort();
    const r = await batchJobHandlers["scan"]({ sourceId: sid }, c.c);
    expect(r.aborted).toBe(true);
    expect(r.scrape).toBeNull();
    expect(H.calls.filter((x) => x.fn === "scrapeArtistList").length).toBe(0);
  });

  it("扫描后新增无封面歌手 → 触发刮削并上报 scrape-start/scrape-done", async () => {
    const sid = mkSource("local");
    const aid = "artist-scan-" + Date.now();
    // 必须在扫描过程中新增:扫描前已存在的歌手会被算进 preScanArtistIds
    H.onScan = () => sqlite.prepare("INSERT INTO artists (id, name) VALUES (?, ?)").run(aid, "Scan New Artist");
    const c = ctx();
    const r = await batchJobHandlers["scan"]({ sourceId: sid }, c.c);
    expect(c.progress.some((p) => p.stage === "scrape-start")).toBe(true);
    expect(c.progress.some((p) => p.stage === "scrape-done")).toBe(true);
    expect(r.scrape).toEqual(H.scrapeResult);
    sqlite.prepare("DELETE FROM artists WHERE id = ?").run(aid);
  });

  it("刮削失败 → 上报 scrape-failed,扫描结果照常返回(不阻塞)", async () => {
    const sid = mkSource("local");
    const aid = "artist-scan2-" + Date.now();
    H.onScan = () => sqlite.prepare("INSERT INTO artists (id, name) VALUES (?, ?)").run(aid, "Scan New Artist 2");
    H.scrapeThrows = true;
    const c = ctx();
    const r = await batchJobHandlers["scan"]({ sourceId: sid }, c.c);
    expect(c.progress.some((p) => p.stage === "scrape-failed")).toBe(true);
    expect(r.scrape).toBeNull();
    expect(r.result).toEqual(H.scanResult);
    sqlite.prepare("DELETE FROM artists WHERE id = ?").run(aid);
  });
});

// ---------------- 歌单导入 / 同步 ----------------
describe("歌单导入与同步", () => {
  it("缺少链接 → 抛错", async () => {
    await expect(batchJobHandlers["playlist-import"]({}, ctx().c)).rejects.toThrow("缺少歌单链接");
  });

  it("歌单同步插件未启用 → 抛错", async () => {
    await expect(
      batchJobHandlers["playlist-import"]({ url: "https://x/pl/1", userId: "u1" }, ctx().c),
    ).rejects.toThrow("歌单同步插件未启用");
  });

  it("首次导入:建歌单 + 缓存封面 + 重建条目", async () => {
    H.imported = { name: "我的歌单", platform: "qq", coverUrl: "https://img/1.jpg", songs: [] };
    H.access.playlistSync = {
      rebuildPlaylistEntries: async (id: string, imported: any, opts: any) => {
        H.calls.push({ fn: "rebuild", args: [id, opts] });
        return { total: 10, matched: 8, unmatched: 2, wishAdded: 1 };
      },
    };
    const r = await batchJobHandlers["playlist-import"](
      { url: "https://x/pl/first", name: "我的歌单", userId: "u1", autoSync: true },
      ctx().c,
    );
    expect(r.success).toBe(true);
    expect(r.name).toBe("我的歌单");
    expect(r.trackCount).toBe(10);
    expect(r.wishAdded).toBe(1);
    expect(r.autoSync).toBe(true);
    const row = sqlite.prepare("SELECT * FROM playlists WHERE source_url = ?").get("https://x/pl/first") as any;
    expect(row).toBeTruthy();
    expect(row.cover_art).toBe("pl-cover-1");
    expect(row.sync_enabled).toBe(1);
  });

  it("同用户重复导入同链接 → 原位增量重建,不产生重复歌单", async () => {
    H.access.playlistSync = {
      rebuildPlaylistEntries: async () => ({ total: 1, matched: 1, unmatched: 0, wishAdded: 0 }),
    };
    const a = await batchJobHandlers["playlist-import"]({ url: "https://x/pl/dup", userId: "u1" }, ctx().c);
    const b = await batchJobHandlers["playlist-import"](
      { url: "https://x/pl/dup", userId: "u1", name: "改名" },
      ctx().c,
    );
    expect(b.playlistId).toBe(a.playlistId);
    const n = sqlite
      .prepare("SELECT COUNT(*) AS c FROM playlists WHERE source_url = ?")
      .get("https://x/pl/dup") as any;
    expect(n.c).toBe(1);
    const row = sqlite.prepare("SELECT name FROM playlists WHERE id = ?").get(b.playlistId) as any;
    expect(row.name).toBe("改名");
  });

  it("playlist-sync:插件未启用 → 抛错", async () => {
    await expect(batchJobHandlers["playlist-sync"]({ playlistId: "p1" }, ctx().c)).rejects.toThrow(
      "歌单同步插件未启用",
    );
  });

  it("playlist-sync:正常转发给 syncPlaylist", async () => {
    let got: any = null;
    H.access.playlistSync = { syncPlaylist: async (id: string, o: any) => { got = { id, o }; return { ok: 1 }; } };
    const r = await batchJobHandlers["playlist-sync"]({ playlistId: "p9", userId: "u1" }, ctx().c);
    expect(got.id).toBe("p9");
    expect(got.o.userId).toBe("u1");
    expect(r).toEqual({ ok: 1 });
  });
});

// ---------------- 远程导入 / 歌曲入库 ----------------
describe("远程导入与歌曲入库", () => {
  it("插件缺少 playlistSongs 能力 → 抛错", async () => {
    await expect(
      batchJobHandlers["playlist-search-import"]({ providerId: "prov-x" }, ctx().c),
    ).rejects.toThrow("playlistSongs");
  });

  it("album-search-import 与 playlist-search-import 共用同一处理器", async () => {
    addPlugin("albumSearch", "prov-a", { playlistSongs: async () => [] });
    const r = await batchJobHandlers["album-search-import"](
      { providerId: "prov-a", lookupCap: "albumSearch", id: "al-1", name: "专辑" },
      ctx().c,
    );
    expect(r.playlistId).toBe("pl-remote");
    expect(r.id).toBe("al-1");
  });

  it("song-search-import:入库为空 → 抛错", async () => {
    H.importOnlineEmpty = true;
    await expect(
      batchJobHandlers["song-search-import"]({ providerId: "prov", songs: [] }, ctx().c),
    ).rejects.toThrow("歌曲入库失败");
  });

  it("song-search-import:亲选道 gate=skip 入库并返回明细", async () => {
    const r = await batchJobHandlers["song-search-import"](
      { providerId: "prov", songs: [{ id: "1", name: "n", artist: "a" }], userId: "u1" },
      ctx().c,
    );
    expect(r.success).toBe(true);
    expect(r.trackCount).toBe(1);
    expect(r.imported[0]).toEqual({ id: "s1", fingerprint: "f1" });
    expect(r.reverify).toBeUndefined();
  });

  it("song-search-import:二次门禁开启 + provider 已配置 → 上报 reverify", async () => {
    H.cfg["core-import-gate"] = { reverifyUserPicked: true };
    H.provider = { config: {}, provider: {} };
    H.crossVerify = { verified: [{ source: "qq", id: "1" }], rejected: 0 };
    const r = await batchJobHandlers["song-search-import"](
      { providerId: "prov", songs: [{ id: "1", name: "n", artist: "a", source: "qq" }] },
      ctx().c,
    );
    expect(r.reverify.enabled).toBe(true);
    expect(r.reverify.passed).toBe(1);
    expect(r.reverify.rejectedTitles).toEqual([]);
  });

  it("song-search-import:二次门禁开启但 provider 未配置 → 静默跳过,不阻断", async () => {
    H.cfg["core-import-gate"] = { reverifyUserPicked: true };
    H.provider = null;
    const r = await batchJobHandlers["song-search-import"](
      { providerId: "prov", songs: [{ id: "1" }] },
      ctx().c,
    );
    expect(r.reverify).toBeUndefined();
    expect(r.success).toBe(true);
  });
});

// ---------------- 在线匹配 ----------------
describe("在线匹配", () => {
  it("provider 未配置 → 抛错", async () => {
    await expect(batchJobHandlers["match-playlist"]({ providerId: "p" }, ctx().c)).rejects.toThrow(
      "在线源未启用或未配置",
    );
  });

  it("match-playlist:正常匹配并回传进度", async () => {
    H.provider = { config: {}, provider: {} };
    const c = ctx();
    const r = await batchJobHandlers["match-playlist"]({ providerId: "p", playlistId: "pl-1" }, c.c);
    expect(r).toEqual(H.matchResult);
  });

  it("match-playlists:无占位条目 → alreadyMatched", async () => {
    H.provider = { config: {}, provider: {} };
    const r = await batchJobHandlers["match-playlists"]({ providerId: "p" }, ctx().c);
    expect(r.alreadyMatched).toBe(true);
    expect(r.total).toBe(0);
  });

  it("match-playlists:逐张匹配,单张失败记入 error 不中断", async () => {
    H.provider = { config: {}, provider: {} };
    const pid = "pl-batch-" + Date.now();
    sqlite
      .prepare("INSERT INTO playlists (id, name, owner_id) VALUES (?, ?, ?)")
      .run(pid, "待匹配", "u1");
    sqlite
      .prepare("INSERT INTO playlist_songs (playlist_id, playable, external_title) VALUES (?, 0, ?)")
      .run(pid, "占位歌曲");
    H.matchThrows = true;
    const c = ctx();
    const r = await batchJobHandlers["match-playlists"]({ providerId: "p" }, c.c);
    expect(r.alreadyMatched).toBe(false);
    expect(r.total).toBe(1);
    expect(r.results[0].error).toContain("匹配服务炸了");
    expect(c.progress.length).toBeGreaterThan(0);
    sqlite.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").run(pid);
    sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(pid);
  });
});

// ---------------- 其余 handler ----------------
describe("其余批量任务", () => {
  it("recommend-sync-all:转发 providerId", async () => {
    const r = await batchJobHandlers["recommend-sync-all"]({ providerId: "qq", userId: "u1" }, ctx().c);
    expect(H.calls.find((c) => c.fn === "syncAllRecommendPlaylists")!.args[0]).toBe("qq");
    expect(r.synced).toBe(1);
  });

  it("purge-web-songs:转发 providerId", async () => {
    await batchJobHandlers["purge-web-songs"]({ providerId: "qq" }, ctx().c);
    expect(H.calls.find((c) => c.fn === "purgeExpiredWebSongs")!.args[0]).toBe("qq");
  });

  it("scrape-artists:空 id 列表直接返回 0(不触达刮削)", async () => {
    const r = await batchJobHandlers["scrape-artists"]({ artistIds: [] }, ctx().c);
    expect(r.scraped).toBe(0);
    expect(H.calls.filter((c) => c.fn === "scrapeArtistList").length).toBe(0);
  });

  it("scrape-artists:非空列表 → 刮削并转发进度", async () => {
    const c = ctx();
    const r = await batchJobHandlers["scrape-artists"]({ artistIds: ["a1", "a2"] }, c.c);
    expect(r.scraped).toBe(2);
    expect(c.progress.some((p) => p.done === 2)).toBe(true);
  });

  it("backfill:未知类型 → 抛错", async () => {
    await expect(batchJobHandlers["backfill"]({ kind: "nope" }, ctx().c)).rejects.toThrow("未知批量补全类型");
  });

  it("backfill:lyrics → runBackfillLoop", async () => {
    H.backfillRows = [{ id: "s1" }, { id: "s2" }];
    const r = await batchJobHandlers["backfill"]({ kind: "lyrics" }, ctx().c);
    const call = H.calls.find((c) => c.fn === "runBackfillLoop")!;
    expect(call.args[0]).toBe("lyrics");
    expect(r.ok).toBe(true);
  });

  it("backfill:covers-batch → runBackfillChunked(只传 id 数组)", async () => {
    H.backfillRows = [{ id: "s1" }];
    const r = await batchJobHandlers["backfill"]({ kind: "covers-batch" }, ctx().c);
    const call = H.calls.find((c) => c.fn === "runBackfillChunked")!;
    expect(call.args[0]).toEqual(["s1"]);
    expect(r.chunked).toBe(true);
  });

  it("plugin-job:插件未启用或未实现该方法 → 抛错", async () => {
    await expect(
      batchJobHandlers["plugin-job"]({ pluginId: "none", method: "runDailyJob" }, ctx().c),
    ).rejects.toThrow("未启用或未实现");
  });

  it("plugin-job:正常调用插件方法", async () => {
    let got: any = null;
    H.plugins["pj"] = { impl: { doIt: async (o: any) => { got = o; return 42; } } };
    const r = await batchJobHandlers["plugin-job"]({ pluginId: "pj", method: "doIt", opts: { a: 1 } }, ctx().c);
    expect(got).toEqual({ a: 1 });
    expect(r).toBe(42);
  });

  it("plugin-job:未传 opts → 以空对象调用", async () => {
    let got: any = null;
    H.plugins["pj2"] = { impl: { doIt: async (o: any) => { got = o; return 1; } } };
    await batchJobHandlers["plugin-job"]({ pluginId: "pj2", method: "doIt" }, ctx().c);
    expect(got).toEqual({});
  });
});

// ---------------- 推荐手动刷新 ----------------
describe("推荐手动刷新(recommend-refresh)", () => {
  it("默认 targets=daily/local/roam 全跑,seedSalt 原样透传", async () => {
    H.access.dailyRecommend = { generateDailyPlaylist: async (d: Date, o: any) => ({ k: "daily", o }) };
    H.access.localRecommend = { generateLocalDailyPlaylist: async (d: Date, o: any) => ({ k: "local", o }) };
    H.access.comboPlaylist = { generateComboPlaylist: async (o: any) => ({ k: "roam", o }) };
    const r = await batchJobHandlers["recommend-refresh"]({ seedSalt: 7 }, ctx().c);
    expect(r.seedSalt).toBe(7);
    expect(r.results.daily.o).toEqual({ force: true, seedSalt: 7 });
    expect(r.results.local.o.force).toBe(true);
    expect(r.results.roam.o.force).toBe(true);
  });

  it("按指定 targets 子集执行", async () => {
    H.access.dailyRecommend = { generateDailyPlaylist: async () => ({ k: "daily" }) };
    const r = await batchJobHandlers["recommend-refresh"]({ targets: ["daily"] }, ctx().c);
    expect(Object.keys(r.results)).toEqual(["daily"]);
  });

  it("每日推荐插件未启用 → 抛错", async () => {
    await expect(batchJobHandlers["recommend-refresh"]({ targets: ["daily"] }, ctx().c)).rejects.toThrow(
      "每日推荐插件未启用",
    );
  });

  it("本地推荐/漫游插件未启用 → 抛错", async () => {
    H.access.dailyRecommend = { generateDailyPlaylist: async () => ({}) };
    await expect(batchJobHandlers["recommend-refresh"]({ targets: ["local"] }, ctx().c)).rejects.toThrow(
      "本地推荐插件未启用",
    );
    await expect(batchJobHandlers["recommend-refresh"]({ targets: ["roam"] }, ctx().c)).rejects.toThrow(
      "今日漫游插件未启用",
    );
  });

  it("已 abort → 抛错(刷新任务被中止)", async () => {
    const c = ctx();
    c.abort();
    await expect(batchJobHandlers["recommend-refresh"]({ targets: ["daily"] }, c.c)).rejects.toThrow(
      "刷新任务被中止",
    );
  });
});
