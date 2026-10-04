// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, afterEach } from "vitest";
import { loadSandboxedPlugin, type SandboxHostEnv } from "../../src/plugins/sandbox.js";

// ==================== A 项回归锁:host 异步结果句柄在 resolve 后必须释放 ====================
//
// 泄漏机理(实测):hostAsync 内部 `deferred.resolve(this.jsToHandle(value))` —— resolve
// **不消费**句柄。若 resolve 后不 dispose,QuickJS 的引用计数会把该对象一直钉住 →
// refcount 永不归零 → GC 永不回收 → 堆单调增长(实测 ~1454 B/次调用,即线上
// 「首页刷新 +2.6MB、256MB OOM」的根因);累积到 teardown 时,残留对象令
// JS_FreeRuntime 命中 `Assertion failed: list_empty(&rt->gc_obj_list)`(abort)。
//
// 修复:jsToHandle 出的句柄在 resolve 后走文件内已有的 safeDispose(null/true/false
// 等共享句柄被守卫,不会误释放)。
//
// 本文件用两个用例证明:
//   ① 修复后:N 次 host 调用后 QuickJS 对象数基本不增长,且 dispose 不触发断言;
//   ② 反差(灵敏度校准):强制走「不释放」路径时,同一循环的对象数确实线性增长 ——
//      证明①的阈值确有判别力(若把 dispose 改回去,①会红)。

function makeEnv(overrides?: Partial<SandboxHostEnv>): SandboxHostEnv {
  const store = new Map<string, any>();
  return {
    version: "1.2.0",
    getConfig: () => ({ baseUrl: "http://demo:18080", apiKey: "k" }),
    permissions: ["net", "storage"],
    // 每次 host.http 返回一个**普通对象**(非共享 null/true/false),这是触发句柄
    // 泄漏的必要条件:jsToHandle(对象) 会 newObject 出一个新句柄。
    http: async (input, init) => ({
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: input, q: (init || {}).q }),
    }),
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); },
      keys: async () => [...store.keys()],
    },
    log: () => {},
    comm: { send: () => {}, broadcast: () => {}, on: () => {}, off: () => {} },
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
    crypto: { md5: (s: string) => "md5-" + s.length },
    ...overrides,
  } as SandboxHostEnv;
}

/** 循环 N 次 host.http(每次返回对象),返回调用次数。 */
const N = 300;
const CODE = `
  globalThis.__mfPlugin = {
    manifest: { id: "demo-hostdispose", name: "x", version: "1.0.0", type: "source", capabilities: ["search"], configSchema: [], permissions: ["net"] },
    create(host) {
      return {
        async search(config, params) {
          let n = 0;
          for (let i = 0; i < ${N}; i++) {
            const r = await host.http("https://demo/h?i=" + i, {});
            if (!r || !r.ok) throw new Error("http fail");
            n++;
          }
          return { n };
        }
      };
    }
  };`;

/**
 * 读取 QuickJS 运行时的内存画像。
 * `runtime.computeMemoryUsage()` 返回的是 **VM 内的对象句柄**(不是宿主对象),
 * 需经 `ctx.dump()` 取出其 snake_case 字段后自行 dispose 该句柄(否则它本身就是泄漏源)。
 */
function memSnapshot(sandbox: any): { objCount: number; memUsed: number } {
  const h = sandbox.runtime.computeMemoryUsage();
  const mu = sandbox.ctx.dump(h);
  h.dispose();
  return { objCount: mu.obj_count as number, memUsed: mu.memory_used_size as number };
}

describe("A:host 异步结果句柄在 resolve 后释放(防 QuickJS 句柄泄漏)", () => {
  const live: any[] = [];
  afterEach(() => {
    delete process.env.SANDBOX_LEAK_HOST_RESULT;
    for (const sb of live.splice(0)) { try { sb.dispose(); } catch { /* ignore */ } }
  });

  it(`${N} 次 host.http 后 QuickJS 对象数不增长,且 teardown 不触发 gc_obj_list 断言`, async () => {
    const { sandbox, impl } = await loadSandboxedPlugin("demo-hostdispose", CODE, makeEnv());
    live.push(sandbox);

    const before = memSnapshot(sandbox);
    const r = (await impl.search({}, {})) as any;
    expect(r.n).toBe(N);
    await new Promise((res) => setTimeout(res, 30)); // 让在途 job / microtask 结算
    const after = memSnapshot(sandbox);

    // 修复前:每次调用泄漏一个对象句柄 → obj ≈ +N(实测同量级),堆 +~430KB。
    // 修复后:句柄随调用释放,增长应远小于 N(阈值留足噪声余量)。
    expect(after.objCount - before.objCount).toBeLessThan(30);
    expect(after.memUsed - before.memUsed).toBeLessThan(100 * 1024);

    // teardown 必须干净:残留句柄会钉住 gc_obj_list → JS_FreeRuntime 断言 abort。
    expect(() => sandbox.dispose()).not.toThrow();
  }, 30000);

  it("反差(灵敏度校准):故意不释放句柄时,同一循环的对象数确实线性增长", async () => {
    process.env.SANDBOX_LEAK_HOST_RESULT = "1"; // 强制跳过 safeDispose
    const { sandbox, impl } = await loadSandboxedPlugin("demo-hostdispose", CODE, makeEnv());
    live.push(sandbox);

    const before = memSnapshot(sandbox);
    await impl.search({}, {});
    await new Promise((res) => setTimeout(res, 30));
    const after = memSnapshot(sandbox);

    // 不释放 → 每次调用泄漏一个对象句柄:对象数至少 +N/2。
    // 这条用例若变红,说明①的阈值已失去判别力(需重新校准)。
    expect(after.objCount - before.objCount).toBeGreaterThan(N / 2);
  }, 30000);
});
