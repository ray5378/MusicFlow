// QA 独立验证 · P0 provider last-good 落库 + 冷态 SWR(路由层)
//
// 契约:
//  1) 冷态(内存无缓存,典型:进程重启 / 空闲回收后)若 DB 有 last-good → **立即返回**
//     该结果,不等待 provider;sandbox 调用转后台单飞刷新(早于 TTL 的 last-good 不重复刷)。
//  2) 无 last-good → 维持原软截止(2500ms 竞速)语义,不得把空结果落库。
//  3) provider 成功返回非空结果 → write-through 落 settings(lastrec.provider.<id>)。
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => {
  const state: { row: any; runCalls: any[][] } = { row: null, runCalls: [] };
  return {
    state,
    firstEnabledByCapability: vi.fn(),
    getEnabledByCapability: vi.fn(() => [] as any[]),
    getPlugin: vi.fn(),
    getPluginConfig: vi.fn(() => ({}) as any),
    listHomeCardPlugins: vi.fn(() => [] as any[]),
    dailyRecommendHomeCount: vi.fn(() => 8),
    findLocalRemotePlaylist: vi.fn(() => undefined as any),
    dailyApi: vi.fn(() => ({} as any)),
    localApi: vi.fn(() => ({ generateLocalDailyPlaylist: () => undefined } as any)),
    comboApi: vi.fn(() => ({ generateComboPlaylist: () => undefined } as any)),
    runPluginJob: vi.fn(() => ({ started: true, alreadyRunning: false }) as any),
    startAsyncTask: vi.fn(() => ({ started: true, taskId: "task-1" }) as any),
    touch: vi.fn(),
    sqlite: {
      prepare: vi.fn((sql: string) => ({
        get: () => (sql.includes("SELECT value FROM settings") ? state.row : undefined),
        run: (...args: any[]) => {
          state.runCalls.push(args);
          if (sql.startsWith("INSERT INTO settings") && String(args[0] || "").startsWith("localrec.provider.")) {
            state.row = { value: args[1] };
          }
          return undefined;
        },
      })),
    },
  };
});

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("../routes/_sharedFakes.js");
  return { ...actual, ...overrides, ...f };
});

import { clearProviderRecommendCache } from "../../src/routes/api/shared.js";
import { __resetRecommendRefreshStateForTest, registerRecommend } from "../../src/routes/api/recommend.js";

type Any = any;
const app = new Hono();
app.use("*", async (c: Any, next: Any) => {
  c.set("user", { id: "u1", username: "ray", isAdmin: true });
  await next();
});
registerRecommend(app as Any);
const get = (p: string) => app.request("http://x" + p);
const json = async (r: Response) => (await r.json()) as Any;

const prov = (id: string, ttl: unknown, fn: Any) => ({
  manifest: { id, capabilities: ["localPlatformRecommend"], ...(ttl === undefined ? {} : { recommendCacheTtlSeconds: ttl }) },
  impl: { recommendLocal: fn },
});

const lastGood = { channels: [{ source: "good", sortOrder: 1, playlists: [{ id: "p1", name: "x" }] }] };

beforeEach(() => {
  clearProviderRecommendCache();
  __resetRecommendRefreshStateForTest();
  f.state.row = null;
  f.state.runCalls = [];
  f.getEnabledByCapability.mockReset().mockReturnValue([]);
  f.getPluginConfig.mockReset().mockReturnValue({});
});

describe("P0 provider last-good + 冷态 SWR", () => {
  it("冷态命中过期 last-good:立即返回该结果,provider 转后台单飞刷新", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(
        () => new Promise((res) => setTimeout(() => res({ channels: [{ source: "fresh", sortOrder: 1, playlists: [] }] }), 6000)),
      );
      f.getEnabledByCapability.mockReturnValue([prov("chart-x", 120, fn)]);
      f.state.row = { value: JSON.stringify({ ts: Date.now() - 120_000, result: lastGood }) };

      const b = await json(await get("/v1/local-recommend"));
      // 未等待 6000ms 的 provider:返回的是 last-good。
      expect(b.channels[0].source).toBe("good");
      expect(b.pending).toBeUndefined();
      expect(fn).toHaveBeenCalledTimes(1); // 后台只发起一次
      await vi.advanceTimersByTimeAsync(6100); // 收敛后台 promise,避免悬挂定时器
    } finally {
      vi.useRealTimers();
    }
  });

  it("冷态命中未过期 last-good:直接复用,不发起 provider 调用", async () => {
    const fn = vi.fn(async () => ({ channels: [{ source: "fresh", sortOrder: 1, playlists: [] }] }));
    f.getEnabledByCapability.mockReturnValue([prov("chart-y", 120, fn)]);
    f.state.row = { value: JSON.stringify({ ts: Date.now(), result: lastGood }) };
    const b = await json(await get("/v1/local-recommend"));
    expect(b.channels[0].source).toBe("good");
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it("无 last-good:保持软截止竞速语义(pending:true 且不落空结果)", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(() => new Promise(() => undefined as never) as Promise<any>);
      f.getEnabledByCapability.mockReturnValue([prov("slow-z", 120, fn)]);
      const firstResp = get("/v1/local-recommend").then((r) => r.json());
      await vi.advanceTimersByTimeAsync(2600);
      const b1 = await firstResp;
      expect(b1.pending).toBe(true);
      expect(b1.channels).toEqual([]);
      expect(f.state.runCalls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("provider 成功且非空:结果 write-through 落库(带前缀的 settings 行)", async () => {
    const fn = vi.fn(async () => ({ channels: [{ source: "fresh", sortOrder: 1, playlists: [{ id: "p2" }] }] }));
    f.getEnabledByCapability.mockReturnValue([prov("chart-z", 120, fn)]);
    const b = await json(await get("/v1/local-recommend"));
    expect(b.channels[0].source).toBe("fresh");
    // INSERT 3 参(key/value/updated_at);DELETE 2 参,用参数个数区分,避免把清理语句也算成写入。
    const inserts = f.state.runCalls.filter(
      (a) => a.length === 3 && String(a[0] || "").startsWith("localrec.provider."),
    );
    expect(inserts.length).toBe(1);
    expect(inserts[0][0]).toBe("localrec.provider.chart-z");
    const row = JSON.parse(String(f.state.row?.value));
    expect(row.result.channels[0].source).toBe("fresh");
  });
});
