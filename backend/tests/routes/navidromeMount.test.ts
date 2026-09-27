// navidrome 兼容挂载层:把 apiRoutes 再挂到 "/"(整体由 index.ts 挂到 /api)。
// 这层只有 4 行,但它是「/api/* 老客户端路径仍可用」的唯一保证 —— 一旦有人在拆分后
// 误删这一行,所有 Navidrome 兼容调用方静默 404,而类型检查与其它测试都不会发现。
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { navidromeRoutes } from "../../src/routes/navidrome/index.js";
import { apiRoutes } from "../../src/routes/api/index.js";

describe("navidrome 兼容挂载层", () => {
  it("导出的是 Hono 实例,且注册表非空(apiRoutes 已挂上)", () => {
    expect(navidromeRoutes).toBeInstanceOf(Hono);
    expect(navidromeRoutes.routes.length).toBeGreaterThan(0);
  });

  it("未知路径 404 而非抛错(装配层不吞请求)", async () => {
    const res = await navidromeRoutes.request("/definitely/not/a/route");
    expect(res.status).toBe(404);
  });

  it("与 apiRoutes 同源:同一路径状态码一致(挂载未改变行为)", async () => {
    const viaNavidrome = await navidromeRoutes.request("/v1/no-such-endpoint");
    const viaApi = await apiRoutes.request("/v1/no-such-endpoint");
    expect(viaNavidrome.status).toBe(viaApi.status);
    expect(viaNavidrome.status).toBe(404);
  });

  it("POST 到未知路径同样 404(方法不在路由表也不崩)", async () => {
    const res = await navidromeRoutes.request("/v1/no-such-endpoint", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
