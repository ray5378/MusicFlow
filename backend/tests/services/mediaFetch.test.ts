// 歌词/封面按需获取(媒体获取)端到端测试:
//   - 全局设置读写(settings.ts)
//   - 独立选源 filterProvidersByPreference / searchLyrics 只查选中插件
//   - fetchLrcForSong:本地/WebDAV 歌曲缺歌词 → lyricProvider 回退 + persist 落库为文件
//   - 歌词落库新格式:songs.lyrics 存文件引用(online-lyrics/<id>.lrc),旧文本兼容
//   - sidecar .lrc 优先(本地文件 / WebDAV URL)
//   - 插件未启用(hasLyricProvider=false)时不获取(1.7.4 用户"没成功获取"根因场景)
//   - fetchCoverForSong:按需下载缓存 + persist 写 cover_art + 防风暴
//   - startBackfill:批量补全落库为文件
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import os from "os";
import path from "path";
import fs from "fs";
import { db, initDatabase, sqlite } from "../../src/db/index.js";
import { songs, mediaSources, plugins } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin } from "../../src/plugins/registry.js";
import { getSetting, setSetting } from "../../src/services/settings.js";
import { filterProvidersByPreference, searchLyrics } from "../../src/plugins/providers.js";
import { fetchLrcForSong } from "../../src/services/lyrics.js";
import { fetchCoverForSong, clearCoverAttempt } from "../../src/services/covers.js";
import { resolveCoverFile } from "../../src/services/playlistCover.js";
import { readLyricFile, resolveLyricContent, deleteSongLyric, saveLyricFile } from "../../src/services/lyricsStore.js";
import { startBackfill, backfillStatus } from "../../src/services/backfill.js";

const manifestOf = (id: string, caps: string[]) => ({
  id, name: id, version: "1.0.0", type: "lyrics",
  capabilities: caps, configSchema: [], permissions: ["net"],
});

function enablePlugin(id: string, caps: string[], impl: any = {}) {
  registerPlugin(manifestOf(id, caps), impl);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      manifest = excluded.manifest, enabled = 1, updated_at = excluded.updated_at
  `).run(id, id, JSON.stringify(manifestOf(id, caps)), new Date().toISOString(), new Date().toISOString());
}

function disablePlugin(id: string) {
  db.update(plugins).set({ enabled: 0 }).where(eq(plugins.id, id)).run();
}

/** 禁用所有声明某能力的插件(测试隔离用,避免残留插件污染后续用例)。 */
function disableAllByCap(cap: string) {
  sqlite.prepare(`UPDATE plugins SET enabled = 0 WHERE manifest LIKE '%"${cap}"%'`).run();
}

/** 启用所有声明某能力的插件(配合 disableAllByCap 恢复)。 */
function enableAllByCap(cap: string) {
  sqlite.prepare(`UPDATE plugins SET enabled = 1 WHERE manifest LIKE '%"${cap}"%'`).run();
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let coverServer: http.Server | null = null;
let coverPort = 0;

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(mediaSources).values({ id: "src", name: "Local", type: "local", enabled: 1, config: "{}" }).run();
  // WebDAV 源:本地 HTTP server 模拟(带 /dav 根路径,sidecar .lrc 与音频同目录)。
  db.insert(mediaSources).values({
    id: "wdav", name: "WebDAV", type: "webdav", enabled: 1,
    config: JSON.stringify({ url: `http://127.0.0.1:0/dav`, username: "u", password: "p" }),
  }).run();
  // 极小 JPEG(≥100 字节,cacheRemoteCover 有 100 字节下限)
  const img = Buffer.alloc(256);
  img.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], 0);
  img.set([0xff, 0xd9], 254);
  const LRC_OK = "[00:00.00]webdav sidecar lyric";
  const LRC_OTHER = "[00:00.00]other sidecar lyric";
  coverServer = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    const p = u.pathname;
    if (p.endsWith("/ok.lrc")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(LRC_OK);
    } else if (p.endsWith("/other.lrc")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(LRC_OTHER);
    } else if (p.endsWith(".jpg") || p.endsWith(".png")) {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": img.length });
      res.end(img);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => coverServer!.listen(0, "127.0.0.1", r));
  coverPort = (coverServer.address() as any).port;
  // 修正 WebDAV 源的真实端口
  db.update(mediaSources).set({
    config: JSON.stringify({ url: `http://127.0.0.1:${coverPort}/dav`, username: "u", password: "p" }),
  }).where(eq(mediaSources.id, "wdav")).run();
  // 文件级注册默认 provider:shuffle 时各 describe 的 beforeAll 不保证先于他
  // describe 的用例执行,若 provider 只在 describe beforeAll 注册,backfill 等
  // 用例跑到前面会找不到插件(曾见 ok=0 / 拿到别的 provider 输出)。
  enablePlugin("fake-lyrics", ["lyricProvider"], {
    searchLyrics: async () => ({ lrc: "[00:00.00]hello from provider" }),
  });
  enablePlugin("fake-cover", ["coverProvider"], {
    searchCover: async () => ({ url: `http://127.0.0.1:${coverPort}/c.jpg` }),
  });
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

describe("lyrics:本地歌曲缺歌词 → provider 回退 + persist 落库为文件", () => {
  it("sidecar 缺失时经 provider 拿到 LRC,persist 开则写文件引用", async () => {
    setSetting("lyrics.onDemand", "true");
    setSetting("lyrics.persist", "true");
    // 显式选 fake-lyrics:shuffle 时其他 provider(fake-lyr-wd 等)可能已先注册,
    // first-match 模式下不指定会拿到它们(曾见 [00:00.00]provider)。
    setSetting("lyrics.providerId", "fake-lyrics");
    db.insert(songs).values({
      id: "lg1", title: "Song One", artist: "Artist", path: "l:src:/tmp/nonexist-1.mp3",
      type: "local", suffix: "mp3", duration: 100,
    }).run();
    const lrc = await fetchLrcForSong({
      id: "lg1", path: "l:src:/tmp/nonexist-1.mp3", title: "Song One", artist: "Artist", type: "local", duration: 100,
    });
    expect(lrc).toContain("hello from provider");
    // 落库新格式:列存引用 <id>.lrc,文件在 online-lyrics/
    const row = sqlite.prepare("SELECT lyrics FROM songs WHERE id = ?").get("lg1") as any;
    expect(row.lyrics).toBe("lg1.lrc");
    expect(readLyricFile("lg1.lrc")).toContain("hello from provider");
  });

  it("列内旧文本(v1.7.4 兼容)直接当歌词返回", async () => {
    db.insert(songs).values({
      id: "lg-legacy", title: "Legacy", artist: "A", path: "l:src:/tmp/legacy.mp3",
      type: "local", suffix: "mp3",
    }).run();
    sqlite.prepare("UPDATE songs SET lyrics = ? WHERE id = ?").run("[00:00.00]legacy text", "lg-legacy");
    const lrc = await fetchLrcForSong({
      id: "lg-legacy", path: "l:src:/tmp/legacy.mp3", title: "Legacy", artist: "A", type: "local", duration: 100,
    });
    expect(lrc).toBe("[00:00.00]legacy text");
    expect(resolveLyricContent("[00:00.00]legacy text")).toBe("[00:00.00]legacy text");
  });

  it("lrcCache 10min 缓存:同一首歌在 TTL 内重复调用不重新走 provider(改配置后需重启/换歌才生效)", async () => {
    let calls = 0;
    enablePlugin("fake-lyrics-cache", ["lyricProvider"], {
      searchLyrics: async () => { calls++; return { lrc: "[00:00.00]cached-v1" }; },
    });
    setSetting("lyrics.onDemand", "true");
    setSetting("lyrics.persist", "false");
    setSetting("lyrics.providerId", "fake-lyrics-cache");
    db.insert(songs).values({
      id: "lg-cache", title: "Cache", artist: "A", path: "l:src:/tmp/cache.mp3",
      type: "local", suffix: "mp3",
    }).run();
    const first = await fetchLrcForSong({ id: "lg-cache", path: "l:src:/tmp/cache.mp3", title: "Cache", artist: "A", type: "local" });
    expect(first).toContain("cached-v1");
    // 即使现在禁用 provider 并清空 DB 歌词,TTL 内仍返回缓存内容
    disablePlugin("fake-lyrics-cache");
    sqlite.prepare("UPDATE songs SET lyrics = NULL WHERE id = ?").run("lg-cache");
    const second = await fetchLrcForSong({ id: "lg-cache", path: "l:src:/tmp/cache.mp3", title: "Cache", artist: "A", type: "local" });
    expect(second).toContain("cached-v1");
    expect(calls).toBe(1); // provider 只被调一次,第二次纯缓存
    setSetting("lyrics.providerId", "");
  });

  it("本地 sidecar .lrc 优先于 provider(存在时不再访问插件)", async () => {
    let calls = 0;
    enablePlugin("fake-lyrics-2", ["lyricProvider"], {
      searchLyrics: async () => { calls++; return { lrc: "[00:00.00]provider" }; },
    });
    setSetting("lyrics.providerId", "fake-lyrics-2");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mfv2-lrc-"));
    const audio = path.join(dir, "side.mp3");
    fs.writeFileSync(audio, "x");
    fs.writeFileSync(path.join(dir, "side.lrc"), "[00:00.00]local sidecar");
    db.insert(songs).values({
      id: "lg3", title: "Sidecar", artist: "A", path: `l:src:${audio}`,
      type: "local", suffix: "mp3",
    }).run();
    const lrc = await fetchLrcForSong({ id: "lg3", path: `l:src:${audio}`, title: "Sidecar", artist: "A", type: "local" });
    expect(lrc).toBe("[00:00.00]local sidecar");
    expect(calls).toBe(0); // sidecar 命中,不访问 provider
    setSetting("lyrics.providerId", "");
    fs.rmSync(dir, { recursive: true, force: true });
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

  it("只用 A(B 关):能拿到歌词但 DB 不写,再次请求仍实时查插件(不落库)", async () => {
    let calls = 0;
    enablePlugin("fake-lyrics-aonly", ["lyricProvider"], {
      searchLyrics: async () => { calls++; return { lrc: "[00:00.00]a-only lyric" }; },
    });
    setSetting("lyrics.onDemand", "true");
    setSetting("lyrics.persist", "false"); // B 关 = 只用 A
    setSetting("lyrics.providerId", "fake-lyrics-aonly");
    db.insert(songs).values({
      id: "lg-aonly", title: "A Only", artist: "A", path: "l:src:/tmp/aonly.mp3",
      type: "local", suffix: "mp3",
    }).run();
    const lrc = await fetchLrcForSong({ id: "lg-aonly", path: "l:src:/tmp/aonly.mp3", title: "A Only", artist: "A", type: "local" });
    expect(lrc).toContain("a-only lyric");
    // B 关:DB 不落库
    const row = sqlite.prepare("SELECT lyrics FROM songs WHERE id = ?").get("lg-aonly") as any;
    expect(row.lyrics).toBeNull();
    expect(readLyricFile("lg-aonly.lrc")).toBeNull();
    setSetting("lyrics.providerId", "");
  });

  it("插件未启用(hasLyricProvider=false)时不获取 —— 1.7.4 用户失败根因场景", async () => {
    // 禁用所有 lyricProvider 插件 → ③ 分支直接跳过
    disableAllByCap("lyricProvider");
    setSetting("lyrics.onDemand", "true");
    setSetting("lyrics.persist", "true");
    db.insert(songs).values({
      id: "lg4", title: "No Plugin", artist: "A", path: "l:src:/tmp/nonexist-4.mp3",
      type: "local", suffix: "mp3",
    }).run();
    const lrc = await fetchLrcForSong({ id: "lg4", path: "l:src:/tmp/nonexist-4.mp3", title: "No Plugin", artist: "A", type: "local" });
    expect(lrc).toBeNull();
    const row = sqlite.prepare("SELECT lyrics FROM songs WHERE id = ?").get("lg4") as any;
    expect(row.lyrics).toBeNull();
    // 恢复全部 lyricProvider 插件(测试隔离)
    enableAllByCap("lyricProvider");
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

describe("lyrics:WebDAV 歌曲(w: 路径)完整链路", () => {
  // 描述块级注册 provider:保证"无 sidecar"等用例不依赖"sidecar 优先"用例
  // 先跑先注册(shuffle 时顺序不定,曾见 fake-lyr-wd 未注册 → 拿不到 provider)。
  beforeAll(() => {
    enablePlugin("fake-lyr-wd", ["lyricProvider"], {
      searchLyrics: async () => ({ lrc: "[00:00.00]provider" }),
    });
  });

  it("WebDAV sidecar .lrc 优先于 provider", async () => {
    let calls = 0;
    enablePlugin("fake-lyr-wd", ["lyricProvider"], {
      searchLyrics: async () => { calls++; return { lrc: "[00:00.00]provider" }; },
    });
    setSetting("lyrics.providerId", "fake-lyr-wd");
    // path = w:<sourceId>:<绝对路径>,sidecar 与该文件同目录
    db.insert(songs).values({
      id: "wd1", title: "WebDAV OK", artist: "A",
      path: `w:wdav:/dav/ok.mp3`, type: "local", suffix: "mp3",
    }).run();
    const lrc = await fetchLrcForSong({ id: "wd1", path: "w:wdav:/dav/ok.mp3", title: "WebDAV OK", artist: "A", type: "local" });
    expect(lrc).toBe("[00:00.00]webdav sidecar lyric");
    expect(calls).toBe(0);
    setSetting("lyrics.providerId", "");
  });

  it("WebDAV 无 sidecar(404) → provider 获取 + persist 落库为文件", async () => {
    setSetting("lyrics.onDemand", "true");
    setSetting("lyrics.persist", "true");
    setSetting("lyrics.providerId", "fake-lyr-wd");
    db.insert(songs).values({
      id: "wd2", title: "WebDAV No Sidecar", artist: "A",
      path: "w:wdav:/dav/nosidecar.mp3", type: "local", suffix: "mp3",
    }).run();
    const lrc = await fetchLrcForSong({ id: "wd2", path: "w:wdav:/dav/nosidecar.mp3", title: "WebDAV No Sidecar", artist: "A", type: "local" });
    expect(lrc).toContain("provider");
    const row = sqlite.prepare("SELECT lyrics FROM songs WHERE id = ?").get("wd2") as any;
    expect(row.lyrics).toBe("wd2.lrc");
    expect(readLyricFile("wd2.lrc")).toContain("provider");
    setSetting("lyrics.providerId", "");
  });

  it("WebDAV 其他目录 sidecar 也能命中(路径正确拼接)", async () => {
    db.insert(songs).values({
      id: "wd3", title: "WebDAV Other", artist: "A",
      path: "w:wdav:/dav/other.mp3", type: "local", suffix: "mp3",
    }).run();
    const lrc = await fetchLrcForSong({ id: "wd3", path: "w:wdav:/dav/other.mp3", title: "WebDAV Other", artist: "A", type: "local" });
    expect(lrc).toBe("[00:00.00]other sidecar lyric");
  });

  it("删除歌词文件(deleteSongLyric)配合删歌清理", () => {
    // 自包含:不依赖前序用例已写 wd2.lrc(shuffle 时该用例可能后置)。
    saveLyricFile("wd2", "[00:00.00]x");
    expect(readLyricFile("wd2.lrc")).not.toBeNull();
    expect(deleteSongLyric("wd2")).toBe(1);
    expect(readLyricFile("wd2.lrc")).toBeNull();
    expect(deleteSongLyric("wd2")).toBe(0); // 再删返回 0
  });
});

describe("covers:按需下载 + persist + 防风暴", () => {
  it("已有 cover_art 直接返回,不访问 provider", async () => {
    db.insert(songs).values({
      id: "cv3", title: "With Cover", artist: "A", path: "l:src:/tmp/cover.mp3",
      type: "local", suffix: "mp3", cover_art: "cv3.jpg",
    }).run();
    const ref = await fetchCoverForSong({ id: "cv3", title: "With Cover", artist: "A", coverArt: "cv3.jpg" });
    expect(ref).toBe("cv3.jpg");
  });

  it("本地歌曲无封面 → 下载缓存成本地文件并写回 cover_art(B 默认开)", async () => {
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

  it("WebDAV 歌曲无封面 → 同样经 provider 获取并落库", async () => {
    setSetting("cover.providerId", "fake-cover");
    clearCoverAttempt("cv5");
    db.insert(songs).values({
      id: "cv5", title: "WebDAV Cover", artist: "A", path: "w:wdav:/dav/cv5.mp3",
      type: "local", suffix: "mp3",
    }).run();
    const ref = await fetchCoverForSong({ id: "cv5", title: "WebDAV Cover", artist: "A" });
    expect(ref).toBe("cv5.jpg");
    const row = sqlite.prepare("SELECT cover_art FROM songs WHERE id = ?").get("cv5") as any;
    expect(row.cover_art).toBe("cv5.jpg");
    setSetting("cover.providerId", "");
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

  it("只用 A(B 关):能下载封面文件返回 ref,但 cover_art 不落库", async () => {
    setSetting("cover.onDemand", "true");
    setSetting("cover.persist", "false"); // B 关 = 只用 A
    setSetting("cover.providerId", "fake-cover");
    clearCoverAttempt("cv6");
    db.insert(songs).values({
      id: "cv6", title: "Cover A Only", artist: "A", path: "l:src:/tmp/ao.mp3",
      type: "local", suffix: "mp3",
    }).run();
    const ref = await fetchCoverForSong({ id: "cv6", title: "Cover A Only", artist: "A" });
    expect(ref).toBe("cv6.jpg");
    expect(resolveCoverFile("cv6.jpg")).not.toBeNull(); // 文件已缓存,本次即可显示
    // B 关:cover_art 不写库
    const row = sqlite.prepare("SELECT cover_art FROM songs WHERE id = ?").get("cv6") as any;
    expect(row.cover_art).toBeNull();
    setSetting("cover.persist", "true");
    setSetting("cover.providerId", "");
  });
});

describe("backfill:歌词/封面批量补全", () => {
  it("缺歌词的本地歌曲经 provider 补全并落库为文件引用", async () => {
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
    expect(row.lyrics).toBe("bf1.lrc");
    expect(readLyricFile("bf1.lrc")).toContain("hello from provider");
    setSetting("lyrics.providerId", "");
  });

  it("缺封面的 WebDAV 歌曲批量补全", async () => {
    setSetting("cover.onDemand", "true");
    setSetting("cover.persist", "true");
    setSetting("cover.providerId", "fake-cover");
    db.insert(songs).values({
      id: "bf2", title: "Backfill Cover", artist: "A", path: "w:wdav:/dav/bf2.mp3",
      type: "local", suffix: "mp3",
    }).run();
    const res = startBackfill("covers");
    expect(res.accepted).toBe(true);
    const t0 = Date.now();
    while (backfillStatus("covers").running && Date.now() - t0 < 8000) await wait(100);
    const job = backfillStatus("covers");
    expect(job.running).toBe(false);
    expect(job.ok).toBeGreaterThanOrEqual(1);
    const row = sqlite.prepare("SELECT cover_art FROM songs WHERE id = ?").get("bf2") as any;
    expect(row.cover_art).toBe("bf2.jpg");
    setSetting("cover.providerId", "");
  });
});
