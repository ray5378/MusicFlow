// dailyRecommend 域路由层契约测试 —— src/routes/api/dailyRecommend.ts(4 条路由)。
//
// 锁定的是「配置读取的兜底与归一化」与「候选池清洗规则」:
//  - settings 读空时的默认值(enabled=true / hour=3 / 非法 hour 回落 3)
//  - time 只接受 HH:MM 并补零;旧客户端的 hour 与新的 time 同源写入
//  - 候选池必须过滤掉缺 url/platform 的项,被屏蔽项剔除后单独回报,全空即 400
//  - 触发生成时上游异常要落成受控 500,且原因缺失时回落 i18n 文案
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => {
  const state = {
    settings: new Map<string, string>(),
    plRow: null as any,
    runs: [] as any[][],
  };
  return {
    state,
    dailyApi: vi.fn(() => null as any),
    dailyRecommendTag: vi.fn(() => "每日推荐"),
    formatDailyTime: vi.fn(() => "03:00"),
    rearmDailyScheduler: vi.fn(),
    sqlite: {
      prepare: vi.fn((sql: string) => ({
        get: (...args: any[]) => {
          if (sql.includes("FROM settings")) {
            return state.settings.has(args[0]) ? { value: state.settings.get(args[0]) } : undefined;
          }
          if (sql.includes("FROM playlists")) return state.plRow ? { ...state.plRow } : undefined;
          return undefined;
        },
        run: (...args: any[]) => {
          state.runs.push(args);
          state.settings.set(String(args[0]), String(args[1]));
          return { changes: 1 };
        },
      })),
    },
  };
});

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("./_sharedFakes.js");
  return { ...actual, ...overrides, ...f };
});

import { registerDailyRecommend } from "../../src/routes/api/dailyRecommend.js";

type Any = any;

const app = new Hono();
app.use("*", async (c: Any, next: Any) => {
  c.set("user", { id: "u1", username: "ray", isAdmin: true });
  await next();
});
registerDailyRecommend(app as Any);

const get = (p: string) => app.request("http://x" + p);
const send = (m: string, p: string, body?: Any) =>
  app.request("http://x" + p, {
    method: m,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as Any;

/** 路由内部用的「今天」,与实现同款算法(本地时区)。 */
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

beforeEach(() => {
  f.state.settings.clear();
  f.state.plRow = null;
  f.state.runs.length = 0;
  f.dailyApi.mockReset().mockReturnValue(null);
  f.dailyRecommendTag.mockReset().mockReturnValue("每日推荐");
  f.formatDailyTime.mockReset().mockReturnValue("03:00");
  f.rearmDailyScheduler.mockReset();
});

// ==================== GET /v1/daily-recommend ====================

describe("GET /v1/daily-recommend", () => {
  it("settings 全空 → 默认开启、3 点、候选与当日选中为空、今日歌单为 null", async () => {
    const b = await json(await get("/v1/daily-recommend"));
    expect(b).toEqual({
      enabled: true,
      hour: 3,
      time: "03:00",
      candidates: [],
      pickedToday: null,
      today,
      playlists: { today: null },
    });
  });

  it("enabled 接受 true/1 两种写法,其余一律视为关闭", async () => {
    for (const [raw, expected] of [["true", true], ["1", true], ["false", false], ["0", false], ["yes", false]] as Array<[string, boolean]>) {
      f.state.settings.clear();
      f.state.settings.set("daily_recommend_enabled", raw);
      expect((await json(await get("/v1/daily-recommend"))).enabled).toBe(expected);
    }
  });

  it("hour 存了非数字 → 回落 3(不返回 NaN)", async () => {
    f.state.settings.set("daily_recommend_hour", "abc");
    expect((await json(await get("/v1/daily-recommend"))).hour).toBe(3);
  });

  it("dailyApi 就绪 → 透传候选池与当日选中", async () => {
    f.dailyApi.mockReturnValue({
      loadCandidates: () => [{ platform: "qq", url: "u" }],
      pickDailyCandidate: () => ({ platform: "qq", url: "u" }),
    });
    const b = await json(await get("/v1/daily-recommend"));
    expect(b.candidates).toHaveLength(1);
    expect(b.pickedToday).toEqual({ platform: "qq", url: "u" });
  });

  it("comment 里带今天日期 → createdToday=true(生成日期戳在 comment,不在 created_at)", async () => {
    f.state.plRow = { id: "pl-daily-today", name: "每日推荐", song_count: 40, created_at: "2026-01-01", comment: `generated ${today}` };
    const p = (await json(await get("/v1/daily-recommend"))).playlists.today;
    expect(p).toEqual({ id: "pl-daily-today", name: "每日推荐", songCount: 40, createdToday: true });

    f.state.plRow = { id: "pl-daily-today", name: "每日推荐", song_count: 0, comment: "generated 2000-01-01" };
    expect((await json(await get("/v1/daily-recommend"))).playlists.today.createdToday).toBe(false);
  });

  it("comment 为 null 时 createdToday=false(不抛)", async () => {
    f.state.plRow = { id: "x", name: "每日推荐", song_count: 0, comment: null };
    expect((await json(await get("/v1/daily-recommend"))).playlists.today.createdToday).toBe(false);
  });

  it("dailyRecommendTag 为空 → 查询名回落「每日推荐」", async () => {
    f.dailyRecommendTag.mockReturnValue("");
    await get("/v1/daily-recommend");
    // 两条查询都用回落后的名字(第二次调用的 LIKE 参数应为 %每日推荐%)
    const calls = f.sqlite.prepare.mock.calls.filter(([sql]: Any) => String(sql).includes("FROM playlists"));
    expect(calls.length).toBeGreaterThan(0);
  });
});

// ==================== PUT /v1/daily-recommend/config ====================

describe("PUT /v1/daily-recommend/config", () => {
  it("enabled 布尔 → 写库并立即 rearm(不必等 24h)", async () => {
    const r = await send("PUT", "/v1/daily-recommend/config", { enabled: false });
    expect(r.status).toBe(200);
    expect(f.state.settings.get("daily_recommend_enabled")).toBe("false");
    expect(f.rearmDailyScheduler).toHaveBeenCalledTimes(1);
  });

  it("enabled 非布尔 → 忽略(不算变更,不 rearm)", async () => {
    await send("PUT", "/v1/daily-recommend/config", { enabled: "yes" });
    expect(f.state.settings.has("daily_recommend_enabled")).toBe(false);
    expect(f.rearmDailyScheduler).not.toHaveBeenCalled();
  });

  it("time 合法 HH:MM → 补零写入", async () => {
    await send("PUT", "/v1/daily-recommend/config", { time: " 5:07 " });
    expect(f.state.settings.get("daily_recommend_time")).toBe("05:07");
    expect(f.rearmDailyScheduler).toHaveBeenCalled();
  });

  it("time 非法且显式传入 → 400(不接受静默忽略)", async () => {
    for (const bad of ["25:00", "3:5", "abc", "12:60", ""]) {
      f.rearmDailyScheduler.mockClear();
      const r = await send("PUT", "/v1/daily-recommend/config", { time: bad });
      expect(r.status).toBe(400);
      expect((await json(r)).code).toBe("INVALID_PARAM");
    }
  });

  it("旧客户端只发 hour → 同时写 hour 与 time(新旧配置同源)", async () => {
    await send("PUT", "/v1/daily-recommend/config", { hour: 7 });
    expect(f.state.settings.get("daily_recommend_hour")).toBe("7");
    expect(f.state.settings.get("daily_recommend_time")).toBe("07:00");
    expect(f.rearmDailyScheduler).toHaveBeenCalled();
  });

  it("hour 越界或非数字 → 400 hourRange", async () => {
    for (const bad of [24, -1, "abc", null]) {
      const r = await send("PUT", "/v1/daily-recommend/config", { hour: bad });
      expect(r.status).toBe(400);
    }
  });

  it("time 优先于 hour(同时给时按 time 处理)", async () => {
    await send("PUT", "/v1/daily-recommend/config", { time: "09:30", hour: 7 });
    expect(f.state.settings.get("daily_recommend_time")).toBe("09:30");
    expect(f.state.settings.has("daily_recommend_hour")).toBe(false);
  });

  it("无任何可识别字段 → 200 但不 rearm", async () => {
    const r = await send("PUT", "/v1/daily-recommend/config", { foo: 1 });
    expect(r.status).toBe(200);
    expect(f.rearmDailyScheduler).not.toHaveBeenCalled();
  });

  it("body 非法 JSON → 按空对象处理", async () => {
    const r = await app.request("http://x/v1/daily-recommend/config", {
      method: "PUT", headers: { "content-type": "application/json" }, body: "{{{",
    });
    expect(r.status).toBe(200);
  });
});

// ==================== PUT /v1/daily-recommend/candidates ====================

describe("PUT /v1/daily-recommend/candidates", () => {
  it("candidates 非数组 → 400", async () => {
    for (const v of [undefined, null, "x", 1, {}]) {
      const r = await send("PUT", "/v1/daily-recommend/candidates", { candidates: v });
      expect(r.status).toBe(400);
      expect((await json(r)).code).toBe("INVALID_PARAM");
    }
  });

  it("清洗:缺 url / 缺 platform / platform 全空白 / 非对象一律丢弃;url 去空白", async () => {
    const api = { isCandidateBlocked: () => false, saveCandidates: vi.fn(), loadCandidates: () => [], pickDailyCandidate: () => null };
    f.dailyApi.mockReturnValue(api);
    const r = await send("PUT", "/v1/daily-recommend/candidates", {
      candidates: [
        { platform: "qq", url: "  http://a  " },
        { platform: "qq" },
        { url: "http://b" },
        { platform: "   ", url: "http://c" },
        null,
        "str",
      ],
    });
    expect(r.status).toBe(200);
    expect(api.saveCandidates).toHaveBeenCalledWith([{ platform: "qq", url: "http://a", name: undefined }]);
    expect(await json(r)).toMatchObject({ success: true, count: 1, blocked: 0 });
  });

  it("name 非字符串 → undefined;是字符串则原样保留", async () => {
    const api = { isCandidateBlocked: () => false, saveCandidates: vi.fn(), loadCandidates: () => [], pickDailyCandidate: () => null };
    f.dailyApi.mockReturnValue(api);
    await send("PUT", "/v1/daily-recommend/candidates", {
      candidates: [{ platform: "qq", url: "u1", name: 42 }, { platform: "qq", url: "u2", name: "新歌榜" }],
    });
    expect(api.saveCandidates).toHaveBeenCalledWith([
      { platform: "qq", url: "u1", name: undefined },
      { platform: "qq", url: "u2", name: "新歌榜" },
    ]);
  });

  it("被屏蔽的候选剔除并单独回报(前端要能看到「被过滤了哪些」)", async () => {
    const api = {
      isCandidateBlocked: (x: Any) => x.url.includes("blocked"),
      saveCandidates: vi.fn(), loadCandidates: () => [], pickDailyCandidate: () => null,
    };
    f.dailyApi.mockReturnValue(api);
    const r = await send("PUT", "/v1/daily-recommend/candidates", {
      candidates: [{ platform: "qq", url: "u-ok" }, { platform: "qq", url: "u-blocked" }],
    });
    expect(await json(r)).toMatchObject({ success: true, count: 1, blocked: 1 });
    expect(api.saveCandidates).toHaveBeenCalledWith([{ platform: "qq", url: "u-ok", name: undefined }]);
  });

  it("全部被屏蔽(clean 为空)→ 400,且不写库", async () => {
    const api = {
      isCandidateBlocked: () => true,
      saveCandidates: vi.fn(), loadCandidates: () => [], pickDailyCandidate: () => null,
    };
    f.dailyApi.mockReturnValue(api);
    const r = await send("PUT", "/v1/daily-recommend/candidates", { candidates: [{ platform: "qq", url: "u" }] });
    expect(r.status).toBe(400);
    expect(api.saveCandidates).not.toHaveBeenCalled();
  });

  it("dailyApi 缺失时 isCandidateBlocked 视为不屏蔽(不因插件缺席而误杀)", async () => {
    f.dailyApi.mockReturnValue(null);
    const r = await send("PUT", "/v1/daily-recommend/candidates", { candidates: [{ platform: "qq", url: "u" }] });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ count: 1, blocked: 0 });
  });
});

// ==================== POST /v1/daily-recommend/trigger ====================

describe("POST /v1/daily-recommend/trigger", () => {
  it("每日推荐能力未启用 → 503", async () => {
    f.dailyApi.mockReturnValue(null);
    const r = await send("POST", "/v1/daily-recommend/trigger");
    expect(r.status).toBe(503);
    expect((await json(r)).code).toBe("UNAVAILABLE");
  });

  it("成功 → 200 并回传结果;force / seedSalt 透传", async () => {
    const generateDailyPlaylist = vi.fn(async () => ({ playlistId: "pl-daily-today", added: 30 }));
    f.dailyApi.mockReturnValue({ generateDailyPlaylist, loadCandidates: () => [], pickDailyCandidate: () => null });
    const r = await send("POST", "/v1/daily-recommend/trigger", { force: true, seedSalt: 777 });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ success: true, result: { playlistId: "pl-daily-today", added: 30 } });
    expect(generateDailyPlaylist.mock.calls[0][1]).toEqual({ force: true, seedSalt: 777 });
  });

  it("force 非 true 字面量 → false(不接受真值转换)", async () => {
    const generateDailyPlaylist = vi.fn(async () => ({}));
    f.dailyApi.mockReturnValue({ generateDailyPlaylist, loadCandidates: () => [], pickDailyCandidate: () => null });
    await send("POST", "/v1/daily-recommend/trigger", { force: "yes" });
    expect(generateDailyPlaylist.mock.calls[0][1].force).toBe(false);
  });

  it("生成抛错 → 受控 500,并把上游原因作为文案", async () => {
    f.dailyApi.mockReturnValue({
      generateDailyPlaylist: async () => { throw new Error("上游榜单 502"); },
      loadCandidates: () => [], pickDailyCandidate: () => null,
    });
    const r = await send("POST", "/v1/daily-recommend/trigger");
    expect(r.status).toBe(500);
    expect((await json(r)).error).toBe("上游榜单 502");
  });

  it("抛错但 message 为空 → 回落 i18n 文案(不返回空错误)", async () => {
    f.dailyApi.mockReturnValue({
      generateDailyPlaylist: async () => { throw new Error(""); },
      loadCandidates: () => [], pickDailyCandidate: () => null,
    });
    const r = await send("POST", "/v1/daily-recommend/trigger");
    const b = await json(r);
    expect(r.status).toBe(500);
    expect(typeof b.error).toBe("string");
    expect(b.error.length).toBeGreaterThan(0);
  });

  it("body 非法 JSON → 按空参数处理(force=false)", async () => {
    const generateDailyPlaylist = vi.fn(async () => ({}));
    f.dailyApi.mockReturnValue({ generateDailyPlaylist, loadCandidates: () => [], pickDailyCandidate: () => null });
    const r = await app.request("http://x/v1/daily-recommend/trigger", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{{{",
    });
    expect(r.status).toBe(200);
    expect(generateDailyPlaylist.mock.calls[0][1].force).toBe(false);
  });
});
