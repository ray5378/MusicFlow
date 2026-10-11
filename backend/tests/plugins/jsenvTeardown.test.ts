// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "./_env.js";

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { makeJsenvApi } from "../../src/plugins/discovery.js";
import { loadSandboxedPlugin, type SandboxHostEnv } from "../../src/plugins/sandbox.js";

// ==================== P0 回归守卫:jsenv 子环境 teardown 不得触发 QuickJS 断言 ====================
//
// 现场(2026-10-11,240 生产容器 musicflow v4.5.0):取链高峰期 docker logs 每秒刷十几条
//
//   Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: .../quickjs.c,2036,JS_FreeRuntime)
//   [PLUGIN:lx-source] host.execute 执行异常: Lifetime not alive (需权限 jsenv)
//
// 根因(本机已复现):makeJsenvApi.destroy() 原来直接 `ctx.dispose(); runtime.dispose();`。
// 子环境里经 `__mfJsenvHttp` 发起的宿主请求是 deferred-promise 模式 —— 每个在途请求都
// 捏着 promise / resolve / reject 三枚 JSValue 句柄。destroy 时这些句柄还没释放,对象
// 就被引用计数钉在 rt->gc_obj_list 上,JS_FreeRuntime 立刻命中 list_empty 断言 →
// emscripten abort(宿主 try/catch 抓不住)。lx-source 每加载一个音源都「先 destroy 同名
// 子环境再 create」,而洛雪音源注册过程必然发网络请求 → 每首歌每次兜底取链都刷一条。
//
// 修复:discovery.ts 的 safeDisposeEntry —— teardown 前先结算并释放在途 deferred、
// 排空 pending jobs、驱动一次 GC,把 gc_obj_list 清空后再 dispose。
//
// 本文件锁三件事:
//   ① 有在途宿主请求时 destroy 不得再出现 gc_obj_list 断言(核心修复);
//   ② 反差(灵敏度):强制走修复前路径,断言必须重新出现 —— 证明①的捕获确有判別力;
//   ③ destroy 与 execute 并发时,execute 必须回干净信封,不能抛 QuickJSUseAfterFree
//      ("Lifetime not alive")把错误顶到宿主。
// 另:④ 缺 jsenv 权限的 host.jsenv 调用必须被权限门控返回信封,不得拖垮沙箱。

/** 收集运行期写出的 Aborted(...gc_obj_list...) 断言文本。 */
let captured: string[] = [];
let hooksInstalled = false;
function installAbortCapture(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const seen = new Set<string>();
  const grab = (s: string) => {
    if (!s.includes("gc_obj_list") && !s.includes("JS_FreeRuntime")) return;
    if (seen.has(s)) return;
    seen.add(s);
    captured.push(s.slice(0, 160));
  };
  for (const stream of [process.stdout, process.stderr] as any[]) {
    const orig = stream.write.bind(stream);
    stream.write = (chunk: any, ...rest: any[]) => {
      try { grab(String(chunk)); } catch { /* ignore */ }
      return orig(chunk, ...rest);
    };
  }
  const origErr = console.error.bind(console);
  console.error = (...a: any[]) => {
    try { grab(a.map(String).join(" ")); } catch { /* ignore */ }
    return origErr(...a);
  };
}

/** 让 emscripten 的异步 abort 输出有机会落到 stdout/stderr。 */
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/** 模拟洛雪音源:宿主页 slower,脚本 await 其返回后才注册(/必然产生在途 deferred)。 */
const slowHttp = async (url: string) => {
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true, status: 200, headers: {}, setCookieList: [], body: "OK:" + url };
};

const LX_LIKE_INIT = `
  globalThis.__lxState = { sources: {}, handlers: [], net: [] };
  (async function () {
    await __mfJsenvHttp("https://example.com/boot");
    globalThis.__lxState.sources["wy"] = { actions: ["musicUrl"] };
    globalThis.__lxState.handlers.push("musicUrl");
  })();
  1;
`;

describe("makeJsenvApi 子环境 teardown(P0 回归守卫:禁 QuickJS gc_obj_list 断言)", () => {
  beforeEach(() => { installAbortCapture(); captured = []; });
  afterEach(() => { delete process.env.MF_JSENV_UNSAFE_TEARDOWN; captured = []; });

  it(
    "① 存在在途宿主网络请求时 destroy 不再命中 JS_FreeRuntime 断言(请求未结算)",
    async () => {
      const api = makeJsenvApi({ http: slowHttp });
      await api.create("gc-safe", LX_LIKE_INIT);
      // 故意**不做任何 settle**:让脚本自己发起的那个 __mfJsenvHttp 请求停在 netQueue 里,
      // 这就是 lx-source「先 destroy 同名子环境」时最常撞上的形态。
      await settle(20);

      captured = [];
      await api.destroy("gc-safe");
      await settle();

      expect(captured).toEqual([]);
    },
    30000,
  );

  it(
    "①b drainNet 已出队、正 await 宿主网络时 destroy 也不得命中断言(240 现场主形态)",
    async () => {
      const api = makeJsenvApi({ http: slowHttp });
      await api.create("gc-safe2", LX_LIKE_INIT);
      await settle(20);
      // 起一次 execute:drainNet 会把 netQueue 里的请求**出队**并 await 宿主(300ms),
      // 此刻队列已空、但 deferred 仍活着 —— 240 现场绝大多数 destroy 撞的就是这一形态。
      const execPromise = api.execute("gc-safe2", "(async () => { await __mfJsenvHttp('https://example.com/second'); return 1; })()");
      await settle(60);

      captured = [];
      await api.destroy("gc-safe2");
      try { await execPromise; } catch { /* 允许它以任何形式结算 */ }
      await settle();

      expect(captured).toEqual([]);
    },
    30000,
  );

  it(
    "② 反差(灵敏度校准):强制走修复前路径时,同一操作必须重新刷出 gc_obj_list 断言",
    async () => {
      process.env.MF_JSENV_UNSAFE_TEARDOWN = "1";
      try {
        const api = makeJsenvApi({ http: slowHttp });
        await api.create("gc-unsafe", LX_LIKE_INIT);
        // 与 ① 完全同形:请求未结算就 destroy。修复前路径必须在这里 abort。
        await settle(20);

        captured = [];
        await api.destroy("gc-unsafe");
        await settle();

        // 这条若变绿(不再刷断言),说明 ① 的捕获已失去判别力。
        expect(captured.length).toBeGreaterThan(0);
      } finally {
        delete process.env.MF_JSENV_UNSAFE_TEARDOWN;
      }
    },
    30000,
  );

  it(
    "③ destroy 与 execute 并发时,execute 回干净信封而非抛 QuickJSUseAfterFree",
    async () => {
      delete process.env.MF_JSENV_UNSAFE_TEARDOWN;
      const api = makeJsenvApi({ http: slowHttp });
      await api.create("gc-race", LX_LIKE_INIT);

      // execute 会进入 drainNet 的 await 循环;此刻并发 destroy 掉同一子环境。
      const execPromise = api.execute("gc-race", "(async () => { await __mfJsenvHttp('https://example.com/race'); return 1; })()");
      await new Promise((r) => setTimeout(r, 10));
      const destroyPromise = api.destroy("gc-race");

      let threw: string | null = null;
      let execResult: any = null;
      try { execResult = await execPromise; } catch (e) { threw = String((e as any)?.message || e); }
      await destroyPromise;
      await settle();

      expect(threw).toBeNull();                    // 绝不抛 use-after-free
      expect(execResult).toBeTruthy();
      if (execResult.ok !== true) {
        expect(String(execResult.error)).toContain("已销毁");
        expect(String(execResult.error)).not.toContain("Lifetime not alive");
      }
      expect(captured).toEqual([]);
    },
    30000,
  );

  it(
    "③b destroy 之后 execute 不得再刷 Lifetime not alive(旧环境句柄已释放)",
    async () => {
      const api = makeJsenvApi({ http: slowHttp });
      await api.create("gc-after", LX_LIKE_INIT);
      await settle();
      captured = [];
      await api.destroy("gc-after");
      let msg = "";
      try {
        const r = await api.execute("gc-after", "1+1");
        msg = String(r?.error || "");
        if (r?.ok) return; // 允许「环境已删、宿主另立新环境」的实现,只要不报错即可
      } catch (e) {
        msg = String((e as any)?.message || e);
      }
      expect(msg).not.toContain("Lifetime not alive");
      expect(captured).toEqual([]);
    },
    30000,
  );
});

// ==================== ④ 缺 jsenv 权限的 host.jsenv 调用:拒绝但不许拖垮沙箱 ====================

function makeEnv(permissions: string[], jsenv: any): SandboxHostEnv {
  const store = new Map<string, any>();
  return {
    version: "1.2.0",
    getConfig: () => ({}),
    permissions,
    http: async () => ({ ok: true, status: 200, headers: {}, body: "{}" }),
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); },
      keys: async () => [...store.keys()],
    },
    log: () => {},
    comm: { send: () => {}, broadcast: () => {}, on: () => {}, off: () => {} },
    songs: { list: async () => [], search: async () => [], getById: async () => null },
    plugin: { getHostUrl: async () => "http://host:46400", getNetworkAddresses: async () => [] },
    playlists: { upsert: async () => ({}), get: async () => null, replaceEntries: async () => {}, updateCover: async () => {} },
    sources: { complete: async () => ({ songId: null }) },
    crypto: { md5: (s: string) => "md5-" + s.length },
    jsenv,
  } as unknown as SandboxHostEnv;
}

const PERM_CODE = `
  globalThis.__mfPlugin = {
    manifest: { id: "demo-jsenvperm", name: "x", version: "1.0.0", type: "source", capabilities: ["stream"], configSchema: [], permissions: [] },
    create(host) {
      return {
        // 注意:makeImpl 只暴露 manifest.capabilities 白名单内的方法(EXTRA_METHODS 含 test),
        // 所以探针方法必须叫 test,否则 impl 上根本拿不到。
        async test() {
          const c = await host.jsenv.create("e1", "1;");
          const e = await host.jsenv.execute("e1", "1+1");
          return { c, e };
        },
        // 沙箱存活探针同样必须在白名单内:capabilities=["stream"] → streamUrl。
        streamUrl() { return "alive"; }
      };
    }
  };`;

describe("缺 jsenv 权限时:拒权但不崩沙箱", () => {
  const sandboxes: any[] = [];
  beforeEach(() => { installAbortCapture(); captured = []; });
  afterEach(() => {
    captured = [];
    for (const sb of sandboxes.splice(0)) { try { sb.dispose(); } catch { /* ignore */ } }
  });

  it("未声明 jsenv 权限时 host.jsenv 返回权限信封,沙箱仍可用且 dispose 不抛", async () => {
    const jsenv = makeJsenvApi();
    const { sandbox, impl } = await loadSandboxedPlugin("demo-jsenvperm", PERM_CODE, makeEnv(["net"], jsenv));
    sandboxes.push(sandbox);

    const r: any = await impl.test({});
    // 权限门控:返回的必须是「权限不足」信封,而不是崩溃 / use-after-free。
    const dumped = JSON.stringify(r);
    expect(dumped).toContain("SANDBOX_PERMISSION");
    expect(dumped).not.toContain("Lifetime not alive");
    // 沙箱必须还活着:同一个实例改调无权限方法仍正常。
    expect(impl.streamUrl({})).toBe("alive");
    expect(captured).toEqual([]);
    expect(() => sandbox.dispose()).not.toThrow();
    sandboxes.length = 0;
  }, 30000);
});
