// MUST be the first import:隔离 DATA_DIR 后再加载后端模块。
import "../plugins/_env.js";

// `routes/api/online.ts` 未匹配条目统计口的**兜底 catch**(262-263)补测。
//
// 这一行的语义:查询歌单未匹配条目时,若 DB 层抛错,必须收成 502 + UPSTREAM_ERROR
// (带 code),而不是 500 裸抛 —— 契约一致性。要真实触发只能让查询本身失败,
// 故本用例短暂 DROP 掉 playlist_songs 表,断言完立即用 initDatabase() 重建 schema。
// 每个测试文件有独立 SQLite 库,这一破坏性操作不会外溢到其它文件。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../../src/middleware/auth.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  permMiddleware: () => async (_c: any, next: any) => { await next(); },
  adminMiddleware: async (_c: any, next: any) => { await next(); },
}));

import { onlineRoutes } from "../../src/routes/api/online.js";
import { db, sqlite, initDatabase } from "../../src/db/index.js";

const app = new Hono();
app.route("/", onlineRoutes);

async function get(path: string) {
  const res = await app.request(path, { method: "GET" });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  // 保险:无论断言如何结束,都要把表还原,避免同文件后续用例受影响。
  try { initDatabase(); } catch { /* ignore */ }
});

describe("GET /v1/online/:providerId/unmatched 的兜底", () => {
  it("DB 层抛错 → 502 + UPSTREAM_ERROR(带 code,不裸抛 500)", async () => {
    sqlite.exec("DROP TABLE IF EXISTS playlist_songs");
    try {
      const r = await get("/v1/online/gmd/unmatched?playlistId=pl-1");
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ success: false, code: "UPSTREAM_ERROR" });
    } finally {
      initDatabase(); // 重建 playlist_songs(DDL 幂等)
    }
  });

  it("表还原后:正常查询返回 count/entries 结构", async () => {
    const r = await get("/v1/online/gmd/unmatched?playlistId=pl-none");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, count: 0 });
    expect(Array.isArray(r.body.entries)).toBe(true);
  });
});
