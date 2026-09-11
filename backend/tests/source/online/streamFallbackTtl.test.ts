// 缓存 TTL 守卫（2026-09-11 修「永久拉黑」）。
//
// 覆盖：
//   - 负结果(所有平台都无候选)在 negativeTtl 过期后会**重新探测**（≠ 永久拉黑）
//   - 正结果(确认可播)在 1 小时内不重探、超过后重新探测
//   - 网络异常/超时**不判定不可播**，只短期退避后重试
//   - probeStream 三态：ok / gone(403,404,410) / transient(429,5xx,异常)
//   - getCachedPlayability 四态（unknown / playable / unplayable / transient）
//   - configureStreamFallbackCache 覆写生效
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../../plugins/_env.js";

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { initDatabase, db, sqlite } from "../../../src/db/index.js";
import { songs } from "../../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { registerPlugin, unregisterPlugin } from "../../../src/plugins/registry.js";
import {
  findFallbackStream,
  ensurePlayableStream,
  clearStreamFallbackCache,
  configureStreamFallbackCache,
  getCachedPlayability,
  probeStream,
  PROBE_TIMEOUT_DEFAULT_MS,
} from "../../../src/services/source/online/streamFallback.js";

const PROVIDER = "gmdl-ttl-test";

const manifestOf = {
  id: PROVIDER,
  name: PROVIDER,
  version: "1.0.0",
  type: "source",
  capabilities: ["search", "stream"],
  platforms: ["netease", "kugou", "qq"],
  configSchema: [],
  permissions: ["net"],
  sourcePreference: ["kugou", "netease", "qq"],
} as const;

// ---- 可控的时间：只位移 Date.now()，不 fake timers（避免 AbortSignal.timeout 挂死） ----
let nowShift = 0;
const realNow = Date.now;

// ---- 可控的 fetch ----
let fetchHandler: (url: string) => Response | Promise<Response> = () => new Response("bytes", { status: 206 });
const fetchCalls: string[] = [];

vi.stubGlobal("fetch", async (url: string) => {
  fetchCalls.push(String(url));
  return fetchHandler(String(url));
});

function enableProvider(cands: any[]) {
  const searchCalls: string[] = [];
  const provider = {
    id: PROVIDER,
    manifest: manifestOf,
    search: async (_config: any, params: any) => {
      searchCalls.push(params.query || "");
      return { songs: cands };
    },
    streamUrl: (_config: any, song: any) => `http://gm:18080/music/download?id=${song.id}&source=${song.source}`,
  };
  registerPlugin(manifestOf as any, provider);
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, '{}', ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, manifest = excluded.manifest, config = '{}'
  `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), new Date().toISOString(), new Date().toISOString());
  return { searchCalls };
}

function seedSong(id: string, opts: { url: string; title?: string | null; artist?: string | null }) {
  db.insert(songs).values({
    id,
    title: opts.title ?? null,
    artist: opts.artist ?? null,
    album: "黑马",
    coverArt: null,
    duration: 275,
    path: `web:${PROVIDER}:qq`,
    contentType: "audio/mpeg",
    suffix: "mp3",
    discNumber: 1,
    track: 0,
    genre: "",
    size: 0,
    playCount: 0,
    url: opts.url,
    fingerprint: `fp-${id}`,
    type: "web",
    pluginEntry: PROVIDER,
    sourceData: JSON.stringify({ source: "qq" }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();
}

function songRowOf(id: string) {
  return db.select().from(songs).where(eq(songs.id, id)).get() as any;
}

/** 只有歌名+歌手匹配的候选会被采纳；艺人不符即被门禁拦掉(ranked 为空)。 */
const MISMATCHED_CAND = { id: "wrong", name: "恋人", artist: "王俊凯", album: "黑马", duration: 275, source: "netease" };
const MATCHED_CAND = { id: "n1", name: "恋人", artist: "李荣浩", album: "黑马", duration: 275, source: "netease" };

beforeAll(() => {
  initDatabase();
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + nowShift);
});

afterEach(() => {
  nowShift = 0;
  fetchCalls.length = 0;
  fetchHandler = () => new Response("bytes", { status: 206 });
  clearStreamFallbackCache();
  configureStreamFallbackCache({
    playableTtlMs: 60 * 60 * 1000,
    negativeTtlMs: 45 * 1000,
    transientBackoffMs: 5 * 1000,
  });
  sqlite.prepare("DELETE FROM songs WHERE plugin_entry = ?").run(PROVIDER);
  sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(PROVIDER);
  unregisterPlugin(PROVIDER);
});

describe("缓存 TTL — 负结果不是永久拉黑", () => {
  it("全部候选被门禁拦下 → 写负结果；negativeTtl(45s) 过期后重新探测", async () => {
    const { searchCalls } = enableProvider([MISMATCHED_CAND]);
    seedSong("ttl-neg", { url: "http://orig/broken.mp3", title: "恋人", artist: "李荣浩" });

    expect(await findFallbackStream("ttl-neg", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(1);
    expect(getCachedPlayability("ttl-neg")).toBe("unplayable");

    // TTL 内：命中负缓存，不再发搜索请求
    expect(await findFallbackStream("ttl-neg", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(1);

    // 过期后：重新探测 —— 这是「源恢复自动复活」的关键（旧实现此处永远返回 null）
    nowShift = 46_000;
    expect(getCachedPlayability("ttl-neg")).toBe("unknown");
    expect(await findFallbackStream("ttl-neg", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(2);
  });

  it("负结果过期后若源已恢复 → 换源命中（完整复活链路）", async () => {
    const { searchCalls } = enableProvider([MISMATCHED_CAND]);
    seedSong("ttl-revive", { url: "http://orig/broken.mp3", title: "恋人", artist: "李荣浩" });
    // 原链一律 404（触发换源），候选 URL 一律 206（可播）。
    fetchHandler = (url) => new Response("", { status: url.includes("orig") ? 404 : 206 });

    expect(await ensurePlayableStream(songRowOf("ttl-revive"))).toBeNull();
    expect(searchCalls.length).toBe(1);

    // 平台侧恢复：候选改为艺人一致
    enableProvider([MATCHED_CAND]);
    nowShift = 46_000;

    const url = await ensurePlayableStream(songRowOf("ttl-revive"));
    expect(url).toBeTruthy();
    expect(url).toContain("id=n1");
    expect((songRowOf("ttl-revive").url as string)).toContain("id=n1");
  });
});

describe("缓存 TTL — 正结果 1 小时", () => {
  it("1 小时内不重探；超过 1 小时后重新探测", async () => {
    enableProvider([]);
    seedSong("ttl-pos", { url: "http://orig/good.mp3", title: "恋人", artist: "李荣浩" });
    fetchHandler = () => new Response("bytes", { status: 206 });
    const countOrigProbes = () => fetchCalls.filter(u => u.includes("good")).length;

    expect(await ensurePlayableStream(songRowOf("ttl-pos"))).toBe("http://orig/good.mp3");
    expect(countOrigProbes()).toBe(1);
    expect(getCachedPlayability("ttl-pos")).toBe("playable");

    nowShift = 59 * 60 * 1000; // 59 分钟：仍在正缓存内
    expect(await ensurePlayableStream(songRowOf("ttl-pos"))).toBe("http://orig/good.mp3");
    expect(countOrigProbes()).toBe(1);

    nowShift = 61 * 60 * 1000; // 61 分钟：过期 → 重新探测
    expect(await ensurePlayableStream(songRowOf("ttl-pos"))).toBe("http://orig/good.mp3");
    expect(countOrigProbes()).toBe(2);
  });
});

describe("缓存 TTL — 网络异常不判定不可播", () => {
  it("候选探测抛异常 → 记 transient（不是 unplayable），5s 退避后重试", async () => {
    const { searchCalls } = enableProvider([MATCHED_CAND]);
    fetchHandler = () => { throw new Error("network down"); };

    expect(await findFallbackStream("ttl-transient", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(getCachedPlayability("ttl-transient")).toBe("transient"); // 关键：不是 unplayable
    expect(searchCalls.length).toBe(1);

    // 5s 退避内：不再探测
    nowShift = 3_000;
    expect(await findFallbackStream("ttl-transient", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(1);

    // 退避过后：立刻重试（不等 45s 的负 TTL）
    nowShift = 6_000;
    expect(await findFallbackStream("ttl-transient", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(2);
  });

  it("搜索请求本身失败 → 同样记 transient，不判定不可播", async () => {
    const provider = {
      id: PROVIDER,
      manifest: manifestOf,
      search: async () => { throw new Error("upstream 502"); },
      streamUrl: () => "http://gm/x",
    };
    registerPlugin(manifestOf as any, provider);
    sqlite.prepare(`
      INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
      VALUES (?, ?, '1.0.0', '', ?, 1, '{}', ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = 1
    `).run(PROVIDER, PROVIDER, JSON.stringify(manifestOf), new Date().toISOString(), new Date().toISOString());

    expect(await findFallbackStream("ttl-searchfail", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(getCachedPlayability("ttl-searchfail")).toBe("transient");
  });
});

describe("probeStream — 三态判定", () => {
  it("200/206 → ok", async () => {
    fetchHandler = () => new Response("bytes", { status: 206 });
    expect(await probeStream("http://x/a", PROBE_TIMEOUT_DEFAULT_MS)).toBe("ok");
    fetchHandler = () => new Response("bytes", { status: 200 });
    expect(await probeStream("http://x/a", PROBE_TIMEOUT_DEFAULT_MS)).toBe("ok");
  });

  it("403/404/410 → gone（明确不存在，可据此判定不可播）", async () => {
    for (const status of [403, 404, 410]) {
      fetchHandler = () => new Response("", { status });
      expect(await probeStream("http://x/a", PROBE_TIMEOUT_DEFAULT_MS)).toBe("gone");
    }
  });

  it("429/5xx/异常 → transient（不可判定）", async () => {
    for (const status of [429, 500, 502, 503]) {
      fetchHandler = () => new Response("", { status });
      expect(await probeStream("http://x/a", PROBE_TIMEOUT_DEFAULT_MS)).toBe("transient");
    }
    fetchHandler = () => { throw new Error("timeout"); };
    expect(await probeStream("http://x/a", PROBE_TIMEOUT_DEFAULT_MS)).toBe("transient");
  });

  it("空 URL → gone（不是 transient）", async () => {
    expect(await probeStream("", PROBE_TIMEOUT_DEFAULT_MS)).toBe("gone");
  });
});

describe("getCachedPlayability — 四态", () => {
  it("无记录 → unknown（调用方不得据此跳过）", () => {
    expect(getCachedPlayability("never-seen")).toBe("unknown");
    expect(getCachedPlayability("")).toBe("unknown");
  });

  it("原链可播 → playable；全候选不可播 → unplayable", async () => {
    enableProvider([MISMATCHED_CAND]);
    seedSong("ttl-play", { url: "http://orig/good.mp3", title: "恋人", artist: "李荣浩" });
    seedSong("ttl-dead", { url: "http://orig/broken.mp3", title: "恋人", artist: "李荣浩" });
    fetchHandler = (url) => new Response("", { status: url.includes("good") ? 206 : 404 });

    expect(await ensurePlayableStream(songRowOf("ttl-play"))).toBeTruthy();
    expect(getCachedPlayability("ttl-play")).toBe("playable");

    expect(await ensurePlayableStream(songRowOf("ttl-dead"))).toBeNull();
    expect(getCachedPlayability("ttl-dead")).toBe("unplayable");
  });
});

describe("configureStreamFallbackCache — 覆写生效", () => {
  it("覆写 negativeTtlMs 后，负结果按新 TTL 过期", async () => {
    configureStreamFallbackCache({ negativeTtlMs: 2_000 });
    const { searchCalls } = enableProvider([MISMATCHED_CAND]);

    expect(await findFallbackStream("ttl-cfg", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(1);

    nowShift = 1_500; // 未到 2s
    expect(await findFallbackStream("ttl-cfg", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(1);

    nowShift = 2_500; // 超过 2s
    expect(await findFallbackStream("ttl-cfg", "恋人", "李荣浩", "黑马", 275, PROVIDER, "qq")).toBeNull();
    expect(searchCalls.length).toBe(2);
  });
});
