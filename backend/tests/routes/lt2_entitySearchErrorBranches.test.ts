// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// `routes/api/entitySearch.ts` 残余未覆盖行补测 —— 全部是**错误/降级分支**:
//   146    聚合搜索外层兜底(能力查询本身炸了)→ 502
//   175    单插件搜索调插件失败 → 502
//   208-209 album 导入:插件未声明 playlistSongs → 404
//   251-252 album 详情:插件未声明 playlistSongs → 404
//   258-259 artist 详情:插件未声明 searchSongs → 404
//   266    详情拉取失败 → 502
//
// 为什么要 mock `plugins/registry.js`:这些端点只按「能力」查插件,registry 只是
// 那张能力表的来源;把它换成受控插件表后,可以精确构造"声明了能力但实现缺失/抛错"
// 的插件,从而稳定打中这些分支 —— 真实 registry 没法注册一个"方法会炸"的插件(会污染
// 其它文件的能力表)。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

const state = vi.hoisted(() => ({
  plugins: [] as any[],
  /** 置 true 时,能力查询直接抛错(用于打聚合搜索的外层 catch)。 */
  throwOnSongCapability: false,
}));

vi.mock("../../src/plugins/registry.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getEnabledByCapability: (cap: string) => {
    if (cap === "songSearch" && state.throwOnSongCapability) throw new Error("registry exploded");
    return state.plugins.filter((p) => (p.manifest.capabilities || []).includes(cap));
  },
  getPluginConfig: () => ({}),
}));

vi.mock("../../src/services/plugin/asyncTasks.js", () => ({
  startAsyncTask: vi.fn(() => ({ started: true, taskId: "t-ok" })),
}));

import { entitySearchRoutes } from "../../src/routes/api/entitySearch.js";
import { startAsyncTask } from "../../src/services/plugin/asyncTasks.js";

// entitySearch 的路由自带 `/v1/...` 全路径,故挂在根上即可(生产里它挂在 /rest/api 下继承鉴权)。
const app = new Hono();
app.route("/", entitySearchRoutes);

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

/** 造一个"受控插件":manifest 声明能力,impl 按需给/不给方法。 */
function plugin(id: string, capabilities: string[], impl: Record<string, unknown>) {
  return { manifest: { id, name: `名称-${id}`, capabilities, platforms: [], platformLabels: {} }, impl };
}

const throwing = async () => { throw new Error("上游炸了"); };

beforeEach(() => {
  state.plugins = [];
  state.throwOnSongCapability = false;
  (startAsyncTask as any).mockReturnValue({ started: true, taskId: "t-ok" });
});

describe("聚合搜索的兜底", () => {
  it("能力查询本身抛错 → 502 + UPSTREAM_ERROR(不能 500 裸抛)", async () => {
    state.throwOnSongCapability = true;
    const r = await call("POST", "/v1/song-search/aggregate/search", { q: "x" });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR", error: "registry exploded" });
  });

  it("单插件失败降级:好插件结果保留、坏插件只记日志", async () => {
    state.plugins = [
      plugin("good", ["songSearch"], { searchSongs: async () => ({ songs: [{ id: "1", source: "s", name: "命中" }] }) }),
      plugin("bad", ["songSearch"], { searchSongs: throwing }),
    ];
    const r = await call("POST", "/v1/song-search/aggregate/search", { q: "x" });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.items[0]).toMatchObject({ name: "命中", providerId: "good" });
    // 两个插件都应出现在 providers 里(坏插件是"参与了但失败",不是"不存在")
    expect(r.body.providers.map((p: any) => p.id).sort()).toEqual(["bad", "good"]);
  });

  it("声明了能力但没实现方法 → 不算 provider(否则前端会列出永远搜不出结果的源)", async () => {
    state.plugins = [plugin("no-impl", ["songSearch"], {})];
    const r = await call("POST", "/v1/song-search/aggregate/search", { q: "x" });
    expect(r.status).toBe(200);
    expect(r.body.providers).toEqual([]);
    expect(r.body.total).toBe(0);
  });
});

describe("单插件搜索", () => {
  it("插件实现抛错 → 502 + UPSTREAM_ERROR", async () => {
    state.plugins = [plugin("boom", ["songSearch"], { searchSongs: throwing })];
    const r = await call("POST", "/v1/song-search/boom/search", { q: "x" });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR", error: "上游炸了" });
  });
});

describe("导入/详情:能力缺失与上游失败", () => {
  it("album 导入:插件没有 playlistSongs → 404(不是 500)", async () => {
    state.plugins = [plugin("alb-nopl", ["albumSearch"], { searchAlbums: async () => ({ albums: [] }) })];
    const r = await call("POST", "/v1/album-search/alb-nopl/import", { source: "netease", id: "al1" });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ success: false, code: "NOT_FOUND" });
  });

  it("album 详情:插件没有 playlistSongs → 404", async () => {
    state.plugins = [plugin("alb-nopl", ["albumSearch"], { searchAlbums: async () => ({ albums: [] }) })];
    const r = await call("GET", "/v1/album-search/alb-nopl/items?source=netease&id=al1");
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ success: false, code: "NOT_FOUND" });
  });

  it("artist 详情:插件没有 searchSongs → 404", async () => {
    state.plugins = [plugin("art-nosong", ["artistSearch"], { searchArtists: async () => ({ artists: [] }) })];
    const r = await call("GET", "/v1/artist-search/art-nosong/items?name=周杰伦");
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ success: false, code: "NOT_FOUND" });
  });

  it("album 详情:插件 playlistSongs 抛错 → 502", async () => {
    state.plugins = [plugin("alb-boom", ["albumSearch"], { playlistSongs: throwing })];
    const r = await call("GET", "/v1/album-search/alb-boom/items?source=netease&id=al1");
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR", error: "上游炸了" });
  });

  it("artist 详情:插件 searchSongs 抛错 → 502", async () => {
    state.plugins = [plugin("art-boom", ["artistSearch"], { searchSongs: throwing })];
    const r = await call("GET", "/v1/artist-search/art-boom/items?name=X");
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR", error: "上游炸了" });
  });
});

describe("导入:任务已在跑(alreadyRunning)—— 必须 409 CONFLICT + code,不得裸 200", () => {
  it("song 导入:startAsyncTask 返回 started:false → 409 + CONFLICT + alreadyRunning + taskId", async () => {
    (startAsyncTask as any).mockReturnValue({ started: false, taskId: "t-running", alreadyRunning: true });
    state.plugins = [plugin("sg1", ["songSearch"], {})];
    const r = await call("POST", "/v1/song-search/sg1/import", { songs: [{ id: "s1", source: "netease", name: "歌", duration: 200 }] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ success: false, code: "CONFLICT", alreadyRunning: true, taskId: "t-running" });
  });

  it("album 导入:startAsyncTask 返回 started:false → 409 + CONFLICT + alreadyRunning + taskId", async () => {
    (startAsyncTask as any).mockReturnValue({ started: false, taskId: "t-running", alreadyRunning: true });
    state.plugins = [plugin("alb1", ["albumSearch"], { playlistSongs: async () => ({ songs: [] }) })];
    const r = await call("POST", "/v1/album-search/alb1/import", { source: "netease", id: "al1" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ success: false, code: "CONFLICT", alreadyRunning: true, taskId: "t-running" });
  });
});
