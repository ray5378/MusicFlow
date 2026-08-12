// 歌词/封面按需获取(媒体获取)端到端测试:
//   - 全局设置读写(settings.ts)
//   - 独立选源 filterProvidersByPreference / searchLyrics 只查选中插件
//   - fetchLrcForSong:本地歌曲缺歌词 → lyricProvider 回退 + persist 落库
//   - fetchCoverForSong:按需下载缓存 + persist 写 cover_art + 防风暴
//   - startBackfill:批量补全落库
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { db, initDatabase, sqlite } from "../../src/db/index.js";
import { songs, mediaSources, plugins } from "../../src/db/schema.js";
import { registerPlugin } from "../../src/plugins/registry.js";
import { getSetting, setSetting } from "../../src/services/settings.js";
import { filterProvidersByPreference, searchLyrics } from "../../src/plugins/providers.js";
import { fetchLrcForSong } from "../../src/services/lyrics.js";
import { fetchCoverForSong, clearCoverAttempt } from "../../src/services/covers.js";
import { resolveCoverFile } from "../../src/services/playlistCover.js";
import { startBackfill, backfillStatus } from "../../src/services/backfill.js";

const manifestOf = (id: string, caps: string[]) => ({
  id, name: id, version: "1.0.0", type: "lyrics",
  capabilities: caps, configSchema: [], permissions: ["net"],
});

function enablePlugin(id: string, caps: string[], impl: any = {}) {
  registerPlugin(manifestOf(id, caps), impl);
  db.insert(plugins).values({
    id, name: id, version: "1.0.0", description: "",
    manifest: JSON.stringify(manifestOf(id, caps)), enabled: 1, config: "{}",
  }).run();
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let coverServer: http.Server | null = null;
let coverPort = 0;

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(mediaSources).values({ id: "src", name: "Local", type: "local", enabled: 1, config: "{}" }).run();
  // 极小 JPEG(≥100 字节,cacheRemoteCover 有 100 字节下限)
  const img = Buffer.alloc(256);
  img.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], 0);
  img.set([0xff, 0xd9], 254);
  coverServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": img.length });
    res.end(img);
  });
  await new Promise<void>((r) => coverServer!.listen(0, "127.0.0.1", r));
  coverPort = (coverServer.address() as any).port;
});

afterAll(async () => {
  if (coverServer) await new Promise((r) => coverServer.close(r));
});

describe("settings 全局键值读写", () => {
  it("set 后 get 即时生效(写失效缓存)", () => {
    setSetting("test.providerId", "abc");
    expect(getSetting("test.providerId", "")).toBe("abc");
    expect(getSetting("test.missing", "def")).toBe("def");
  });
});

describe("filterProvidersByPreference 独立选源", () => {
  const list = [{ manifest: { id: "a" } }, { manifest: { id: "b" } }] as any;

  it("未设置 → 返回全部(现状 first-match)", () => {
    setSetting("lyrics.providerId", "");
    expect(filterProvidersByPreference(list, "lyrics.providerId").length).toBe(2);
  });

  it("设置且命中 → 只返回选中插件", () => {
    setSetting("lyrics.providerId", "b");
    const r = filterProvidersByPreference(list, "lyrics.providerId");
    expect(r.length).toBe(1);
    expect(r[0].manifest.id).toBe("b");
  });

  it("选中插件被禁用/卸载 → 回退全部", () => {
    setSetting("lyrics.providerId", "not-installed");
    expect(filterProvidersByPreference(list, "lyrics.providerId").length).toBe(2);
    setSetting("lyrics.providerId", "");
  });
});

describe("lyrics:本地歌曲缺歌词 → provider 回退 + persist 落库", () => {
  beforeAll(() => {
    enablePlugin("fake-lyrics", ["lyricProvider"], {
      searchLyrics: async () => ({ lrc: "[00:00.00]hello from provider" }),
    });
  });

  it("sidecar 缺失时经 provider 拿到 LRC,persist 开则写入 songs.lyrics", async () => {
    setSetting("lyrics.onDemand", "true");
    setSetting("lyrics.persist", "true");
    setSetting("lyrics.providerId", "");
    db.insert(songs).values({
      id: "lg1", title: "Song One", artist: "Artist", path: "l:src:/tmp/nonexist-1.mp3",
      type: "local", suffix: "mp3", duration: 100,
    }).run();
    const lrc = await fetchLrcForSong({
      id: "lg1", path: "l:src:/tmp/nonexist-1.mp3", title: "Song One", artist: "Artist", type: "local", duration: 100,
    });
    expect(lrc).toContain("hello from provider");
    const row = sqlite.prepare("SELECT lyrics FROM songs WHERE id = ?").get("lg1") as any;
    expect(row.lyrics).toContain("hello from provider");
  });

  it("A(onDemand) 关闭时不再访问 provider", async () => {
    setSetting("lyrics.onDemand", "false");
    setSetting("lyrics.persist", "false");
    db.insert(songs).values({
      id: "lg2", title: "Song Two", artist: "Artist", path: "l:src:/tmp/nonexist-2.mp3",
      type: "local", suffix: "mp3", duration: 100,
    }).run();
    const lrc = await fetchLrcForSong({
      id: "lg2", path: "l:src:/tmp/nonexist-2.mp3", title: "Song Two", artist: "Artist", type: "local", duration: 100,
    });
    expect(lrc).toBeNull();
    setSetting("lyrics.onDemand", "true");
  });

  it("searchLyrics 独立选源:设置 providerId 后只查选中插件", async () => {
    let callsA = 0, callsB = 0;
    enablePlugin("fake-lyr-a", ["lyricProvider"], { searchLyrics: async () => { callsA++; return { lrc: "[00:00.00]A" }; } });
    enablePlugin("fake-lyr-b", ["lyricProvider"], { searchLyrics: async () => { callsB++; return { lrc: "[00:00.00]B" }; } });
    setSetting("lyrics.providerId", "fake-lyr-b");
    const r = await searchLyrics({ title: "x", artist: "y" });
    expect(r).toContain("B");
    expect(callsA).toBe(0);
    expect(callsB).toBe(1);
    setSetting("lyrics.providerId", "");
  });
});

describe("covers:按需下载 + persist + 防风暴", () => {
  beforeAll(() => {
    enablePlugin("fake-cover", ["coverProvider"], {
      searchCover: async () => ({ url: `http://127.0.0.1:${coverPort}/c.jpg` }),
    });
  });

  it("已有 cover_art 直接返回,不访问 provider", async () => {
    db.insert(songs).values({
      id: "cv3", title: "With Cover", artist: "A", path: "l:src:/tmp/cover.mp3",
      type: "local", suffix: "mp3", cover_art: "cv3.jpg",
    }).run();
    const ref = await fetchCoverForSong({ id: "cv3", title: "With Cover", artist: "A", coverArt: "cv3.jpg" });
    expect(ref).toBe("cv3.jpg");
  });

  it("无封面 → 下载缓存成本地文件并写回 cover_art(B 默认开)", async () => {
    setSetting("cover.onDemand", "true");
    setSetting("cover.persist", "true");
    setSetting("cover.providerId", "fake-cover");
    db.insert(songs).values({
      id: "cv1", title: "No Cover", artist: "A", path: "l:src:/tmp/nc.mp3",
      type: "local", suffix: "mp3",
    }).run();
    const ref = await fetchCoverForSong({ id: "cv1", title: "No Cover", artist: "A" });
    expect(ref).toBe("cv1.jpg");
    const row = sqlite.prepare("SELECT cover_art FROM songs WHERE id = ?").get("cv1") as any;
    expect(row.cover_art).toBe("cv1.jpg");
    expect(resolveCoverFile("cv1.jpg")).not.toBeNull();
  });

  it("防风暴:失败后 TTL 内不重复触发 provider", async () => {
    let calls = 0;
    enablePlugin("fake-cover-fail", ["coverProvider"], { searchCover: async () => { calls++; return null; } });
    setSetting("cover.providerId", "fake-cover-fail");
    clearCoverAttempt("cv2");
    db.insert(songs).values({
      id: "cv2", title: "Fail Cover", artist: "A", path: "l:src:/tmp/fc.mp3",
      type: "local", suffix: "mp3",
    }).run();
    await fetchCoverForSong({ id: "cv2", title: "Fail Cover", artist: "A" });
    await fetchCoverForSong({ id: "cv2", title: "Fail Cover", artist: "A" });
    expect(calls).toBe(1);
    setSetting("cover.providerId", "");
    clearCoverAttempt("cv2");
  });

  it("A(onDemand) 关闭时不访问 provider", async () => {
    let calls = 0;
    enablePlugin("fake-cover-off", ["coverProvider"], { searchCover: async () => { calls++; return { url: "http://x/c.jpg" }; } });
    setSetting("cover.onDemand", "false");
    setSetting("cover.providerId", "fake-cover-off");
    clearCoverAttempt("cv4");
    db.insert(songs).values({
      id: "cv4", title: "Off Cover", artist: "A", path: "l:src:/tmp/oc.mp3",
      type: "local", suffix: "mp3",
    }).run();
    const ref = await fetchCoverForSong({ id: "cv4", title: "Off Cover", artist: "A" });
    expect(ref).toBeNull();
    expect(calls).toBe(0);
    setSetting("cover.onDemand", "true");
    setSetting("cover.providerId", "");
  });
});

describe("backfill:歌词批量补全总是落库", () => {
  it("缺歌词的歌曲经 provider 补全并写入 songs.lyrics", async () => {
    setSetting("lyrics.onDemand", "true");
    setSetting("lyrics.persist", "true");
    setSetting("lyrics.providerId", "fake-lyrics");
    db.insert(songs).values({
      id: "bf1", title: "Backfill", artist: "A", path: "l:src:/tmp/bf.mp3",
      type: "local", suffix: "mp3",
    }).run();
    const res = startBackfill("lyrics");
    expect(res.accepted).toBe(true);
    expect(res.total).toBeGreaterThanOrEqual(1);
    const t0 = Date.now();
    while (backfillStatus("lyrics").running && Date.now() - t0 < 8000) await wait(100);
    const job = backfillStatus("lyrics");
    expect(job.running).toBe(false);
    expect(job.ok).toBeGreaterThanOrEqual(1);
    const row = sqlite.prepare("SELECT lyrics FROM songs WHERE id = ?").get("bf1") as any;
    expect(row.lyrics).toContain("hello from provider");
  });
});
