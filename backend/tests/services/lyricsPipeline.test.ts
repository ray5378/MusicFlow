// 歌词「取词管线」(fetchLrcForSong 四级兜底) 的行为测试。
// 管线顺序:① 落库歌词 → ② sidecar .lrc(本地/WebDAV) → ③ lyricProvider 在线按需
//          → ④ web 歌曲 legacy 源插件 lyricUrl。
// 未覆盖面(基线 lcov):42-44(元数据无时间戳行)、107-110(缓存定期清理)、
// 218-240(④ 源插件路径)、247-251(getLyricsForSongId 查无此歌)、259(解析为空)。
import "../plugins/_env.js";
import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";
import { sqlite, db } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { parseLrc } from "../../src/services/lyrics.js";

const H = vi.hoisted(() => {
  return {
    settings: { getSettingBool: vi.fn() },
    store: { saveLyricFile: vi.fn(), resolveLyricContent: vi.fn() },
    registry: { getPluginImpl: vi.fn(), getPluginConfig: vi.fn() },
    providers: { hasLyricProvider: vi.fn(), searchLyrics: vi.fn() },
  };
});

vi.mock("../../src/services/settings.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getSettingBool: H.settings.getSettingBool,
}));
vi.mock("../../src/services/lyricsStore.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  saveLyricFile: H.store.saveLyricFile,
  resolveLyricContent: H.store.resolveLyricContent,
}));
vi.mock("../../src/plugins/registry.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getPluginImpl: H.registry.getPluginImpl,
  getPluginConfig: H.registry.getPluginConfig,
}));
vi.mock("../../src/plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  hasLyricProvider: H.providers.hasLyricProvider,
  searchLyrics: H.providers.searchLyrics,
}));

const {
  fetchLrcForSong,
  getLyricsForSongId,
  getLyricsForSong,
  clearLyricsCache,
  getLyricsCacheEntries,
} = await import("../../src/services/lyrics.js");

/** 默认把开关摆在「只走 ① 落库」的位置,各用例按需覆盖。 */
function defaultSettings(onDemand = false, persist = false) {
  H.settings.getSettingBool.mockImplementation((k: string, d: boolean) =>
    k === "lyrics.onDemand" ? (onDemand ?? d) : k === "lyrics.persist" ? persist : d,
  );
}

function seedSong(id: string, extra: Record<string, any> = {}) {
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO songs (id, title, path, type, artist, album) VALUES (?,?,?,?,?,?)",
    )
    .run(id, `T-${id}`, extra.path ?? `l:src1/a/${id}.mp3`, extra.type ?? "local", "歌手", "专辑");
  if (extra.type) sqlite.prepare("UPDATE songs SET type = ? WHERE id = ?").run(extra.type, id);
  if ("lyrics" in extra) {
    sqlite.prepare("UPDATE songs SET lyrics = ? WHERE id = ?").run(extra.lyrics ?? null, id);
  }
  if ("sourceData" in extra) {
    sqlite.prepare("UPDATE songs SET source_data = ? WHERE id = ?").run(extra.sourceData, id);
  }
  if ("pluginEntry" in extra) {
    sqlite.prepare("UPDATE songs SET plugin_entry = ? WHERE id = ?").run(extra.pluginEntry, id);
  }
}

/** 在 CWD 下造一个「本地文件」(.mp3 + 同目录占位),返回相对 CWD 的 path 形态。 */
const MADE_DIRS: string[] = [];
function makeLocalTrack(os: any, osPath: any) {
  const relDir = `tests/.tmp-lrc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  os.mkdirSync(relDir, { recursive: true });
  MADE_DIRS.push(relDir);
  const rel = `${relDir}/track`;
  os.writeFileSync(`${rel}.mp3`, "x");
  return { base: rel, path: rel };
}

function seedSource(id: string, config: Record<string, any>) {
  sqlite
    .prepare("INSERT OR IGNORE INTO media_sources (id, name, type, config) VALUES (?,?,?,?)")
    .run(id, `S-${id}`, "webdav", JSON.stringify(config));
}

/** 必须用 drizzle 取行:lyrics.ts 读的是 songs.type / songs.pluginEntry 等驼峰属性,
 * 而原生 `SELECT *` 给的是 snake_case(songs.type 拿不到 -> ④ 源插件分支整条静默跳过)。 */
function row(id: string): any {
  return db.select().from(songs).where(eq(songs.id, id)).get();
}

beforeEach(() => {
  clearLyricsCache();
  vi.resetAllMocks();
  H.store.resolveLyricContent.mockImplementation((raw: string | null) => raw ?? null);
  H.store.saveLyricFile.mockReturnValue(`${"x"}.lrc`);
  H.providers.hasLyricProvider.mockReturnValue(false);
  H.providers.searchLyrics.mockResolvedValue(null);
  H.registry.getPluginImpl.mockReturnValue(undefined);
  H.registry.getPluginConfig.mockReturnValue({});
  defaultSettings();
});

afterEach(() => {
  clearLyricsCache();
  vi.useRealTimers();
});

afterAll(() => {
  // 别把临时目录留在仓库里
  if (MADE_DIRS.length) {
    const os = require("node:fs") as any;
    for (const d of MADE_DIRS) os.rmSync(d, { recursive: true, force: true });
  }
});

describe("fetchLrcForSong 缓存面", () => {
  it("缓存命中时不再查库、不再问 provider(第二次调用零外部 IO)", async () => {
    const id = "c1";
    seedSong(id, { lyrics: "[00:01.00]缓存行" });
    H.store.resolveLyricContent.mockReturnValue("[00:02.00]第二次" as any);

    const first = await fetchLrcForSong({ id, path: "l:s/c1.mp3", title: "T" } as any);
    expect(first).toBe("[00:02.00]第二次");

    const before = H.providers.searchLyrics.mock.calls.length;
    const second = await fetchLrcForSong({ id, path: "l:s/c1.mp3", title: "T" } as any);
    expect(second).toBe("[00:02.00]第二次");
    expect(H.providers.searchLyrics.mock.calls.length).toBe(before);
    expect(getLyricsCacheEntries()).toBe(1);
  });

  it("缓存里存 null 也算命中(负缓存:同一首歌不会每个请求都重试 provider)", async () => {
    const id = "c2";
    seedSong(id);
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue(null);
    defaultSettings(true);

    expect(await fetchLrcForSong({ id, path: "l:s/c2.mp3", title: "T" } as any)).toBeNull();
    expect(getLyricsCacheEntries()).toBe(1);

    // provider 这回「有货了」,但缓存 ttl(10min) 内不该回头再问
    H.providers.searchLyrics.mockResolvedValue("[00:03.00]迟到");
    expect(await fetchLrcForSong({ id, path: "l:s/c2.mp3", title: "T" } as any)).toBeNull();
    expect(H.providers.searchLyrics).toHaveBeenCalledTimes(1);
  });

  it("clearLyricsCache 清空条目数(供空闲内存回收)", async () => {
    seedSong("c3", { lyrics: "[00:01.00]x" });
    await fetchLrcForSong({ id: "c3", path: "l:s/c3.mp3", title: "T" } as any);
    expect(getLyricsCacheEntries()).toBeGreaterThan(0);
    clearLyricsCache();
    expect(getLyricsCacheEntries()).toBe(0);
  });

});

describe("fetchLrcForSong ① 落库歌词", () => {
  it("① 优先:落库有词时不再去读 sidecar / provider", async () => {
    const id = "d1";
    seedSong(id, { lyrics: "online-lyrics/d1.lrc" });
    H.store.resolveLyricContent.mockReturnValue("[00:05.00]落库词" as any);

    const r = await fetchLrcForSong({ id, path: "w:src1/a/x.mp3", url: "http://x/y.mp3" } as any);
    expect(r).toBe("[00:05.00]落库词");
    expect(H.providers.searchLyrics).not.toHaveBeenCalled();
  });

  it("① 查询抛错被吞掉,继续走 ② sidecar", async () => {
    const id = "d2";
    seedSong(id, { lyrics: "online-lyrics/d2.lrc" });
    H.store.resolveLyricContent.mockReturnValue("[00:06.00]落库" as any);
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:07.00]" + "provider" as any);
    defaultSettings(true);
    seedSource("src1", { url: "http://webdav.local/music/" });

    const spy = vi.spyOn(sqlite, "prepare").mockImplementation((() => {
      throw new Error("boom");
    }) as any);

    const r = await fetchLrcForSong({ id, path: "w:src1/a/x.mp3", url: "http://x/y.mp3" } as any);
    spy.mockRestore();
    // SELECT 抛错 → 当作无落库歌词;接着 provider 命中
    expect(r).toBe("[00:07.00]provider");
  });

  it("落库 lyrics 为 null 时不碰 resolveLyricContent,直接落到下一级兜底", async () => {
    const id = "d3";
    seedSong(id, { lyrics: null });
    H.store.resolveLyricContent.mockReturnValue(null);
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:08.00]provider" as any);
    defaultSettings(true);

    const r = await fetchLrcForSong({ id, path: "l:src1/a/x.mp3", title: "T" } as any);
    expect(r).toBe("[00:08.00]provider");
    expect(H.store.resolveLyricContent).not.toHaveBeenCalled();
  });
});

describe("fetchLrcForSong ② sidecar .lrc", () => {
  it("path 没有冒号 → 直接视为无 sidecar", async () => {
    const r = await fetchLrcForSong({ id: "s1", path: "no-colon.mp3", title: "T" } as any);
    expect(r).toBeNull();
  });

  it("path 前缀不是 w:/l: → 直接视为无 sidecar", async () => {
    const r = await fetchLrcForSong({ id: "s2", path: "x:src1/a.mp3", title: "T" } as any);
    expect(r).toBeNull();
  });

  it("前缀后的第二段(源 id)缺失冒号 → 视为无 sidecar", async () => {
    const r = await fetchLrcForSong({ id: "s3", path: "l:onlysource", title: "T" } as any);
    expect(r).toBeNull();
  });

  it("源 id 在库里不存在 → 视为无 sidecar(不打网络)", async () => {
    const r = await fetchLrcForSong({ id: "s4", path: "l:missing:/a.mp3", title: "T" } as any);
    expect(r).toBeNull();
  });

  it("本地歌 l: 命中同目录 .lrc(替换扩展名 + .lrc)", async () => {
    const os = await import("node:fs");
    const osPath = await import("node:path");
    const rel = makeLocalTrack(os, osPath);
    os.writeFileSync(`${rel.base}.lrc`, "[00:01.00]本地 sidecar");

    seedSource("lsrc", { url: "http://irrelevant" });
    // path 一律用「相对 CWD」的形态:readSidecarLrc 的 l: 分支是直接 existsSync(相对路径)
    const r = await fetchLrcForSong({ id: "s5", path: `l:lsrc:${rel.path}.mp3`, title: "T" } as any);
    expect(r).toBe("[00:01.00]本地 sidecar");
  });

  it("本地歌 l: 同目录没有 .lrc → 继续用 provider(不报错)", async () => {
    const os = await import("node:fs");
    const osPath = await import("node:path");
    const rel = makeLocalTrack(os, osPath);
    seedSource("lsrc2", { url: "http://irrelevant" });
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:09.00]provider" as any);
    defaultSettings(true);

    const r = await fetchLrcForSong({ id: "s6", path: `l:lsrc2:${rel.path}.mp3`, title: "T" } as any);
    expect(r).toBe("[00:09.00]provider");
  });

  it("webdav(w:) 走同目录 URL,尾斜杠被去掉、不带凭据时不带 Authorization 头", async () => {
    seedSource("wsrc", { url: "http://webdav.local/music///" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "[00:11.00]WebDAV sidecar" } as any);
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchLrcForSong({ id: "s7", path: "w:wsrc:album/track.mp3", title: "T" } as any);
    expect(r).toBe("[00:11.00]WebDAV sidecar");
    const [url, init] = fetchMock.mock.calls[0] as any;
    // D21 修复:拼地址时保留源配置里的子目录 (/music/),并在 base 与 lrcPath 之间补 "/",
    // 不再拼成 "host名专辑" 这种非法 URL。期望拼成 http://webdav.local/music/album/track.lrc。
    expect(url).toBe("http://webdav.local/music/album/track.lrc");
    expect(init.headers.Range).toBe("bytes=0-65535");
    expect(init.headers.Authorization).toBeUndefined();
    fetchMock.mockRestore();
  });

  it("webdav(w:) 配了用户名密码 → 带 Basic 头", async () => {
    seedSource("wsrc2", { url: "http://webdav.local/music", username: "u1", password: "p1" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "[00:12.00]带凭据" } as any);
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchLrcForSong({ id: "s8", path: "w:wsrc2:album/track.mp3", title: "T" } as any);
    expect(r).toBe("[00:12.00]带凭据");
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(init.headers.Authorization).toBe(
      "Basic " + Buffer.from("u1:p1").toString("base64"),
    );
    fetchMock.mockRestore();
  });

  it("webdav(w:) 只填了用户名没密码 → 不带 Authorization 头", async () => {
    seedSource("wsrc3", { url: "http://webdav.local/music", username: "u1" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "[00:13.00]半凭据" } as any);
    vi.stubGlobal("fetch", fetchMock);

    await fetchLrcForSong({ id: "s9", path: "w:wsrc3:album/track.mp3", title: "T" } as any);
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(init.headers.Authorization).toBeUndefined();
    fetchMock.mockRestore();
  });

  it("webdav(w:) config 没有 url → 不发请求", async () => {
    seedSource("wsrc4", {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchLrcForSong({ id: "s10", path: "w:wsrc4:album/track.mp3", title: "T" } as any);
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("webdav(w:) 源 config 非法 JSON → 兜成 {} 后视为无 url,不发请求", async () => {
    sqlite
      .prepare("INSERT OR IGNORE INTO media_sources (id, name, type, config) VALUES (?,?,?,?)")
      .run("wsrc5", "S5", "webdav", "{not json");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchLrcForSong({ id: "s11", path: "w:wsrc5:album/track.mp3", title: "T" } as any);
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("webdav(w:) 404 → 视为无 sidecar,继续兜底", async () => {
    seedSource("wsrc6", { url: "http://webdav.local/music" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 } as any);
    vi.stubGlobal("fetch", fetchMock);
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:14.00]provider" as any);
    defaultSettings(true);

    const r = await fetchLrcForSong({ id: "s12", path: "w:wsrc6:album/track.mp3", title: "T" } as any);
    expect(r).toBe("[00:14.00]provider");
    fetchMock.mockRestore();
  });
});

describe("fetchLrcForSong ③ 在线 provider", () => {
  it("onDemand 关 → 完全不问 provider", async () => {
    H.settings.getSettingBool.mockImplementation((k: string, d: boolean) =>
      k === "lyrics.onDemand" ? false : d,
    );
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:20.00]provider" as any);

    const r = await fetchLrcForSong({ id: "p1", path: "l:src1/a.mp3", title: "T" } as any);
    expect(r).toBeNull();
    expect(H.providers.searchLyrics).not.toHaveBeenCalled();
  });

  it("没有启用任何 lyricProvider → 不进 provider 分支", async () => {
    H.providers.hasLyricProvider.mockReturnValue(false);
    H.providers.searchLyrics.mockResolvedValue("[00:21.00]provider" as any);
    defaultSettings(true);

    const r = await fetchLrcForSong({ id: "p2", path: "l:src1/a.mp3", title: "T" } as any);
    expect(r).toBeNull();
  });

  it("provider 未命中(null) → 落到 ④,不落库", async () => {
    seedSong("p3", { type: "web", pluginEntry: "go-music-dl" });
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue(null);
    defaultSettings(true, true);
    H.registry.getPluginImpl.mockReturnValue({
      lyricUrl: () => "http://legacy/lyric.mp3",
    });

    const r = await fetchLrcForSong(row("p3") as any);
    expect(r).toBeNull(); // ④ 里没有 fetch 桩 → 抛错被吞
    expect(H.store.saveLyricFile).not.toHaveBeenCalled();
  });

  it("provider 命中 + persist 关 → 只返回,不落库", async () => {
    const id = "p4";
    seedSong(id);
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:22.00]provider词" as any);
    defaultSettings(true, false);

    const r = await fetchLrcForSong(row(id) as any);
    expect(r).toBe("[00:22.00]provider词");
    expect(H.store.saveLyricFile).not.toHaveBeenCalled();
    // 只改内存缓存,库里 lyrics 仍是 null
    expect(row(id).lyrics).toBeNull();
  });

  it("provider 命中 + persist 开 → 落库成文件引用并写回 songs.lyrics(拉一次永存)", async () => {
    const id = "p5";
    seedSong(id);
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:23.00]provider词" as any);
    defaultSettings(true, true);
    H.store.saveLyricFile.mockReturnValue("p5.lrc");

    const r = await fetchLrcForSong(row(id) as any);
    expect(r).toBe("[00:23.00]provider词");
    expect(H.store.saveLyricFile).toHaveBeenCalledWith(id, "[00:23.00]provider词");
    expect(row(id).lyrics).toBe("p5.lrc");
  });

  it("provider 命中但落库失败(返回 null)→ 不影响本次返回值", async () => {
    const id = "p6";
    seedSong(id);
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:24.00]provider词" as any);
    defaultSettings(true, true);
    H.store.saveLyricFile.mockReturnValue(null);

    const r = await fetchLrcForSong(row(id) as any);
    expect(r).toBe("[00:24.00]provider词");
    expect(row(id).lyrics).toBeNull();
  });

  it("传给 provider 的上下文带 source/album/extra(供插件做同平台优先回退)", async () => {
    const id = "p7";
    seedSong(id, { sourceData: JSON.stringify({ source: "qq", extra: { a: 1 } }) });
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:25.00]x" as any);
    defaultSettings(true);

    await fetchLrcForSong({ id, path: "l:src1/a.mp3", title: "歌名", artist: "歌手", album: "专辑", url: "http://u/s.mp3", duration: 240, sourceData: JSON.stringify({ source: "qq", extra: { a: 1 } }) } as any);
    expect(H.providers.searchLyrics).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "歌名",
        artist: "歌手",
        album: "专辑",
        source: "qq",
        extra: { a: 1 },
        duration: 240,
      }),
    );
  });

  it("sourceData 不是合法 JSON → 兜成 {} ,不抛错", async () => {
    const id = "p8";
    seedSong(id, { sourceData: "{bad" });
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:26.00]x" as any);
    defaultSettings(true);

    const r = await fetchLrcForSong(row(id) as any);
    expect(r).toBe("[00:26.00]x");
    expect(H.providers.searchLyrics).toHaveBeenCalledWith(
      expect.objectContaining({ source: undefined, extra: null }),
    );
  });
});

describe("fetchLrcForSong ④ web 源插件 lyricUrl", () => {
  it("web 歌但没配 pluginEntry → 不进 ④", async () => {
    seedSong("w1", { type: "web" });
    H.registry.getPluginImpl.mockReturnValue({ lyricUrl: () => "http://x/lrc" });
    vi.stubGlobal("fetch", vi.fn());

    const r = await fetchLrcForSong(row("w1") as any);
    expect(r).toBeNull();
    expect(H.registry.getPluginImpl).not.toHaveBeenCalled();
  });

  it("插件没有 lyricUrl → 不进抓取", async () => {
    seedSong("w2", { type: "web", pluginEntry: "go-music-dl" });
    H.registry.getPluginImpl.mockReturnValue({ searchLyrics: () => "x" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchLrcForSong(row("w2") as any);
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pluginEntry 查不到实现(null) → 静默当无歌词", async () => {
    seedSong("w3", { type: "web", pluginEntry: "ghost" });
    H.registry.getPluginImpl.mockReturnValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchLrcForSong(row("w3") as any)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lyricUrl 返回空串 → 不抓取", async () => {
    seedSong("w4", { type: "web", pluginEntry: "go-music-dl" });
    H.registry.getPluginImpl.mockReturnValue({ lyricUrl: () => "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchLrcForSong(row("w4") as any)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("抓取成功且非「Lyric not found」→ 采用", async () => {
    seedSong("w5", { type: "web", pluginEntry: "go-music-dl" });
    H.registry.getPluginImpl.mockReturnValue({ lyricUrl: () => "http://legacy/lyric.mp3" });
    H.registry.getPluginConfig.mockReturnValue({ token: "t" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "[00:30.00]插件词" } as any);
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchLrcForSong(row("w5") as any);
    expect(r).toBe("[00:30.00]插件词");
    expect(fetchMock.mock.calls[0][0]).toBe("http://legacy/lyric.mp3");
    expect(H.registry.getPluginConfig).toHaveBeenCalledWith("go-music-dl");
  });

  it("插件拿不到配置 → 兜成 {} 再传给 lyricUrl", async () => {
    seedSong("w6", { type: "web", pluginEntry: "go-music-dl" });
    const urlFn = vi.fn().mockReturnValue("http://legacy/lyric.mp3");
    H.registry.getPluginImpl.mockReturnValue({ lyricUrl: urlFn });
    H.registry.getPluginConfig.mockReturnValue(null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "[00:31.00]x" } as any));

    await fetchLrcForSong(row("w6") as any);
    expect(H.registry.getPluginConfig).toHaveBeenCalledWith("go-music-dl");
    expect(urlFn).toHaveBeenCalledWith({}, expect.objectContaining({ title: "T-w6" }));
  });

  it("正文以 'Lyric not found' 开头 → 当作无歌词(插件的标准空答复)", async () => {
    seedSong("w7", { type: "web", pluginEntry: "go-music-dl" });
    H.registry.getPluginImpl.mockReturnValue({ lyricUrl: () => "http://legacy/lyric.mp3" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "Lyric not found",
    } as any));

    expect(await fetchLrcForSong(row("w7") as any)).toBeNull();
  });

  it("正文为空串 → 当作无歌词", async () => {
    seedSong("w8", { type: "web", pluginEntry: "go-music-dl" });
    H.registry.getPluginImpl.mockReturnValue({ lyricUrl: () => "http://legacy/lyric.mp3" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "" } as any));

    expect(await fetchLrcForSong(row("w8") as any)).toBeNull();
  });

  it("响应非 ok → 当作无歌词", async () => {
    seedSong("w9", { type: "web", pluginEntry: "go-music-dl" });
    H.registry.getPluginImpl.mockReturnValue({ lyricUrl: () => "http://legacy/lyric.mp3" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 } as any));

    expect(await fetchLrcForSong(row("w9") as any)).toBeNull();
  });

  it("抓取抛错(网络/超时)→ 静默吞掉,不把异常冒给调用方", async () => {
    seedSong("w10", { type: "web", pluginEntry: "go-music-dl" });
    H.registry.getPluginImpl.mockReturnValue({ lyricUrl: () => "http://legacy/lyric.mp3" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ETIMEDOUT")));

    await expect(fetchLrcForSong(row("w10") as any)).resolves.toBeNull();
  });

  it("lyricUrl 抛出异常 → 静默当无歌词(与 fetch 失败兜底一致,不冒给调用方)", async () => {
    seedSong("w11", { type: "web", pluginEntry: "go-music-dl" });
    H.registry.getPluginImpl.mockReturnValue({
      lyricUrl: () => {
        throw new Error("plugin blew up");
      },
    });

    // D22 修复:impl.lyricUrl(...) 的调用已包进 try/catch,异常被吞掉并记 warn 日志,
    // fetchLrcForSong 返回 null(无歌词),不再把异常冒给上层导致 500。
    await expect(fetchLrcForSong(row("w11") as any)).resolves.toBeNull();
  });

  it("lyricUrl 拿到的上下文带 url/duration/title/artist", async () => {
    seedSong("w12", { type: "web", pluginEntry: "go-music-dl" });
    const urlFn = vi.fn().mockReturnValue("http://legacy/lyric.mp3");
    H.registry.getPluginImpl.mockReturnValue({ lyricUrl: urlFn });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "[00:32.00]x" } as any));

    await fetchLrcForSong(row("w12") as any);
    expect(urlFn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      url: null,
      duration: 0,
      title: "T-w12",
      artist: "歌手",
    }));
  });
});

describe("getLyricsForSongId / getLyricsForSong", () => {
  it("歌在库里不存在 → null(不打 provider)", async () => {
    H.providers.hasLyricProvider.mockReturnValue(true);
    defaultSettings(true);

    expect(await getLyricsForSongId("不存在")).toBeNull();
    expect(H.providers.searchLyrics).not.toHaveBeenCalled();
  });

  it("库里有歌词 → 解析成带时间轴的行", async () => {
    const id = "g1";
    seedSong(id, { lyrics: "g1.lrc" });
    H.store.resolveLyricContent.mockReturnValue("[00:01.00]第一\n[00:02.00]第二");
    H.store.saveLyricFile.mockReturnValue(null);

    const lines = await getLyricsForSongId(id);
    expect(lines).toEqual([
      { time: 1, text: "第一" },
      { time: 2, text: "第二" },
    ]);
  });

  it("歌词内容为空 → 返回 null(而不是空数组,避免调用方拿到 [] 还要再判空)", async () => {
    const id = "g2";
    seedSong(id);
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:33.00]x\n[00:34.00]y" as any);
    defaultSettings(true);

    const lines = await getLyricsForSongId(id);
    expect(lines).toEqual([
      { time: 33, text: "x" },
      { time: 34, text: "y" },
    ]);
  });

  it("取不到任何歌词内容 → null", async () => {
    const id = "g3";
    seedSong(id);
    H.providers.hasLyricProvider.mockReturnValue(false);

    expect(await getLyricsForSongId(id)).toBeNull();
  });

  it("getLyricsForSong 接受未入库的虚拟歌曲(远程直放复用同一管线)", async () => {
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[00:40.00]远程词" as any);
    defaultSettings(true);

    const lines = await getLyricsForSong({
      id: "not-in-db",
      title: "远程歌",
      url: "http://x/y.mp3",
      type: "web",
    });
    expect(lines).toEqual([{ time: 40, text: "远程词" }]);
  });

  it("getLyricsForSong:有内容但解析不出任何行 → null", async () => {
    H.providers.hasLyricProvider.mockReturnValue(true);
    H.providers.searchLyrics.mockResolvedValue("[ti:只有元信息]" as any);
    defaultSettings(true);

    expect(await getLyricsForSong({ id: "empty", title: "T" })).toBeNull();
  });
});

describe("parseLrc 兜底面", () => {
  it("无时间戳的普通文本行被跳过(元数据行与非元数据行走的是同一条 continue)", () => {
    // [ti:]/[ar:] 走 `if (metaRegex.test(trimmed)) continue;`
    const a = parseLrc("[ti:歌名]\n[ar:歌手]\n[al:专辑]");
    expect(a).toEqual([]);
    // 纯文本行(无时间戳、也不是元数据)走到第 54 行那次 continue
    const b = parseLrc("这是一行没有时间戳的歌词正文");
    expect(b).toEqual([]);
    // 两者混排
    const c = parseLrc("[ti:歌名]\n正文一行\n[00:01.00]有时间戳\n正文二行");
    expect(c).toEqual([{ time: 1, text: "有时间戳" }]);
  });

  it("时间戳后面没文字 → 跳过(不产出空文本行)", () => {
    const a = parseLrc("[00:01.00]\n[00:02.00]有词");
    expect(a).toEqual([{ time: 2, text: "有词" }]);
  });

  it("只有 <mm:ss.xx> 逐字标签没有行级时间戳 → 跳过(标签不是行时间轴)", () => {
    const a = parseLrc("<00:01.00>天<00:01.50>地\n[00:02.00]有词");
    expect(a).toEqual([{ time: 2, text: "有词" }]);
  });

  it("空串 / 只有换行 → 空数组", () => {
    expect(parseLrc("")).toEqual([]);
    expect(parseLrc("\n\n\r\n")).toEqual([]);
  });

  it("结果按时间升序(乱序写进来的歌词文件也能拿到正确时间轴)", () => {
    const a = parseLrc("[00:30.00]三\n[00:10.00]一\n[00:20.00]二");
    expect(a.map((l) => l.time)).toEqual([10, 20, 30]);
  });
});
