// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { loadSandboxedPlugin, type SandboxedPlugin } from "../../src/plugins/sandbox.js";
import type { SandboxHostEnv } from "../../src/plugins/sandbox.js";

const TMP = path.join(os.tmpdir(), `mfv2-sandbox-${Date.now()}`);
const store = new Map<string, any>();

function makeEnv(overrides?: Partial<SandboxHostEnv>): SandboxHostEnv {
  return {
    version: "1.2.0",
    getConfig: () => ({ baseUrl: "http://demo:18080", apiKey: "k" }),
    permissions: ["net", "storage"],
    http: async (input, init) => {
      await new Promise((r) => setTimeout(r, 2));
      return { ok: true, status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ url: input, q: (init || {}).q }) };
    },
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); },
      keys: async () => [...store.keys()],
    },
    log: () => {},
    comm: {
      send: () => {},
      broadcast: () => {},
      on: () => {},
    },
    ...overrides,
  };
}

const PLUGIN_CODE = `
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-sandbox",
    name: "沙箱演示",
    version: "1.0.0",
    type: "source",
    description: "test",
    capabilities: ["search", "stream", "recommend", "scrobbler"],
    platforms: ["demo"],
    configSchema: [],
    permissions: ["net", "storage"]
  },
  create(host) {
    return {
      async test(config) { return { success: true, message: "pong:" + (host.config && host.config.baseUrl) }; },
      async search(config, params) {
        const r = await host.http("https://demo/search?q=" + params.query, { q: params.query });
        const data = JSON.parse(r.body);
        return { songs: [{ id: "s1", title: "hit-" + params.query, source: "demo", data: data }] };
      },
      streamUrl(config, song, range) { return "http://demo/stream?id=" + song.id + "&apiKey=" + config.apiKey; },
      async onPlay(ev) { await host.storage.set("last", ev.songId); return { success: true }; },
      async onScrobble(ev) { const last = await host.storage.get("last"); return { ok: true, last: last }; }
    };
  }
};
`;

let sandboxRef: SandboxedPlugin | null = null;

afterAll(() => {
  try { sandboxRef?.dispose(); } catch { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("QuickJS 插件沙箱", () => {
  it("加载沙箱插件并返回 manifest + impl 门面", async () => {
    const { sandbox, impl } = await loadSandboxedPlugin("demo-sandbox", PLUGIN_CODE, makeEnv(), {
      id: "demo-sandbox", name: "沙箱演示", version: "1.0.0",
    } as any);
    sandboxRef = sandbox;
    expect(sandbox.manifest.id).toBe("demo-sandbox");
    expect(sandbox.manifest.capabilities).toContain("search");
    // 只暴露插件实际实现的方法
    expect(typeof impl.search).toBe("function");
    expect(typeof impl.streamUrl).toBe("function");
    expect(typeof impl.onPlay).toBe("function");
    expect(impl.recommend).toBeUndefined(); // 未实现 → 不暴露
  });

  it("异步方法调用走 RPC,host.http 可用,中文参数完好", async () => {
    const { impl } = await loadSandboxedPlugin("demo-sandbox", PLUGIN_CODE, makeEnv());
    const res = await impl.search({ baseUrl: "http://demo:18080" }, { query: "周杰伦" });
    expect(res.songs[0].title).toBe("hit-周杰伦");
    expect(res.songs[0].data.q).toBe("周杰伦");
  });

  it("同步方法(streamUrl)同步返回字符串", async () => {
    const { impl } = await loadSandboxedPlugin("demo-sandbox", PLUGIN_CODE, makeEnv());
    const url = impl.streamUrl({ apiKey: "abc" }, { id: "s9" });
    expect(url).toBe("http://demo/stream?id=s9&apiKey=abc");
  });

  it("host.storage 跨调用持久(插件内 KV)", async () => {
    const { impl } = await loadSandboxedPlugin("demo-sandbox", PLUGIN_CODE, makeEnv());
    await impl.onPlay({}, { songId: "so-1" });
    const r = await impl.onScrobble({}, { songId: "so-1" });
    expect(r.last).toBe("so-1");
  });

  it("权限拒绝:无 net 权限时 host.http 返回 PERMISSION_DENIED 信封", async () => {
    const { impl } = await loadSandboxedPlugin("demo-sandbox", PLUGIN_CODE, makeEnv({ permissions: ["storage"] }));
    // 插件代码不处理权限信封 → 搜索失败但宿主不崩(错误信息含 PERMISSION_DENIED)
    await expect(impl.search({}, { query: "x" })).rejects.toThrow(/PERMISSION_DENIED|unexpected|Unexpected|失败/);
  });

  it("插件抛错经信封传播为可读错误", async () => {
    const code = PLUGIN_CODE.replace('async search(config, params) {', 'async search(config, params) { throw new Error("boom-" + params.query);');
    const { impl } = await loadSandboxedPlugin("demo-sandbox", code, makeEnv());
    await expect(impl.search({}, { query: "42" })).rejects.toThrow(/boom-42/);
  });

  it("index.js manifest 与 plugin.json 不一致时拒绝加载", async () => {
    await expect(
      loadSandboxedPlugin("demo-sandbox", PLUGIN_CODE, makeEnv(), { id: "demo-sandbox", version: "9.9.9" } as any),
    ).rejects.toThrow(/不一致/);
  });

  it("加载失败后仍可继续加载其他插件(模块不毒化)", async () => {
    const bad = `globalThis.__mfPlugin = { manifest: { id: "demo-sandbox", name: "x", version: "1.0.0", type: "source", capabilities: ["search"], configSchema: [] }, create() { throw new Error("create-fail"); } };`;
    await expect(loadSandboxedPlugin("demo-sandbox", bad, makeEnv())).rejects.toThrow(/create-fail/);
    const { impl } = await loadSandboxedPlugin("demo-sandbox", PLUGIN_CODE, makeEnv());
    const r = await impl.test({});
    expect(r.success).toBe(true);
  });
});
