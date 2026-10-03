// 纯 stream 插件跨插件兜底 · 本尊 search 抛异常分支(2026-10-04 240 真机实锤):
// 240 生产容器里 `docker stop music-dl` 后,findFallbackStream 的「本尊重搜」直接
// 抛异常(网络异常),旧实现在 catch 里 `setFallback(..., {transient:true}); return null`
// 提前返回,把下游「纯 stream 插件按 sourceData 直查直链」的轮询整段跳过 —— 表现为
// 「gmd 挂了就彻底没声音,洛雪永远接不上」。修法:catch 只打 searchFailed 标记后走
// 空结果路径继续轮询;全无果时末尾统一按 searchFailed 写 transient 负缓存(与原
// 「短期退避」语义一致)。本文件锁这两个行为。
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

/** 本尊:gmd 型 —— 本 characterize 场景里 search **抛异常**(上游 down)。 */
function regPrimaryThrowing(): void {
  reg("gmd-throw", ["search", "stream"], {
    search: async () => { throw new Error("upstream unreachable"); },
    streamUrl: () => "",
  });
}

function insertSong(id: string, sourceData: string) {
  db.insert(songs)
    .values({ id, title: "碎碎念", artist: "队长", album: "", duration: 240, path: `/tmp/${id}.mp3`, type: "web", pluginEntry: "gmd-throw", sourceData })
    .run();
  cleanups.push(() => { try { sqlite.prepare("DELETE FROM songs WHERE id = ?").run(id); } catch { /* noop */ } });
}

const RESP_OK = () => new Response(new ArrayBuffer(16), { status: 206, headers: { "content-type": "audio/mpeg" } });

beforeEach(() => {
  clearStreamFallbackCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  while (cleanups.length) cleanups.pop()!();
});

describe("findFallbackStream:本尊 search 抛异常不得跳过纯 stream 插件兜底", () => {
  it("① 本尊 search 抛错 → 纯 stream 插件仍按 sourceData 直查并换链成功", async () => {
    regPrimaryThrowing();
    reg("lx-pure2", ["stream"], {
      resolveStream: async (_cfg: any, song: any) =>
        String(song.sourceData || "").includes("1323099451") ? "http://lx.test/throw.mp3" : "",
    });
    insertSong("s-throw", JSON.stringify({ provider: "go-music-dl", source: "kuwo", remoteId: "1323099451" }));
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));

    const r = await findFallbackStream("s-throw", "碎碎念", "队长", "", 240, "gmd-throw", "kuwo", 5000);

    expect(r).toEqual({ url: "http://lx.test/throw.mp3", source: "lx-pure2" });
  });

  it("② 本尊 search 抛错 + 纯 stream 插件无链 → null,但按 transient 退避(不判死)", async () => {
    regPrimaryThrowing();
    reg("lx-pure3", ["stream"], { resolveStream: async () => "" });
    insertSong("s-throw2", JSON.stringify({ provider: "go-music-dl", source: "kuwo", remoteId: "999" }));
    vi.stubGlobal("fetch", vi.fn(async () => RESP_OK()));

    const r = await findFallbackStream("s-throw2", "碎碎念", "队长", "", 240, "gmd-throw", "kuwo", 5000);

    expect(r).toBeNull();
    expect(getCachedPlayability("s-throw2")).toBe("transient");
  });
});
