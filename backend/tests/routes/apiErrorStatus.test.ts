/**
 * D1 验收:业务错误响应必须带上正确的 HTTP 状态码。
 *
 * 背景:apiError() 只构造响应体,c.json() 的第二参数必须显式给出;历史上
 * src/routes/api/{playlists,sources,library,stream}.ts 共 25 处漏传,导致
 * 错误响应返回 200。本文件同时锁定「错误码 -> 状态码」的映射与端到端行为。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";

import { initDatabase, db, encryptPassword } from "../../src/db/index.js";
import { users, mediaSources } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { registerSources } from "../../src/routes/api/sources.js";
import { registerStream } from "../../src/routes/api/stream.js";
import { BusinessErrorCode, apiErrorStatus, ERROR_STATUS } from "../../src/utils/errors.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
const api = new Hono();
registerSources(api);
registerStream(api);
app.route("/rest/api", api);

const PLAIN = "hunter2";
const SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + SALT)}&s=${SALT}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`/rest/api${path}${path.includes("?") ? "&" : "?"}${authQS()}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  db.insert(users).values({
    id: "u1", username: "alice", password: "", salt: "s", subsonicSalt: SALT,
    passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1,
  }).run();
  db.insert(mediaSources).values([
    { id: "src-on", name: "On", type: "local", enabled: 1, config: JSON.stringify({ path: "/" }) },
    { id: "src-off", name: "Off", type: "local", enabled: 0, config: "{}" },
  ]).run();
});

describe("业务错误码 -> HTTP 状态码映射", () => {
  it("7 个错误码各有明确状态码,且映射表与枚举一一对应", () => {
    expect(apiErrorStatus(BusinessErrorCode.INVALID_PARAM)).toBe(400);
    expect(apiErrorStatus(BusinessErrorCode.NOT_FOUND)).toBe(404);
    expect(apiErrorStatus(BusinessErrorCode.CONFLICT)).toBe(409);
    expect(apiErrorStatus(BusinessErrorCode.BUSY)).toBe(409);
    expect(apiErrorStatus(BusinessErrorCode.FORBIDDEN)).toBe(403);
    expect(apiErrorStatus(BusinessErrorCode.UPSTREAM_ERROR)).toBe(502);
    expect(apiErrorStatus(BusinessErrorCode.INTERNAL)).toBe(500);
    expect(Object.keys(ERROR_STATUS).sort()).toEqual(Object.keys(BusinessErrorCode).sort());
  });

  it("未知错误码回落 500 —— 绝不静默降级成 200", () => {
    expect(apiErrorStatus("NOT_A_REAL_CODE" as any)).toBe(500);
  });
});

describe("端到端:错误响应的状态码", () => {
  it("资源不存在 -> 404(此前是 200)", async () => {
    const test = await call("POST", "/v1/sources/nope/test", {});
    expect(test.status).toBe(404);
    expect(test.body).toMatchObject({ success: false, code: "NOT_FOUND" });

    const scan = await call("POST", "/v1/sources/nope/scan");
    expect(scan.status).toBe(404);
    expect(scan.body.code).toBe("NOT_FOUND");
  });

  it("状态冲突(源被禁用) -> 409(此前是 200)", async () => {
    const r = await call("POST", "/v1/sources/src-off/scan");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ success: false, code: "CONFLICT" });
  });

  it("入参缺失(probe 无有效 songIds) -> 400(此前是 200)", async () => {
    const empty = await call("POST", "/v1/stream/probe", {});
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("INVALID_PARAM");

    // 全是非字符串 -> 过滤后为空,同样 400
    const nonString = await call("POST", "/v1/stream/probe", { songIds: [1, 2, null] });
    expect(nonString.status).toBe(400);
  });

  it("响应体形状保持三字段(success/code/error),前端零改动", async () => {
    const r = await call("POST", "/v1/sources/nope/test", {});
    expect(Object.keys(r.body).sort()).toEqual(["code", "error", "success"]);
    expect(r.body.success).toBe(false);
    expect(typeof r.body.error).toBe("string");
    expect(r.body.error.length).toBeGreaterThan(0);
  });

  it("对照:成功响应仍是 200,不受本次修复影响", async () => {
    const r = await call("GET", "/v1/sources");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });
});
