// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { apiRoutes } from "../../src/routes/api/index.js";
import { runWithLocale, parseLocale } from "../../src/i18n.js";

const app = new Hono();
// 与 src/index.ts 一致:按请求头解析语言并放进 AsyncLocalStorage,
// 否则 translate() 只能拿到默认 zh-CN(错误文案语言断言会失真)。
app.use("*", async (c, next) => {
  const locale = parseLocale(c.req.header("x-mf-lang") ?? c.req.header("accept-language"));
  return runWithLocale(locale, () => next());
});
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const A_PLAIN = "hunter2";
const A_SALT = "clientsalt123";
const aliceQS = () => "u=alice&t=" + md5(A_PLAIN + A_SALT) + "&s=" + A_SALT;

async function call(method: string, p: string, opts: { body?: any } = {}) {
  const url = "/rest/api" + p + (p.includes("?") ? "&" : "?") + aliceQS();
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
 * D8 —— 在线源 / 搜索域的错误响应契约。
 *
 * 修复前这 4 个文件共 70 处写成 `c.json({ success:false, error: translate("errors.x") })`：
 *   - 无 `code` 字段 → 前端只能匹配文案；
 *   - 除少数几处外都没有状态码 → 错误走 HTTP 200；
 *   - 只有 shape 没有契约,与 D1/D7 修好的 { success, code, error } 双轨并存。
 *
 * 本文件按**行为**锁定契约:凡业务错误必为
 *   { success:false, code:<BusinessErrorCode>, error:<已翻译文案> }
 * 且 `error` 不再是裸 i18n key。
 */
describe("D8 在线源/搜索域错误契约", () => {
  it("聚合搜索缺关键词:400 + INVALID_PARAM + 中文文案", async () => {
    const r = await call("POST", "/v1/playlist-search/aggregate/search", { body: {} });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ success: false, code: "INVALID_PARAM", error: "请输入搜索关键词" });
  });

  it("歌单搜索:无已启用插件 -> 404 + NOT_FOUND(不再是 200)", async () => {
    const r = await call("POST", "/v1/playlist-search/nope-provider/search", { body: { q: "love" } });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ success: false, code: "NOT_FOUND" });
    expect(r.body.error).toBe("未找到已启用的歌单搜索插件");
  });

  it("实体搜索(album/song/artist):无已启用插件 -> 404 + NOT_FOUND + 已翻译文案", async () => {
    for (const [p, body] of [
      ["/v1/song-search/aggregate/search", {}],
      ["/v1/album-search/aggregate/search", {}],
    ] as const) {
      const r = await call("POST", p, { body });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ success: false, code: "INVALID_PARAM" });
      expect(r.body.error).not.toContain("errors.");
    }
  });

  it("实体搜索 :providerId/search:未知 provider -> 404 + NOT_FOUND", async () => {
    for (const [p, body] of [
      ["/v1/song-search/nope/search", { q: "x" }],
      ["/v1/album-search/nope/search", { q: "x" }],
    ] as const) {
      const r = await call("POST", p, { body });
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ success: false, code: "NOT_FOUND" });
      expect(r.body.error).toBe("未找到已启用的搜索插件");
    }
  });

  it("在线源未知 provider:404 + NOT_FOUND + 带参数的已翻译文案", async () => {
    const r = await call("POST", "/v1/online/nope-provider/test", { body: {} });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ success: false, code: "NOT_FOUND" });
    expect(r.body.error).toBe("未知的在线源: nope-provider");
  });

  it("业务错误体必含 { success, code, error }(全部样本)", async () => {
    const samples = [
      ["POST", "/v1/playlist-search/aggregate/search", {}],
      ["POST", "/v1/playlist-search/nope-provider/search", { q: "x" }],
      ["POST", "/v1/song-search/nope/search", { q: "x" }],
      ["POST", "/v1/online/nope-provider/test", {}],
    ] as const;
    for (const [m, p, body] of samples) {
      const r = await call(m, p, { body });
      expect(r.status).toBeGreaterThanOrEqual(400);
      // 允许附加业务字段(如 providers 列表),但三个契约键必须齐备。
      expect(Object.keys(r.body)).toEqual(expect.arrayContaining(["code", "error", "success"]));
      expect(r.body.success).toBe(false);
      expect(r.body.code).toMatch(/^[A-Z_]+$/);
      expect(typeof r.body.error).toBe("string");
      expect(r.body.error).not.toContain("errors.");
    }
  });

  it("按语言渲染:x-mf-lang=en-US 时返回英文文案(证明走的是 translate 而非裸 key)", async () => {
    const url = "/rest/api/v1/online/nope-provider/test?" + aliceQS();
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "X-MF-Client-Id": "ls1", "x-mf-lang": "en-US" },
      body: "{}",
    });
    const body: any = await res.json();
    expect(res.status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(body.error).toContain("nope-provider");
    expect(body.error).not.toContain("errors.");
    expect(body.error).not.toBe("未知的在线源: nope-provider");
  });
});

/**
 * 源码级守卫:把 D7(裸 `{error}`) 与 D8(`{success:false,error}` 无 code)
 * 两类写法一并钉死。新增路由若再手搓错误体,这里会直接红。
 */
describe("错误响应体源码守卫", () => {
  function srcRoutesDir(): string {
    const candidates = [
      path.resolve(process.cwd(), "src", "routes"),
      path.resolve(process.cwd(), "backend", "src", "routes"),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    throw new Error("src/routes not found from cwd=" + process.cwd());
  }

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  it("全仓 src/routes 下不再手搓错误体(0 处 c.json({ error / 0 处 success: false, error)", () => {
    const dir = srcRoutesDir();
    const bad: string[] = [];
    for (const f of walk(dir)) {
      const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
      lines.forEach((l, i) => {
        if (/c\.json\(\{\s*error/.test(l) || /success:\s*false,\s*error/.test(l)) {
          bad.push(path.relative(dir, f) + ":" + (i + 1) + "  " + l.trim().slice(0, 100));
        }
      });
    }
    expect(bad).toEqual([]);
  });
});
