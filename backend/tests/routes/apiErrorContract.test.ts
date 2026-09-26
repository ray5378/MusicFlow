// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, vi } from "vitest";

import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { apiInternalError, BusinessErrorCode } from "../../src/utils/errors.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const A_PLAIN = "hunter2";
const A_SALT = "clientsalt123";
const aliceQS = () => "u=alice&t=" + md5(A_PLAIN + A_SALT) + "&s=" + A_SALT;

async function call(method: string, path: string, opts: { body?: any } = {}) {
  const url = "/rest/api" + path + (path.includes("?") ? "&" : "?") + aliceQS();
  const res = await app.request(url, {
    method,
    headers: { "content-type": "application/json", "X-MF-Client-Id": "ls1" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({
      id: "u1", username: "alice", password: "", salt: "salt", subsonicSalt: "subsalt",
      passEnc: encryptPassword(A_PLAIN), isAdmin: 1, isActive: 1, email: "a@b.c",
    }).run();
  }
});

/**
 * D7 —— 统一错误契约。
 *
 * 契约(utils/errors.ts 头注释)定义业务错误体恒为
 *   { success: false, code: BusinessErrorCode, error: <按请求语言渲染的文案> }
 * 并明确「禁止裸造 { error } 而不带 code」。修复前有 51 处违反:
 * 43 处 catch 兜底只给 { error: e.message }(dlna 11 / peers 32),
 * 8 处字面量消息(playlists 5 / plugins 2 / sources 1),其中 playlists 三处传的还是 i18n key 原文 ——
 * 因为绕过 apiError(),translate() 从未被调用,前端直接把 key 显示给用户。
 */
describe("D7 统一错误契约", () => {
  it("apiInternalError:把未预期异常收编成 INTERNAL + 原文", () => {
    expect(apiInternalError(new Error("boom"))).toEqual({
      success: false, code: BusinessErrorCode.INTERNAL, error: "boom",
    });
    expect(apiInternalError("plain-string")).toMatchObject({ success: false, code: "INTERNAL", error: "plain-string" });
  });

  it("apiInternalError:异常无 message 时回落到已翻译的中文,而不是 i18n key", () => {
    const body = apiInternalError(null);
    expect(body.success).toBe(false);
    expect(body.code).toBe("INTERNAL");
    // 关键:errors.internal 必须在 catalog 里,否则前端会看到 "errors.internal" 这串 key
    expect(body.error).not.toContain("errors.");
    expect(body.error).toBe("服务器内部错误");
  });

  it("D11 生产环境:内部异常原文不返回客户端,回落通用文案、原文只进日志", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    try {
      const body = apiInternalError(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: songs.id"));
      expect(body).toEqual({ success: false, code: "INTERNAL", error: "服务器内部错误" });
      // 关键:SQL / 表名这类内部细节不得出现在响应体里
      expect(body.error).not.toContain("SQLITE");
      expect(body.error).not.toContain("songs.id");
      // 但原文必须仍能在服务端日志里找到,否则脱敏等于把排障线索一起丢了
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("UNIQUE constraint failed: songs.id");
      expect(logged).toContain("已脱敏");
    } finally {
      vi.unstubAllEnvs();
      spy.mockRestore();
    }
  });

  it("D11 默认(非 production)保留原文;MF_EXPOSE_ERROR_DETAIL 可双向显式覆盖", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 未设 NODE_ENV=production ⇒ 原文直出(开发/测试排障习惯不被破坏)
      expect(apiInternalError(new Error("boom")).error).toBe("boom");

      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MF_EXPOSE_ERROR_DETAIL", "1");
      expect(apiInternalError(new Error("boom")).error).toBe("boom"); // 显式打开

      vi.stubEnv("MF_EXPOSE_ERROR_DETAIL", "0");
      expect(apiInternalError(new Error("boom")).error).toBe("服务器内部错误"); // 显式关闭

      // 无法识别的取值不参与判定,交回 NODE_ENV —— production 下仍脱敏
      vi.unstubAllEnvs();
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MF_EXPOSE_ERROR_DETAIL", "yes");
      expect(apiInternalError(new Error("boom")).error).toBe("服务器内部错误");

      // …而 NODE_ENV 未设时,同一个取值下就是暴露(证明回落链确实是 env → NODE_ENV → 默认暴露)
      vi.unstubAllEnvs();
      vi.stubEnv("MF_EXPOSE_ERROR_DETAIL", "yes");
      expect(apiInternalError(new Error("boom")).error).toBe("boom");
    } finally {
      vi.unstubAllEnvs();
      spy.mockRestore();
    }
  });

  it("D11 端到端:生产模式下 catch 兜底也不再吐异常原文", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    try {
      const r = await call("POST", "/v1/peers/dlna:no-such-device/play");
      expect(r.status).toBe(500);
      expect(r.body).toMatchObject({ success: false, code: "INTERNAL", error: "服务器内部错误" });
    } finally {
      vi.unstubAllEnvs();
      spy.mockRestore();
    }
  });

  it("catch 兜底(dlna/peers):500 + INTERNAL + 原文,且带 success:false", async () => {
    // dlna:x 未注册 → playDevice 抛 "设备未找到" → 落到统一 catch
    const r = await call("POST", "/v1/peers/dlna:no-such-device/play");
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ success: false, code: "INTERNAL" });
    expect(typeof r.body.error).toBe("string");
    expect(r.body.error.length).toBeGreaterThan(0);
  });

  it("参数校验类仍是 400 + INVALID_PARAM(不回归)", async () => {
    const r = await call("POST", "/v1/peers/definitely-not-a-peer/play");
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ success: false, code: "INVALID_PARAM" });
  });

  it("歌单不存在:404 + NOT_FOUND + **中文文案**(不是 i18n key)", async () => {
    for (const [method, path] of [
      ["GET", "/v1/playlists/nope-id/tracks"],
      ["GET", "/v1/playlists/nope-id/export"],
      ["DELETE", "/playlist/nope-id"],
    ] as const) {
      const r = await call(method, path);
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ success: false, code: "NOT_FOUND" });
      expect(r.body.error).toBe("歌单不存在");
      expect(r.body.error).not.toContain("errors.");
    }
  });

  it("媒体源不存在:404 + NOT_FOUND + 中文文案", async () => {
    const r = await call("PUT", "/v1/sources/nope-id", { body: { name: "x" } });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ success: false, code: "NOT_FOUND" });
    expect(r.body.error).toBe("媒体源不存在");
  });

  it("全部业务错误体恰好是 { success, code, error } 三个键", async () => {
    const r = await call("PUT", "/v1/sources/nope-id", { body: { name: "x" } });
    expect(Object.keys(r.body).sort()).toEqual(["code", "error", "success"]);
  });
});
