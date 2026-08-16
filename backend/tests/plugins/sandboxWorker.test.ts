// 沙箱批量 worker 通道专项测试:
//   - 插件声明 longRunning 后,loadSandboxedPlugin 自动启动批量 worker;
//   - longRunning 方法在 worker 线程执行,host.* 经 IPC 桥回主线程真实 env 执行;
//   - 普通交互方法仍走主线程快路径;config 随 invoke 消息注入 worker;
//   - SANDBOX_WORKER_DISABLE=1 时回退主线程(无 worker)。
import "../plugins/_env.js";

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { loadSandboxedPlugin } from "../../src/plugins/sandbox.js";
import type { SandboxHostEnv } from "../../src/plugins/sandbox.js";

const TMP = path.join(os.tmpdir(), `mf-sandbox-worker-${Date.now()}`);
const store = new Map<string, any>();
let httpCalls = 0;
let storageCalls = 0;

function makeEnv(overrides?: Partial<SandboxHostEnv>): SandboxHostEnv {
  return {
    version: "1.2.0",
    getConfig: () => ({ baseUrl: "http://demo:18080", apiKey: "k" }),
    permissions: ["net", "storage"],
    http: async (input, init) => {
      httpCalls++;
      await new Promise((r) => setTimeout(r, 2));
      return { ok: true, status: 200, headers: {}, body: JSON.stringify({ url: input, q: (init || {}).q }) };
    },
    storage: {
      get: async (k) => { storageCalls++; return store.get(k) ?? null; },
      set: async (k, v) => { storageCalls++; store.set(k, v); },
      delete: async (k) => { storageCalls++; store.delete(k); },
      keys: async () => { storageCalls++; return [...store.keys()]; },
    },
    log: () => {},
    comm: { send: () => {}, broadcast: () => {}, on: () => {} },
    songs: {
      list: async () => [],
      search: async () => [],
      getById: async () => null,
    },
    plugin: {
      getHostUrl: async () => "http://host:46400",
      getNetworkAddresses: async () => ["127.0.0.1"],
    },
    playlists: {
      upsert: async (id: string, opts: any) => ({ ok: true, id, ...opts }),
      get: async () => ({ ok: true }),
      replaceEntries: async () => ({ ok: true }),
      updateCover: async () => ({ ok: true }),
    },
    sources: { complete: async (opts: any) => ({ ok: true, songId: "so-new", opts }) },
    crypto: { md5: (s: string) => `md5-${s.length}` },
    ...overrides,
  };
}

const PLUGIN_CODE = `
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-worker",
    name: "worker 演示",
    version: "1.0.0",
    type: "source",
    description: "test",
    capabilities: ["search", "stream", "recommend"],
    platforms: ["demo"],
    configSchema: [],
    permissions: ["net", "storage"],
    longRunning: { search: 30000 }
  },
  create(host) {
    return {
      // longRunning 批量方法(search):应走 worker 线程,host.http/storage 经 IPC 桥回主线程。
      async search(config, params) {
        const r = await host.http("https://demo/batch?q=" + params.query, { q: params.query });
        const data = JSON.parse(r.body);
        await host.storage.set("last", params.query);
        const back = await host.storage.get("last");
        return { songs: [{ id: "s1", title: "hit-" + params.query, source: "demo" }], url: data.url, q: data.q, back: back, base: config.baseUrl };
      },
      // 普通交互方法(recommend):仍走主线程快路径。
      async recommend(config, params) { return { success: true, base: config.baseUrl }; },
      streamUrl(config, song, range) { return "http://demo/stream?id=" + song.id; }
    };
  }
};
`;

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("沙箱批量 worker 通道", () => {
  it("longRunning 方法经 worker 执行,host.* 桥往返正确,config 注入生效", async () => {
    httpCalls = 0; storageCalls = 0;
    const { sandbox, impl } = await loadSandboxedPlugin("demo-worker", PLUGIN_CODE, makeEnv());
    try {
      const out = await impl.search({ baseUrl: "http://demo:18080", apiKey: "k" }, { query: "周杰伦" });
      expect(out.songs[0].title).toBe("hit-周杰伦");
      expect(out.url).toContain("batch?q=");
      expect(out.q).toBe("周杰伦");
      expect(out.back).toBe("周杰伦");   // storage set→get 桥往返
      expect(out.base).toBe("http://demo:18080"); // config 随 invoke 注入 worker
      expect(httpCalls).toBe(1);
      expect(storageCalls).toBe(2);
    } finally {
      sandbox.dispose();
    }
  });

  it("普通交互方法仍走主线程(快路径,不依赖 worker)", async () => {
    const { sandbox, impl } = await loadSandboxedPlugin("demo-worker", PLUGIN_CODE, makeEnv());
    try {
      const out = await impl.recommend({ baseUrl: "http://demo:18080", apiKey: "k" }, {});
      expect(out).toEqual({ success: true, base: "http://demo:18080" });
    } finally {
      sandbox.dispose();
    }
  });

  it("同步方法(streamUrl)不受 worker 影响", async () => {
    const { sandbox, impl } = await loadSandboxedPlugin("demo-worker", PLUGIN_CODE, makeEnv());
    try {
      expect(impl.streamUrl({}, { id: "s1" })).toBe("http://demo/stream?id=s1");
    } finally {
      sandbox.dispose();
    }
  });

  it("SANDBOX_WORKER_DISABLE=1 时回退主线程(无 worker,批量方法照常)", async () => {
    process.env.SANDBOX_WORKER_DISABLE = "1";
    httpCalls = 0;
    const { sandbox, impl } = await loadSandboxedPlugin("demo-worker", PLUGIN_CODE, makeEnv());
    try {
      const out = await impl.search({ baseUrl: "http://demo:18080", apiKey: "k" }, { query: "x" });
      expect(out.songs[0].title).toBe("hit-x");
      expect(out.q).toBe("x");
      expect(httpCalls).toBe(1);
    } finally {
      delete process.env.SANDBOX_WORKER_DISABLE;
      sandbox.dispose();
    }
  });
});
