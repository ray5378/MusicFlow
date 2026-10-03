// 纯 stream 插件跨插件兜底(2026-10-04):
// findFallbackStream 在本尊重搜+平台轮换全败后,逐个尝试「capabilities 含
// stream 且不含 search」的启用源插件的 resolveStream(config, songLike) ——
// 按歌 sourceData 里的平台原生 ID 直查直链(如 lx-source 按洛雪源脚本换链),
// probe 通过才换链。锁行为:命中带插件 id / 空串与异常同败 / 非纯 stream 插件
// 不进候选 / 无纯 stream 插件时行为与旧版完全一致。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDatabase, db, sqlite } from "../../src/db/index.js";
import { songs } from "../../src/db/schema.js";
import { registerPlugin, unregisterPlugin } from "../../src/plugins/registry.js";
import {
  clearStreamFallbackCache,
  findFallbackStream,
  getCachedPlayability,
} from "../../src/services/source/online/streamFallback.js";

initDatabase();

const NOW = new Date().toISOString();

function persistEnabled(id: string, manifest: any) {
  sqlite
    .prepare(
      "INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at) VALUES (?,?,?,?,?,1,'{}',?,?) ON CONFLICT(id) DO UPDATE SET enabled = 1, manifest = excluded.manifest",
    )
    .run(id, id, manifest.version || "1.0.0", "", JSON.stringify(manifest), NOW, NOW);
}

const cleanups: Array<() => void> = [];
function reg(id: string, caps: string[], impl: any): void {
  const manifest = {
    id,
    name: id,
    version: "1.0.0",
    type: "source",
    capabilities: caps,
    platforms: [],
    configSchema: [],
    permissions: ["net"],
  };
  registerPlugin(manifest as any, impl);
  persistEnabled(id, manifest);
  cleanups.push(() => {
    try { unregisterPlugin(id); } catch { /* already gone */ }
    sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(id);
  });
}

/** 本尊:gmd 型(search+stream 齐备)。默认 search 返回空结果 → 平台轮换无候选。 */
function regPrimary(searchSongs: any[] = []): void {
  reg("gmd-like", ["search", "stream"], {
    search: async () => ({ songs: searchSongs }),
    streamUrl: () => "",
  });
}

/** 插一行带 sourceData 的 gmd 渠道歌(酷我平台真实 ID 形态)。 */
function insertSong(id: string, sourceData: string) {
  db.insert(songs)
    .values({ id, title: "碎碎念", artist: "队长", album: "", duration: 240, path: `/tmp/${id}.mp3`, type: "web", pluginEntry: "gmd-like", sourceData })
    .run();
  cleanups.push(() => { try { sqlite.prepare("DELETE FROM songs WHERE id = ?").run(id); } catch { /* noop */ } });
}

const RESP_OK = () => new Response(new ArrayBuffer(16), { status: 206, headers: { "content-type": "audio/mpeg" } });
const RESP_GONE = () => new Response(new ArrayBuffer(4), { status: 404, headers: { "content-type": "text/html" } });

beforeEach(() => {
  clearStreamFallbackCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  while (cleanups.length) cleanups.pop()!();
});

describe("findFallbackStream 纯 stream 插件跨插件兜底", () => {
  it("① 本尊平台全败 → 纯 stream 插件按 sourceData 换链,probe ok → 成功且 source=插件id", async () => {
    insertSong("s-hit", JSON.stringify({ source: "kuwo", remoteId: "314931169" }));
    regPrimary();
    let got: any = null;
    reg("lx-pure", ["stream"], {
      resolveStream: async (cfg: any, song: any) => {
        got = { cfg, song };
        return "http://lx.test/kw.mp3";
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));
    const r = await findFallbackStream("s-hit", "碎碎念", "队长", "", 240, "gmd-like", "kuwo");
    expect(r).toEqual({ url: "http://lx.test/kw.mp3", source: "lx-pure" });
    expect(got.cfg).toEqual({});
    expect(got.song.id).toBe("s-hit");
    expect(got.song.sourceData).toContain("314931169");
    expect(got.song.pluginEntry).toBe("gmd-like");
  });

  it("② resolveStream 返回空串 → 该跳跳过,整体失败(null)", async () => {
    regPrimary();
    reg("lx-pure", ["stream"], { resolveStream: async () => "" });
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));
    const r = await findFallbackStream("s-empty", "歌", "人", "", 240, "gmd-like", "kuwo");
    expect(r).toBeNull();
    // 明确 404 类失败轨迹为空 → 负缓存 unplayable(非 transient)
    expect(getCachedPlayability("s-empty")).toBe("unplayable");
  });

  it("③ resolveStream 抛异常 → 不冒出去,同该跳失败(null)", async () => {
    regPrimary();
    reg("lx-pure", ["stream"], { resolveStream: async () => { throw new Error("plugin boom"); } });
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));
    const r = await findFallbackStream("s-throw", "歌", "人", "", 240, "gmd-like", "kuwo");
    expect(r).toBeNull();
    expect(getCachedPlayability("s-throw")).toBe("unplayable");
  });

  it("④ 换出的 URL probe 不通过(404) → 不换链,继续负缓存;transient(网络异常)不写死负缓存", async () => {
    regPrimary();
    reg("lx-pure", ["stream"], { resolveStream: async () => "http://lx.test/dead.mp3" });
    vi.stubGlobal("fetch", vi.fn(async () => RESP_GONE()));
    const r = await findFallbackStream("s-dead", "歌", "人", "", 240, "gmd-like", "kuwo");
    expect(r).toBeNull();
    expect(getCachedPlayability("s-dead")).toBe("unplayable");

    clearStreamFallbackCache();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const r2 = await findFallbackStream("s-transient", "歌", "人", "", 240, "gmd-like", "kuwo");
    expect(r2).toBeNull();
    expect(getCachedPlayability("s-transient")).toBe("transient");
  });

  it("⑤ capabilities 含 stream 又含 search 的插件不是纯 stream 候选,resolveStream 不会被调", async () => {
    regPrimary();
    const calls: string[] = [];
    reg("mixed", ["stream", "search"], {
      search: async () => ({ songs: [] }),
      streamUrl: () => "",
      resolveStream: async () => { calls.push("mixed"); return "http://mixed.test/a.mp3"; },
    });
    reg("lx-pure", ["stream"], { resolveStream: async () => "http://lx.test/kw.mp3" });
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));
    const r = await findFallbackStream("s-mixed", "歌", "人", "", 240, "gmd-like", "kuwo");
    expect(calls).toEqual([]);
    expect(r?.source).toBe("lx-pure");
  });

  it("⑥ 无纯 stream 插件 → 行为与旧版一致(失败,null)", async () => {
    regPrimary();
    reg("also-mixed", ["search", "stream"], {
      search: async () => ({ songs: [] }),
      streamUrl: () => "",
    });
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));
    const r = await findFallbackStream("s-none", "歌", "人", "", 240, "gmd-like", "kuwo");
    expect(r).toBeNull();
  });

  it("⑦ 本尊自己就是纯 stream 歌(pluginEntry=纯 stream 插件)时不重复调用本尊", async () => {
    regPrimary();
    const calls: string[] = [];
    reg("lx-pure", ["stream"], {
      resolveStream: async () => { calls.push("lx-pure"); return ""; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));
    // providerId 直接传纯 stream 插件:它没有 search,resolveStreamProvider 会
    // 回退 gmd-like;lx-pure 是本尊,候选轮询里必须被排除。
    const r = await findFallbackStream("s-self", "歌", "人", "", 240, "lx-pure", "kuwo");
    expect(calls).toEqual([]);
    expect(r).toBeNull();
  });
});
