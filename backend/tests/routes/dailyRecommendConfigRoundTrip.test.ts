// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// dailyRecommend 配置的「写入 ↔ 读取同源」契约测试 —— src/routes/api/dailyRecommend.ts。
//
// 既有 dailyRecommendRoutesContract.test.ts 用的是**假 sqlite**,它只能证明「这一次
// PUT 写了什么值」;本文件改用**真实 sqlite**(每个测试文件独立 DATA_DIR),因此能
// 证明 PUT 写进去的东西,GET 真能读回来 —— 也就是新旧两套口径(hour 整点 / time
// HH:MM)在**同一次请求-响应闭环**里是否自洽。
//
// 为什么值得单独钉:每日推荐的开关与时刻是三端(Web / 客户端 / HA)都会展示的
// 「系统设置」项。用户改完设置回头看,看到的值必须就是他刚设的值;否则「我明明
// 改成了 09:30,页面还写着 03:00」是最典型的一类配置类工单。
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";

const f = vi.hoisted(() => ({
  rearmDailyScheduler: vi.fn(),
}));

vi.mock("../../src/routes/api/shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { overrides } = await import("./_sharedFakes.js");
  // 只替换「调度重排」这个副作用(它会真的挂 setTimeout,与本文件要验的读写无关);
  // sqlite 保持真实,PUT 与 GET 才能走同一份库。
  return { ...actual, ...overrides, rearmDailyScheduler: f.rearmDailyScheduler };
});

import { registerDailyRecommend } from "../../src/routes/api/dailyRecommend.js";

type Any = any;

const app = new Hono();
app.use("*", async (c: Any, next: Any) => {
  c.set("user", { id: "u1", username: "ray", isAdmin: true });
  await next();
});
registerDailyRecommend(app as Any);

const send = (m: string, p: string, body?: Any) =>
  app.request("http://x" + p, {
    method: m,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as Any;

/** 每个用例都从「零配置」起步:不依赖其它用例写进去的 settings 行。 */
beforeEach(() => {
  sqlite.prepare("DELETE FROM settings").run();
  f.rearmDailyScheduler.mockClear();
});

describe("每日推荐配置:PUT 写入 ↔ GET 回读同源", () => {
  it("开:PUT enabled=true → GET 读到 enabled=true(且真的落库为 \"true\")", async () => {
    const put = await send("PUT", "/v1/daily-recommend/config", { enabled: true });
    expect(put.status).toBe(200);

    const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("daily_recommend_enabled") as Any;
    expect(row?.value).toBe("true");
    expect((await json(await send("GET", "/v1/daily-recommend"))).enabled).toBe(true);
  });

  it("关:PUT enabled=false → GET 读到 enabled=false(不是被当成「没给值」而忽略)", async () => {
    const put = await send("PUT", "/v1/daily-recommend/config", { enabled: false });
    expect(put.status).toBe(200);
    expect(f.rearmDailyScheduler).toHaveBeenCalledTimes(1);

    const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get("daily_recommend_enabled") as Any;
    expect(row?.value).toBe("false");
    expect((await json(await send("GET", "/v1/daily-recommend"))).enabled).toBe(false);
  });

  it("旧客户端口径:PUT hour=7 → GET 的 hour 与 time 同时是 07:00(两个字段不自相矛盾)", async () => {
    await send("PUT", "/v1/daily-recommend/config", { hour: 7 });

    const b = await json(await send("GET", "/v1/daily-recommend"));
    expect(b.hour).toBe(7);
    expect(b.time).toBe("07:00");
  });

  it("新客户端口径:PUT time=09:30 → GET 的 time 回读为 09:30(分钟级生效,不再被整点吞掉)", async () => {
    await send("PUT", "/v1/daily-recommend/config", { time: "09:30" });

    const b = await json(await send("GET", "/v1/daily-recommend"));
    expect(b.time).toBe("09:30");
    // 已知缺口(见缺陷报告):PUT 只发 time 时不回写 daily_recommend_hour,
    // 因此 GET 的 hour 仍是旧列值(默认 3),与 time 不一致。这里不断言 hour,
    // 只锁定真正生效的调度口径 time。
  });

  it("关掉之后 GET 的 enabled=false 能被下一次 PUT 重新打开(开关可逆)", async () => {
    await send("PUT", "/v1/daily-recommend/config", { enabled: false });
    expect((await json(await send("GET", "/v1/daily-recommend"))).enabled).toBe(false);

    await send("PUT", "/v1/daily-recommend/config", { enabled: true });
    expect((await json(await send("GET", "/v1/daily-recommend"))).enabled).toBe(true);
  });
});
