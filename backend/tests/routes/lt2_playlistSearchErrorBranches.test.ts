// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// `routes/api/playlistSearch.ts` 残余未覆盖行补测(错误/降级分支):
//   37      providers 的平台筛选:config.filterPlatforms 非空时覆盖 manifest.platforms
//   93      聚合搜索外层兜底 → 502
//   130     单插件搜索调插件失败 → 502
//   146-147 导入:插件未声明 playlistSongs → 404
//   197     详情拉歌失败 → 502
//
// 与 entitySearch 同构:registry 只提供「按能力查插件」的能力表,把它换成受控插件表,
// 才能精确构造"声明了 playlistSearch 但缺 playlistSongs / 方法会炸"的插件。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

const state = vi.hoisted(() => ({
  plugins: [] as any[],
  configs: {} as Record<string, any>,
  throwOnCapability: false,
}));

vi.mock("../../src/plugins/registry.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getEnabledByCapability: (cap: string) => {
    if (state.throwOnCapability) throw new Error("registry exploded");
    return state.plugins.filter((p) => (p.manifest.capabilities || []).includes(cap));
  },
  getPluginConfig: (id: string) => state.configs[id] ?? {},
}));

import { playlistSearchRoutes } from "../../src/routes/api/playlistSearch.js";

const app = new Hono();
app.route("/", playlistSearchRoutes);

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

function plugin(id: string, capabilities: string[], impl: Record<string, unknown>) {
  return { manifest: { id, name: `名称-${id}`, capabilities, platforms: ["netease"], platformLabels: {} }, impl };
}

const throwing = async () => { throw new Error("上游炸了"); };

beforeEach(() => {
  state.plugins = [];
  state.configs = {};
  state.throwOnCapability = false;
});

describe("GET /v1/playlist-search/providers", () => {
  it("插件配置了 filterPlatforms → 覆盖 manifest 的平台列表", async () => {
    // 契约:用户在插件配置里勾选的"歌单筛选平台"必须真的出现在筛选下拉里
    // (否则配了也没用);未配置/空数组才回落 manifest.platforms。
    state.plugins = [plugin("ps-1", ["playlistSearch"], {})];
    state.configs = { "ps-1": { filterPlatforms: ["qq", "kugou"] } };
    const r = await call("GET", "/v1/playlist-search/providers");
    expect(r.status).toBe(200);
    const p = r.body.providers.find((x: any) => x.id === "ps-1");
    expect(p.platforms).toEqual(["qq", "kugou"]);

    state.configs = { "ps-1": { filterPlatforms: [] } };
    const r2 = await call("GET", "/v1/playlist-search/providers");
    expect(r2.body.providers.find((x: any) => x.id === "ps-1").platforms).toEqual(["netease"]);
  });
});

describe("聚合搜索的兜底", () => {
  it("能力查询抛错 → 502 + UPSTREAM_ERROR", async () => {
    state.throwOnCapability = true;
    const r = await call("POST", "/v1/playlist-search/aggregate/search", { q: "x" });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR", error: "registry exploded" });
  });

  it("单插件失败降级:好插件结果保留", async () => {
    state.plugins = [
      plugin("good", ["playlistSearch"], { searchPlaylists: async () => ({ playlists: [{ id: "1", source: "netease", name: "命中" }] }) }),
      plugin("bad", ["playlistSearch"], { searchPlaylists: throwing }),
    ];
    const r = await call("POST", "/v1/playlist-search/aggregate/search", { q: "x" });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.playlists[0]).toMatchObject({ name: "命中", providerId: "good" });
  });
});

describe("单插件搜索", () => {
  it("插件实现抛错 → 502 + UPSTREAM_ERROR", async () => {
    state.plugins = [plugin("boom", ["playlistSearch"], { searchPlaylists: throwing })];
    const r = await call("POST", "/v1/playlist-search/boom/search", { q: "x" });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR", error: "上游炸了" });
  });
});

describe("导入 / 详情", () => {
  it("导入:插件没有 playlistSongs → 404", async () => {
    state.plugins = [plugin("nopl", ["playlistSearch"], { searchPlaylists: async () => ({ playlists: [] }) })];
    const r = await call("POST", "/v1/playlist-search/nopl/import", { source: "netease", id: "pl1" });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ success: false, code: "NOT_FOUND" });
  });

  it("详情:playlistSongs 抛错 → 502", async () => {
    state.plugins = [plugin("boom2", ["playlistSearch"], { playlistSongs: throwing })];
    const r = await call("GET", "/v1/playlist-search/boom2/items?source=netease&id=pl1");
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR", error: "上游炸了" });
  });
});
