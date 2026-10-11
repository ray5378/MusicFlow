// ==================== QA 独立回归:播放来源优先级(stream.sourcePriority) ====================
//
// 由 QA(Edward/Yan)独立编写,刻意**不复用**工程师用例的参数与断言路径:
//   - 每个用例先把内置源插件全部「停用」(UPDATE plugins SET enabled=0),再注册自己的
//     受控 mock 插件 —— 使 getEnabledSourcePlugins / getConfiguredProvider / 枚举结果
//     完全确定,不被 230 上默认启用的内置插件(go-music-dl / lx-source 等)干扰。
//   - 用「调用序列」断言取源顺序(而非只看最终 url),以证明「本尊是否被调用」「列表顺序」。
//   - 覆盖工程师用例未触及的错误/混合路径:search 抛错后续命中、probe 三态切换、
//     非存在 pluginId / 只 search 无 stream / 尾冒号 / 非法条目的安全空操作。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDatabase, db, sqlite } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import { _resetSettingsCacheForTest, setSetting } from "../../src/services/settings.js";
import {
  STREAM_SOURCE_PRIORITY_KEY,
  getStreamSourcePriority,
  setStreamSourcePriority,
  listAvailableStreamSources,
} from "../../src/services/source/online/streamSourcePriority.js";
import {
  clearStreamFallbackCache,
  findFallbackStream,
  getCachedPlayability,
} from "../../src/services/source/online/streamFallback.js";

initDatabase();

const NOW = new Date().toISOString();
const cleanups: Array<() => void> = [];

function persistEnabled(id: string, manifest: any) {
  sqlite
    .prepare(
      "INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at) VALUES (?,?,?,?,?,1,'{}',?,?) ON CONFLICT(id) DO UPDATE SET enabled = 1, manifest = excluded.manifest",
    )
    .run(id, id, manifest.version || "1.0.0", "", JSON.stringify(manifest), NOW, NOW);
}

/** 注册一个受控 mock 源插件(默认落库启用)。 */
function reg(id: string, caps: string[], impl: any, extra: Record<string, any> = {}, enabled = true): void {
  const manifest = {
    id,
    name: extra.name || id,
    version: "1.0.0",
    type: "source",
    capabilities: caps,
    platforms: extra.platforms || [],
    configSchema: [],
    permissions: ["net"],
    ...extra,
  };
  registerPlugin(manifest as any, impl);
  if (enabled) persistEnabled(id, manifest);
  cleanups.push(() => {
    try { unregisterPlugin(id); } catch { /* gone */ }
    try { sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(id); } catch { /* noop */ }
  });
}

function insertSong(
  id: string,
  pluginEntry = "qa-owner",
  sourceData = JSON.stringify({ source: "kuwo", remoteId: "1" }),
) {
  db.insert(songs)
    .values({ id, title: "碎碎念", artist: "队长", album: "", duration: 240, path: `/tmp/${id}.mp3`, type: "web", pluginEntry, sourceData })
    .run();
  cleanups.push(() => { try { sqlite.prepare("DELETE FROM songs WHERE id = ?").run(id); } catch { /* noop */ } });
}

/** 造一个能过 importGate 的候选(与期望元数据一致)。 */
function cand(source: string, url?: string) {
  return { id: `${source}-${url || ""}`, source, name: "碎碎念", artist: "队长", album: "", duration: 240, cover: "", url: url || `http://x/${source}.mp3` };
}

const okResp = () => new Response(new ArrayBuffer(16), { status: 206, headers: { "content-type": "audio/mpeg" } });
const goneResp = () => new Response(new ArrayBuffer(4), { status: 404, headers: { "content-type": "text/html" } });
const errResp = () => new Response(new ArrayBuffer(4), { status: 500, headers: { "content-type": "text/html" } });

/** mock search+stream 插件:记录每次 search 的 params 以便断言调用顺序/传参。 */
function searchPlugin(sourceByUrlOrList: any) {
  const calls: any[] = [];
  const impl = {
    search: async (_cfg: any, params: any) => {
      calls.push(params);
      return typeof sourceByUrlOrList === "function" ? sourceByUrlOrList(params) : sourceByUrlOrList;
    },
    streamUrl: (_cfg: any, song: any) => String(song.url || ""),
  };
  return { impl, calls };
}

function clearPrioritySetting() {
  sqlite.prepare("DELETE FROM settings WHERE key = ?").run(STREAM_SOURCE_PRIORITY_KEY);
  _resetSettingsCacheForTest();
}

function disableAllBuiltins() {
  sqlite.prepare("UPDATE plugins SET enabled = 0").run();
}

beforeEach(() => {
  clearStreamFallbackCache();
  clearPrioritySetting();
  disableAllBuiltins();
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (cleanups.length) cleanups.pop()!();
  disableAllBuiltins();
  clearPrioritySetting();
});

// ==================== A. 列表为空 → 旧行为 ====================

describe("QA:空列表保持旧行为", () => {
  it("A1 本尊齐备(stream+search)→ 本尊优先,命中即止,不回退其它插件", async () => {
    const owner = searchPlugin({ songs: [cand("netease", "http://owner/n.mp3")] });
    reg("qa-owner", ["search", "stream"], owner.impl, { name: "OWNER" });
    const other = searchPlugin({ songs: [cand("kuwo", "http://other/k.mp3")] });
    reg("qa-other", ["search", "stream"], other.impl, { name: "OTHER" });
    insertSong("qa-a1");
    vi.stubGlobal("fetch", vi.fn(async () => okResp()));

    const r = await findFallbackStream("qa-a1", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toEqual({ url: "http://owner/n.mp3", source: "netease" });
    expect(owner.calls.length).toBe(1);
    expect(other.calls).toEqual([]); // 本尊命中,其它插件一次都没被调
  });

  it("A2 本尊不齐备(只 search 无 stream)→ 回退首个 search+stream 齐备插件", async () => {
    reg("qa-owner-so", ["search"], { search: async () => ({ songs: [cand("qq", "http://owner-so/q.mp3")] }) }, { name: "OWNER-SO" });
    const full = searchPlugin({ songs: [cand("netease", "http://full/n.mp3")] });
    reg("qa-full", ["search", "stream"], full.impl, { name: "FULL" });
    insertSong("qa-a2");
    vi.stubGlobal("fetch", vi.fn(async () => okResp()));

    const r = await findFallbackStream("qa-a2", "碎碎念", "队长", "", 240, "qa-owner-so", "qq");

    expect(r).toEqual({ url: "http://full/n.mp3", source: "netease" });
    expect(full.calls.length).toBe(1); // 本尊不合格 → 回退齐备插件
  });

  it("A3 空列表下纯 stream 插件跨插件轮询路径仍在(本尊重搜无果 → resolveStream)", async () => {
    // 本尊只 search 无 stream;齐备插件 full 搜到唯一候选但平台=失败平台 → 被过滤
    reg("qa-owner-so", ["search"], { search: async () => ({ songs: [cand("qq", "http://owner-so/q.mp3")] }) }, { name: "OWNER-SO" });
    const full = searchPlugin({ songs: [cand("qq", "http://full/q.mp3")] });
    reg("qa-full", ["search", "stream"], full.impl, { name: "FULL" });
    const resolveCalls: any[] = [];
    reg("qa-resolver", ["stream"], {
      resolveStream: async (_cfg: any, song: any) => { resolveCalls.push(song); return "http://resolver/live.mp3"; },
    }, { name: "RESOLVER" });
    insertSong("qa-a3");
    vi.stubGlobal("fetch", vi.fn(async () => okResp()));

    const r = await findFallbackStream("qa-a3", "碎碎念", "队长", "", 240, "qa-owner-so", "qq");

    expect(r).toEqual({ url: "http://resolver/live.mp3", source: "qa-resolver" });
    expect(resolveCalls.length).toBe(1);
    expect(resolveCalls[0].id).toBe("qa-a3");
  });
});

// ==================== B. 列表非空 → 严格按列表顺序 ====================

describe("QA:非空列表严格按顺序", () => {
  it("B1 本尊不在列表 → 本尊一次都不被调用;顺序 a→b(用调用序列断言)", async () => {
    const owner = searchPlugin({ songs: [cand("netease", "http://owner/n.mp3")] });
    reg("qa-owner", ["search", "stream"], owner.impl, { name: "OWNER" });
    const seq: string[] = [];
    const a = { search: async () => { seq.push("a"); return { songs: [] }; }, streamUrl: (_c: any, s: any) => String(s.url || "") };
    const b = { search: async () => { seq.push("b"); return { songs: [cand("kuwo", "http://b/k.mp3")] }; }, streamUrl: (_c: any, s: any) => String(s.url || "") };
    reg("qa-a", ["search", "stream"], a, { name: "A" });
    reg("qa-b", ["search", "stream"], b, { name: "B" });
    insertSong("qa-b1");
    setStreamSourcePriority(["qa-a", "qa-b"]);
    vi.stubGlobal("fetch", vi.fn(async () => okResp()));

    const r = await findFallbackStream("qa-b1", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toEqual({ url: "http://b/k.mp3", source: "kuwo" });
    expect(seq).toEqual(["a", "b"]);       // a 先试失败 → 再 b
    expect(owner.calls).toEqual([]);       // 本尊完全未参与
  });

  it("B2 顺序优先于注册顺序:列表 [b,a] → 只调 b 命中即止", async () => {
    const seq: string[] = [];
    const a = { search: async () => { seq.push("a"); return { songs: [cand("netease", "http://a/n.mp3")] }; }, streamUrl: (_c: any, s: any) => String(s.url || "") };
    const b = { search: async () => { seq.push("b"); return { songs: [cand("kuwo", "http://b/k.mp3")] }; }, streamUrl: (_c: any, s: any) => String(s.url || "") };
    reg("qa-a", ["search", "stream"], a, { name: "A" }); // 先注册 a
    reg("qa-b", ["search", "stream"], b, { name: "B" });
    insertSong("qa-b2");
    setStreamSourcePriority(["qa-b", "qa-a"]); // 列表把 b 放前
    vi.stubGlobal("fetch", vi.fn(async () => okResp()));

    const r = await findFallbackStream("qa-b2", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toEqual({ url: "http://b/k.mp3", source: "kuwo" });
    expect(seq).toEqual(["b"]); // 未到 a
  });

  it("B3 历史 pluginId:platform → 收敛为插件级:走插件自身 sourcePreference,不再限定平台、不再透传 sources", async () => {
    // 插件返回全平台,sourcePreference 把 netease 排在前。条目 "qa-owner:kuwo" 收敛为
    // "qa-owner" → 取 sourcePreference 首位的 netease(而非 kuwo)。
    const owner = searchPlugin({ songs: [cand("netease", "http://owner/n.mp3"), cand("kuwo", "http://owner/k.mp3")] });
    reg("qa-owner", ["search", "stream"], owner.impl, { name: "OWNER", sourcePreference: ["netease", "kuwo"] });
    insertSong("qa-b3");
    setStreamSourcePriority(["qa-owner:kuwo"]);
    vi.stubGlobal("fetch", vi.fn(async () => okResp()));

    const r = await findFallbackStream("qa-b3", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toEqual({ url: "http://owner/n.mp3", source: "netease" }); // 插件自身偏好优先,不是 kuwo
    expect(owner.calls[0]).toEqual({ query: "碎碎念 队长" }); // 不再透传 sources
  });

  it("B4 同一插件的多条平台级条目收敛为一条(仅调用一次)", async () => {
    const owner = searchPlugin({ songs: [cand("netease", "http://owner/n.mp3")] });
    reg("qa-owner", ["search", "stream"], owner.impl, { name: "OWNER", sourcePreference: ["netease", "kuwo"] });
    insertSong("qa-b4");
    setStreamSourcePriority(["qa-owner:kuwo", "qa-owner:netease"]); // 均收敛为 qa-owner → 去重
    vi.stubGlobal("fetch", vi.fn(async () => okResp()));

    const r = await findFallbackStream("qa-b4", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toEqual({ url: "http://owner/n.mp3", source: "netease" });
    expect(owner.calls.length).toBe(1); // 两条收敛为一条 → 只调一次
  });

  it("B5 纯 stream 插件条目走 resolveStream,不调 search(本尊也不调)", async () => {
    const owner = searchPlugin({ songs: [cand("netease", "http://owner/n.mp3")] });
    reg("qa-owner", ["search", "stream"], owner.impl, { name: "OWNER" });
    const resolveCalls: any[] = [];
    reg("qa-lx", ["stream"], {
      resolveStream: async (_cfg: any, song: any) => { resolveCalls.push(song); return "http://lx/kw.mp3"; },
    }, { name: "LX" });
    insertSong("qa-b5");
    setStreamSourcePriority(["qa-lx"]);
    vi.stubGlobal("fetch", vi.fn(async () => okResp()));

    const r = await findFallbackStream("qa-b5", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toEqual({ url: "http://lx/kw.mp3", source: "qa-lx" });
    expect(resolveCalls.length).toBe(1);
    expect(owner.calls).toEqual([]);
  });
});

// ==================== C. 错误路径与混合场景 ====================

describe("QA:错误路径与混合场景", () => {
  it("C1 第1项 search 抛错 → 跳过,第2项命中", async () => {
    const seq: string[] = [];
    reg("qa-boom", ["search", "stream"], {
      search: async () => { seq.push("boom"); throw new Error("upstream 502"); },
      streamUrl: () => "",
    }, { name: "BOOM" });
    const good = { search: async () => { seq.push("good"); return { songs: [cand("kuwo", "http://good/k.mp3")] }; }, streamUrl: (_c: any, s: any) => String(s.url || "") };
    reg("qa-good", ["search", "stream"], good, { name: "GOOD" });
    insertSong("qa-c1");
    setStreamSourcePriority(["qa-boom", "qa-good"]);
    vi.stubGlobal("fetch", vi.fn(async () => okResp()));

    const r = await findFallbackStream("qa-c1", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toEqual({ url: "http://good/k.mp3", source: "kuwo" });
    expect(seq).toEqual(["boom", "good"]);
    expect(getCachedPlayability("qa-c1")).toBe("playable"); // 命中,不应被前一跳抛错污染
  });

  it("C2 第1项候选 probe 全 404 → 切到第2项成功", async () => {
    const dead = { search: async () => ({ songs: [cand("kuwo", "http://dead/k.mp3")] }), streamUrl: (_c: any, s: any) => String(s.url || "") };
    const good = { search: async () => ({ songs: [cand("netease", "http://good/n.mp3")] }), streamUrl: (_c: any, s: any) => String(s.url || "") };
    reg("qa-dead", ["search", "stream"], dead, { name: "DEAD" });
    reg("qa-good", ["search", "stream"], good, { name: "GOOD" });
    insertSong("qa-c2");
    setStreamSourcePriority(["qa-dead", "qa-good"]);
    // 按 URL 分流:dead 链 404,good 链 206
    vi.stubGlobal("fetch", vi.fn(async (u: any) => (String(u).includes("dead") ? goneResp() : okResp())));

    const r = await findFallbackStream("qa-c2", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toEqual({ url: "http://good/n.mp3", source: "netease" });
  });

  it("C3 第1项 probe transient(500) → 切到第2项成功;最终不写负缓存", async () => {
    const flaky = { search: async () => ({ songs: [cand("kuwo", "http://flaky/k.mp3")] }), streamUrl: (_c: any, s: any) => String(s.url || "") };
    const good = { search: async () => ({ songs: [cand("netease", "http://good/n.mp3")] }), streamUrl: (_c: any, s: any) => String(s.url || "") };
    reg("qa-flaky", ["search", "stream"], flaky, { name: "FLAKY" });
    reg("qa-good", ["search", "stream"], good, { name: "GOOD" });
    insertSong("qa-c3");
    setStreamSourcePriority(["qa-flaky", "qa-good"]);
    vi.stubGlobal("fetch", vi.fn(async (u: any) => (String(u).includes("flaky") ? errResp() : okResp())));

    const r = await findFallbackStream("qa-c3", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toEqual({ url: "http://good/n.mp3", source: "netease" });
    expect(getCachedPlayability("qa-c3")).toBe("playable");
  });

  it("C4 列表全部明确失败(含纯 stream 也失败)→ 负缓存 unplayable", async () => {
    const dead = { search: async () => ({ songs: [cand("kuwo", "http://dead/k.mp3")] }), streamUrl: (_c: any, s: any) => String(s.url || "") };
    reg("qa-dead", ["search", "stream"], dead, { name: "DEAD" });
    reg("qa-lx", ["stream"], { resolveStream: async () => "" }, { name: "LX" });
    insertSong("qa-c4");
    setStreamSourcePriority(["qa-dead", "qa-lx"]);
    vi.stubGlobal("fetch", vi.fn(async () => goneResp()));

    const r = await findFallbackStream("qa-c4", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toBeNull();
    expect(getCachedPlayability("qa-c4")).toBe("unplayable"); // 全是明确 404 → 判不可播
  });

  it("C5 列表全部网络异常(500)→ 只短期退避 transient,不判死", async () => {
    const flaky = { search: async () => ({ songs: [cand("kuwo", "http://flaky/k.mp3")] }), streamUrl: (_c: any, s: any) => String(s.url || "") };
    reg("qa-flaky", ["search", "stream"], flaky, { name: "FLAKY" });
    insertSong("qa-c5");
    setStreamSourcePriority(["qa-flaky"]);
    vi.stubGlobal("fetch", vi.fn(async () => errResp()));

    const r = await findFallbackStream("qa-c5", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toBeNull();
    expect(getCachedPlayability("qa-c5")).toBe("transient"); // 网络异常 ≠ 无源
  });

  it("C6 含不存在 pluginId / 只 search 无 stream / 空 pluginId / 尾冒号 → 安全空操作后命中后续(仅插件级,收敛)", async () => {
    const chartOnlyCalls: any[] = [];
    reg("qa-chart", ["search"], { search: async (c: any, p: any) => { chartOnlyCalls.push(p); return { songs: [] }; } }, { name: "CHART" }); // 只 search,无 streamUrl
    const owner = searchPlugin({ songs: [] }); // owner: 尾冒号 → 插件级,搜到空
    reg("qa-owner", ["search", "stream"], owner.impl, { name: "OWNER" });
    const real = { search: async () => ({ songs: [cand("kuwo", "http://real/k.mp3")] }), streamUrl: (_c: any, s: any) => String(s.url || "") };
    reg("qa-real", ["search", "stream"], real, { name: "REAL" });
    insertSong("qa-c6");
    // 新语义(仅插件级,收敛后):
    //   "qa-ghost-nope" 不存在 → 跳过;
    //   "qa-chart" 只 search 无 stream → 跳过(安全空操作);
    //   ":kuwo" 收敛后 `:` 前为空 → 整条丢弃;
    //   "qa-owner:" 收敛为 "qa-owner"(插件级);
    //   "qa-real" 真命中。
    setStreamSourcePriority(["qa-ghost-nope", "qa-chart", ":kuwo", "qa-owner:", "qa-real"]);
    vi.stubGlobal("fetch", vi.fn(async () => okResp()));

    const r = await findFallbackStream("qa-c6", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toEqual({ url: "http://real/k.mp3", source: "kuwo" });
    expect(owner.calls.length).toBe(1);        // "qa-owner:" 收敛为 qa-owner(failingSource=qq → 搜到空无源)
    expect(chartOnlyCalls).toEqual([]);        // 只 search 无 stream → 直接跳过,连 search 都不调(安全空操作)
  });

  it("C7 非空列表全部指向不可用插件(本尊其实可用)→ 判无源,不回退本尊(设计约定)", async () => {
    const owner = searchPlugin({ songs: [cand("kuwo", "http://owner/k.mp3")] });
    reg("qa-owner", ["search", "stream"], owner.impl, { name: "OWNER" });
    insertSong("qa-c7");
    setStreamSourcePriority(["qa-ghost1", "qa-ghost2"]); // 两个都不存在
    vi.stubGlobal("fetch", vi.fn(async () => okResp()));

    const r = await findFallbackStream("qa-c7", "碎碎念", "队长", "", 240, "qa-owner", "qq");

    expect(r).toBeNull();                        // 严格按列表 → 全败即无源,不享本尊特权
    expect(owner.calls).toEqual([]);             // 本尊一次都不被调用
    expect(getCachedPlayability("qa-c7")).toBe("unplayable");
  });
});

// ==================== D. 设置读写健壮性 ====================

describe("QA:设置读写健壮性", () => {
  it("D1 库里存非法 JSON → 读取回退 []", () => {
    setSetting(STREAM_SOURCE_PRIORITY_KEY, "{not json");
    expect(getStreamSourcePriority()).toEqual([]);
  });

  it("D2 set 非数组 → 规范化 [] 并显式落库 []", () => {
    expect(setStreamSourcePriority({ a: 1 })).toEqual([]);
    expect(getStreamSourcePriority()).toEqual([]);
  });
});

// ==================== E. available 枚举 ====================

describe("QA:listAvailableStreamSources 枚举", () => {
  it("E1 只含「启用」且具备 stream 或 search 的插件;每个插件恰好一条(仅插件级,无平台项/无 kind)", () => {
    reg("qa-gmd", ["search", "stream"], {}, { name: "GMD", sourcePreference: ["netease", "kuwo"], platformLabels: { netease: "网易云" } });
    reg("qa-lx", ["stream"], {}, { name: "LX" });
    reg("qa-verify", ["search"], {}, { name: "HUAWEI" });
    reg("qa-album", ["playlistSongs"], {}, { name: "ALBUM" });
    reg("qa-searchpref", ["search"], {}, { name: "SEARCHPREF", sourcePreference: ["qq"], platformLabels: { qq: "QQ" } });
    reg("qa-off", ["stream", "search"], {}, { name: "OFF" }, false);

    const out = listAvailableStreamSources();
    const values = out.map((s) => s.value);

    expect(values).toContain("qa-gmd");
    expect(values).toContain("qa-lx");
    expect(values).toContain("qa-verify");
    expect(values).toContain("qa-searchpref");

    // 每个插件恰好一条;含 sourcePreference 也不再展开平台项;无 kind 字段
    expect(values.filter((v) => v === "qa-gmd").length).toBe(1);
    expect(values.some((v) => v.includes(":"))).toBe(false);      // 无 pluginId:platform
    expect(out.every((s) => !("kind" in s))).toBe(true);          // 已无 kind

    expect(values).not.toContain("qa-album");     // 无 stream/search
    expect(values).not.toContain("qa-off");       // 未启用
  });
});
