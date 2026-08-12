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
    songs: {
      list: async () => [{ id: "so-1", title: "Demo Song" }],
      search: async (q) => [{ id: "so-1", title: "Demo Song", artist: "Demo" }],
      getById: async (id) => (id === "so-1" ? { id: "so-1", title: "Demo Song", artist: "Demo", album: "A", duration: 120 } : null),
    },
    plugin: {
      getHostUrl: async () => "http://host:46400",
      getNetworkAddresses: async () => ["127.0.0.1"],
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

const HOST_API_PLUGIN_CODE = `
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-hostapi",
    name: "host API 演示",
    version: "1.0.0",
    type: "source",
    capabilities: ["search"],
    configSchema: [],
    permissions: ["songs:read"]
  },
  create(host) {
    return {
      async search(config, params) {
        if (params.byId) {
          const s = await host.songs.getById(params.byId);
          if (s && s.ok === false) throw new Error("DENIED:" + (s.error && s.error.message));
          return { songs: s ? [{ id: s.id, title: s.title }] : [] };
        }
        const list = await host.songs.search(params.query);
        return { songs: list.map((s) => ({ id: s.id, title: s.title })) };
      },
      async test(config) {
        const url = await host.plugin.getHostUrl();
        const addrs = await host.plugin.getNetworkAddresses();
        return { success: true, message: "url=" + url + ";addrs=" + addrs.length };
      }
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

  it("host.songs.getById / search 走 songs:read 权限查询曲库", async () => {
    const { impl } = await loadSandboxedPlugin("demo-hostapi", HOST_API_PLUGIN_CODE, makeEnv({ permissions: ["songs:read"] }));
    const byId = await impl.search({}, { byId: "so-1" });
    expect(byId.songs[0].title).toBe("Demo Song");
    const bySearch = await impl.search({}, { query: "demo" });
    expect(bySearch.songs[0].title).toBe("Demo Song");
  });

  it("host.songs 无 songs:read 权限时拒绝(PERMISSION_DENIED,信封带方法名)", async () => {
    const { impl } = await loadSandboxedPlugin("demo-hostapi", HOST_API_PLUGIN_CODE, makeEnv({ permissions: ["net"] }));
    await expect(impl.search({}, { byId: "so-1" })).rejects.toThrow(/PERMISSION_DENIED: songs:read \(host\.getById\)/);
  });

  it("host.http 非 2xx/网络错误时插件能读到透明信封(status + 真实原因)", async () => {
    // 验证:env.http 返回失败信封后,沙箱原样透传给插件(带 status 与 error.message),
    // 不再出现 "HTTP undefined" 这类丢失真因的报错。
    const code = `
      globalThis.__mfPlugin = {
        manifest: { id: "demo-sandbox", name: "x", version: "1.0.0", type: "source", capabilities: ["search"], configSchema: [], permissions: ["net"] },
        create(host) {
          return {
            async search(config, params) {
              const r = await host.http("https://demo/fail", {});
              const reason = (r.error && r.error.message) || r.error;
              return { ok: r.ok, status: r.status, err: reason };
            }
          };
        }
      };`;
    const env = makeEnv({ http: async () => ({ ok: false, status: 502, headers: {}, body: "", error: "Bad Gateway upstream" }) });
    const { impl } = await loadSandboxedPlugin("demo-sandbox", code, env);
    const r = await impl.search({}, {});
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(String(r.err)).toContain("Bad Gateway upstream");
  });

  it("host.http 实现抛异常时沙箱兜底信封带 status:0,不泄露 undefined", async () => {
    // 验证:env.http 自身抛异常(如编程错误)时,沙箱兜底为 { ok:false, status:0, error },
    // 插件读到的 status 是 0 而非 undefined。
    const code = `
      globalThis.__mfPlugin = {
        manifest: { id: "demo-sandbox", name: "x", version: "1.0.0", type: "source", capabilities: ["search"], configSchema: [], permissions: ["net"] },
        create(host) {
          return {
            async search(config, params) {
              const r = await host.http("https://demo/boom", {});
              return { status: r.status, err: r.error && r.error.message };
            }
          };
        }
      };`;
    const env = makeEnv({ http: async () => { throw new Error("env http exploded"); } });
    const { impl } = await loadSandboxedPlugin("demo-sandbox", code, env);
    const r = await impl.search({}, {});
    expect(r.status).toBe(0);
    expect(String(r.err)).toContain("env http exploded");
  });

  it("host.plugin.getHostUrl / getNetworkAddresses 返回宿主信息", async () => {
    const { impl } = await loadSandboxedPlugin("demo-hostapi", HOST_API_PLUGIN_CODE, makeEnv({
      plugin: {
        getHostUrl: async () => "http://ha:46400",
        getNetworkAddresses: async () => ["192.168.1.5", "10.0.0.8"],
      },
    }));
    const r = await impl.test({});
    expect(r.message).toBe("url=http://ha:46400;addrs=2");
  });

  it("host.http 累计调用远超 MAX_DEFERS 仍正常(不按累计次数限流)", async () => {
    // 回归:defers 数组曾只增不减,累计 ~64 次调用后会永久误报
    // "调用过于密集,拒绝新请求",导致搜索等长跑功能间歇性全失败。
    // 修复后 defers 只统计在途请求,结算即移除,故顺序 120 次调用应全部成功。
    const code = `
      globalThis.__mfPlugin = {
        manifest: { id: "demo-sandbox", name: "x", version: "1.0.0", type: "source", capabilities: ["search"], configSchema: [], permissions: ["net"] },
        create(host) {
          return {
            async search(config, params) {
              let ok = 0;
              for (let i = 0; i < 120; i++) {
                const r = await host.http("https://demo/hit?i=" + i, {});
                if (!r.ok) throw new Error("HTTP_FAIL:" + (r.error && r.error.message));
                ok++;
              }
              return { ok };
            }
          };
        }
      };`;
    const { impl } = await loadSandboxedPlugin("demo-sandbox", code, makeEnv());
    const res = await impl.search({}, {});
    expect(res.ok).toBe(120);
  });

  it("并发在途 host.http 超 MAX_DEFERS 时仍按并发维度拒绝(防御失控并发)", async () => {
    // 验证限流仍是「并发维度」而非「累计维度」:同一时刻拉起大量未结算调用应被拒。
    const code = `
      globalThis.__mfPlugin = {
        manifest: { id: "demo-sandbox", name: "x", version: "1.0.0", type: "source", capabilities: ["search"], configSchema: [], permissions: ["net"] },
        create(host) {
          return {
            async search(config, params) {
              // 同时发出 128 个 host.http,但 env.http 永不 resolve(挂起),
              // 制造 128 个在途 deferred,应触发限流拒绝(不崩溃)。
              const ps = [];
              for (let i = 0; i < 128; i++) ps.push(host.http("https://demo/h?i=" + i, {}));
              const rs = await Promise.allSettled(ps);
              let rejected = 0;
              const LIMIT_RE = /并发 host 调用过多|拒绝新请求/;
              for (const r of rs) {
                if (r.status === "rejected" && LIMIT_RE.test(String(r.reason && r.reason.message || r.reason))) rejected++;
                else if (r.status === "fulfilled" && r.value && r.value.error && LIMIT_RE.test(String(r.value.error.message))) rejected++;
              }
              return { rejected };
            }
          };
        }
      };`;
    // env.http 很快 resolve(否则在途请求永不结算,allSettled 会挂死);
    // 关键只在「同一时刻拉起 128 个未结算调用」这一瞬间触发并发限流。
    const env = makeEnv({ http: async () => { await new Promise((r) => setTimeout(r, 5)); return { ok: true, status: 200, body: "{}" }; } });
    const { impl } = await loadSandboxedPlugin("demo-sandbox", code, env);
    const res = await impl.search({}, {});
    expect(res.rejected).toBeGreaterThan(0);
  });

  it("host.comm.on 注册的监听器在 dispose 时被移除(防 hot-reload 重复投递)", async () => {
    // 回归:host.comm.on 把闭包注册到全局 env.comm,原实现 dispose 时从不 off,
    // hot-reload 重载插件会累积监听器,导致同一条消息被重复投递 N 次。
    const commListeners = new Set<(...args: any[]) => void>();
    const env = makeEnv({
      comm: {
        send: () => {},
        broadcast: () => {},
        on: (h: any) => commListeners.add(h),
        off: (h: any) => commListeners.delete(h),
      },
    });
    const code = `
      globalThis.__mfPlugin = {
        manifest: { id: "demo-comm", name: "x", version: "1.0.0", type: "source", capabilities: ["search"], configSchema: [], permissions: [] },
        create(host) {
          return {
            async search() {
              host.comm.on((m) => { globalThis.__last = m; });
              return { ok: true };
            }
          };
        }
      };`;
    const { sandbox, impl } = await loadSandboxedPlugin("demo-comm", code, env);
    await impl.search({}, {});
    // 调用 host.comm.on 后应已在 env.comm 上注册 1 个监听器
    expect(commListeners.size).toBe(1);
    // 模拟 hot-reload:dispose 旧实例
    sandbox.dispose();
    // dispose 后必须已 off,监听器清空(否则每次 reload 都 +1,消息重复投递)
    expect(commListeners.size).toBe(0);
  });
});
