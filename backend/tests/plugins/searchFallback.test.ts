// Unit tests for services/source/online/searchFallback.ts —— 搜索层跨插件兜底
// (core-search-fallback):主插件搜索空/报错时,自动改用其它「已启用 + 声明 search &
// stream 能力」的源插件再试(排除本尊),回传 fallbackFrom / trace。
//   - 主插件直接命中 → 不换插件、fallbackFrom 空、trace 空(零行为变化)
//   - 主插件空结果 / 抛错 → 按配置兜底到下一个插件
//   - fallbackOnEmpty / fallbackOnError / enabled / maxCandidates 四个开关各自生效
//   - 全部耗尽 → empty=true + 可读 message(含 N 次回退)+ 完整 trace
//   - 超时/5xx 归为 transient(不写死「真的没有」)
//   - 兼容 lx-source 旧形状({empty,message,trace} 无 songs)与新形状(带 songs:[])
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { registerPlugin } from "../../src/plugins/registry.js";
import {
  searchFallbackManifest,
  SEARCH_FALLBACK_PLUGIN_ID,
} from "../../src/services/plugin/core/searchFallbackPlugin.js";
import { runSearchWithFallback } from "../../src/services/source/online/searchFallback.js";

const now = () => new Date().toISOString();

/** 注册一个源插件 + 播种 enabled 行(getConfiguredProvider 才解析得到)。 */
function seedSource(
  id: string,
  caps: string[],
  search: any,
  streamUrl: any = (_c: any, s: any) => `http://host/${s.source}/${s.id}`,
) {
  const manifest = {
    id, name: id, version: "1.0.0", type: "source",
    capabilities: caps, platforms: [], configSchema: [], permissions: ["net"],
  } as any;
  registerPlugin(manifest, { id, manifest, search, streamUrl });
  seedRow(id, JSON.stringify(manifest));
}

function seedRow(id: string, manifestJson: string, config: any = {}) {
  sqlite.prepare(`
    INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at)
    VALUES (?, ?, '1.0.0', '', ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config, manifest = excluded.manifest
  `).run(id, id, manifestJson, JSON.stringify(config), now(), now());
}

/** 播种 core-search-fallback 配置(缺省 = 全部默认)。 */
function seedFallbackConfig(cfg: Record<string, any>) {
  seedRow(SEARCH_FALLBACK_PLUGIN_ID, JSON.stringify({ ...searchFallbackManifest, id: SEARCH_FALLBACK_PLUGIN_ID }), cfg);
}

const song = (id: string, source = "netease") => ({ id, source, name: `n-${id}`, artist: "a", album: "b", duration: 100, cover: "" });
const songs = (n: string) => [song(n)];

describe("runSearchWithFallback — 搜索层跨插件兜底", () => {
  beforeEach(() => {
    seedFallbackConfig({});
  });

  afterEach(() => {
    sqlite.prepare("DELETE FROM plugins").run();
  });

  it("主插件直接命中 → 不换插件、fallbackFrom 空、trace 空(零行为变化)", async () => {
    seedSource("A", ["search", "stream"], async () => ({ songs: songs("a1") }));
    seedSource("B", ["search", "stream"], async () => ({ songs: songs("b1") }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(false);
    expect(r.songs.map((s) => s.id)).toEqual(["a1"]);
    expect(r.source).toBe("A");
    expect(r.fallbackFrom).toBe("");
    expect(r.trace).toEqual([]);
  });

  it("主插件空结果 → 自动改用下一个启用插件,fallbackFrom 标出来源", async () => {
    seedSource("A", ["search", "stream"], async () => ({ songs: [] }));
    seedSource("B", ["search", "stream"], async () => ({ songs: songs("b1") }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(false);
    expect(r.songs.map((s) => s.id)).toEqual(["b1"]);
    expect(r.fallbackFrom).toBe("B");
    expect(r.source).toBe("A");
    // 主插件空 + 兜底命中,轨迹应完整保留(前端可展示「A 空 → B 命中」)
    expect(r.trace).toEqual(["A(空结果)"]);
  });

  it("主插件抛错 → 按 fallbackOnError 兜底到下一个插件", async () => {
    seedSource("A", ["search", "stream"], async () => { throw new Error("上游 500"); });
    seedSource("B", ["search", "stream"], async () => ({ songs: songs("b2") }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(false);
    expect(r.fallbackFrom).toBe("B");
    expect(r.trace[0]).toBe("A(上游 500)");
    // 坑 3 裁决锚点:兜底真捞回了 ⇒ 上游错误已被覆盖,upstreamError 必须为空,调用方返 200。
    expect(r.upstreamError).toBe("");
  });

  it("主插件抛错且兜底也没捞回来 → upstreamError 非空(调用方必须回 502,不许吞成「无结果」)", async () => {
    seedSource("A", ["search", "stream"], async () => { throw new Error("上游 500"); });
    seedSource("B", ["search", "stream"], async () => { throw new Error("兜底也挂了"); });
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(true);
    // 回的是**主插件**的根因摘要(不是兜底插件最后那个错),前端按 UPSTREAM_ERROR 处理
    expect(r.upstreamError).toBe("上游 500");
    expect(r.trace).toEqual(["A(上游 500)", "B(兜底也挂了)"]);
  });

  it("主插件是空结果(非抛错)且兜底耗尽 → upstreamError 为空(这是「真的没有」,不是错误)", async () => {
    seedSource("A", ["search", "stream"], async () => ({ songs: [] }));
    seedSource("B", ["search", "stream"], async () => ({ songs: [] }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(true);
    expect(r.upstreamError).toBe("");
  });

  it("fallbackOnError=false → 主插件报错不兜底(原样返回 message)", async () => {
    seedFallbackConfig({ fallbackOnError: false });
    seedSource("A", ["search", "stream"], async () => { throw new Error("上游 500"); });
    seedSource("B", ["search", "stream"], async () => ({ songs: songs("b2") }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(true);
    expect(r.message).toBe("搜索失败: 上游 500");
    expect(r.fallbackFrom).toBe("");
  });

  it("fallbackOnEmpty=false → 主插件空结果不兜底", async () => {
    seedFallbackConfig({ fallbackOnEmpty: false });
    seedSource("A", ["search", "stream"], async () => ({ songs: [] }));
    seedSource("B", ["search", "stream"], async () => ({ songs: songs("b2") }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(true);
    expect(r.message).toBe(""); // 关掉兜底时不伪造失败文案
    expect(r.trace).toEqual([]);
  });

  it("enabled=false → 零行为变化(主插件空也不换插件)", async () => {
    seedFallbackConfig({ enabled: false });
    seedSource("A", ["search", "stream"], async () => ({ songs: [] }));
    seedSource("B", ["search", "stream"], async () => ({ songs: songs("b2") }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(true);
    expect(r.fallbackFrom).toBe("");
    expect(r.trace).toEqual([]);
    expect(r.message).toBe("");
  });

  it("maxCandidates=0 → 不兜底(等同关闭)", async () => {
    seedFallbackConfig({ maxCandidates: 0 });
    seedSource("A", ["search", "stream"], async () => ({ songs: [] }));
    seedSource("B", ["search", "stream"], async () => ({ songs: songs("b2") }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(true);
    expect(r.fallbackFrom).toBe("");
  });

  it("全部耗尽 → empty=true + 可读 message(含 N 次回退)+ 完整 trace", async () => {
    seedSource("A", ["search", "stream"], async () => ({ songs: [] }));
    seedSource("B", ["search", "stream"], async () => ({ songs: [] }));
    seedSource("C", ["search", "stream"], async () => ({ songs: [] }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(true);
    expect(r.songs).toEqual([]);
    expect(r.fallbackFrom).toBe("");
    expect(r.message).toContain("全部在线源均无结果");
    expect(r.message).toContain("3 次回退"); // 主插件 + 2 个兜底候选(闸门上限)全空
    expect(r.message).toContain("A(空结果)");
    expect(r.message).toContain("B(空结果)");
    expect(r.message).toContain("C(空结果)");
    expect(r.trace).toEqual(["A(空结果)", "B(空结果)", "C(空结果)"]);
  });

  it("兜底候选只取 search+stream 齐备的启用插件,且排除本尊(不自我重试)", async () => {
    const seen: string[] = [];
    seedSource("A", ["search"], async () => { seen.push("A"); return { songs: [] }; }, () => ""); // 缺 stream
    seedSource("B", ["stream"], async () => { seen.push("B"); return { songs: songs("b") }; }); // 缺 search
    seedSource("C", ["search", "stream"], async () => { seen.push("C"); return { songs: songs("c1") }; });
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.fallbackFrom).toBe("C");
    expect(seen).toEqual(["A", "C"]); // B 无 search 能力,不该被调用;A 不自我重试
  });

  it("transient:兜底候选超时/预算耗尽 → 不写死「真的没有」,message 说明是超时", async () => {
    seedFallbackConfig({ budgetMs: 500 }); // 缩到最小可用预算,别让测试真等 6s
    seedSource("A", ["search", "stream"], async () => ({ songs: [] }));
    seedSource("B", ["search", "stream"], () => new Promise((_res) => { /* 卡死 */ }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(true);
    expect(r.transient).toBe(true);
    expect(r.message).toContain("上游超时/网络异常");
    expect(r.trace.some((t) => t.includes("超过兜底预算"))).toBe(true);
  });

  it("兼容 lx-source 插件软失败形状(无 songs 的 {empty,message,trace})", async () => {
    seedSource("A", ["search", "stream"], async () => ({
      empty: true, message: "全部洛雪音源均无结果(1 次回退)", trace: ["kw(空结果)"], songs: [] as any[],
    }));
    seedSource("B", ["search", "stream"], async () => ({ songs: songs("b1") }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.empty).toBe(false);
    expect(r.fallbackFrom).toBe("B");
    expect(r.trace).toEqual(["A(空结果)"]);
  });

  it("兜底命中时透传插件原始返回(raw),核心不逐个解释插件自定义字段", async () => {
    seedSource("A", ["search", "stream"], async () => ({ songs: [] }));
    seedSource("B", ["search", "stream"], async () => ({ songs: songs("b1"), source: "lx", trace: ["kw(403)"] }));
    const r = await runSearchWithFallback("A", { query: "x" });
    expect(r.raw && r.raw.source).toBe("lx");
    expect(r.raw && r.raw.trace).toEqual(["kw(403)"]);
  });

  it("主插件不可用(未配置/未启用)→ 显式 message,不抛错", async () => {
    const r = await runSearchWithFallback("NOPE", { query: "x" });
    expect(r.empty).toBe(true);
    expect(r.message).toContain("搜索源插件不可用");
    expect(r.trace).toEqual(["NOPE(不可用)"]);
  });

  it("兜底结果带 sources 参数透传给每个候选插件", async () => {
    const got: any[] = [];
    seedSource("A", ["search", "stream"], async (c, p) => { got.push(p); return { songs: [] }; });
    seedSource("B", ["search", "stream"], async (c, p) => { got.push(p); return { songs: songs("b1") }; });
    await runSearchWithFallback("A", { query: "x", sources: ["netease"] });
    expect(got).toEqual([
      { query: "x", sources: ["netease"] },
      { query: "x", sources: ["netease"] },
    ]);
  });
});
