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
import { runWithLocale, translate } from "../../src/i18n.js";

const app = new Hono();
app.use("*", async (c, next) => {
  const { parseLocale } = await import("../../src/i18n.js");
  return runWithLocale(parseLocale(c.req.header("x-mf-lang") ?? c.req.header("accept-language")), () => next());
});
app.use("/rest/api/*", authMiddleware);
app.route("/rest/api", apiRoutes);

const A_PLAIN = "hunter2";
const A_SALT = "clientsalt123";
const aliceQS = () => "u=alice&t=" + md5(A_PLAIN + A_SALT) + "&s=" + A_SALT;

async function call(method: string, p: string, opts: { body?: any } = {}) {
  const res = await app.request("/rest/api" + p + "?" + aliceQS(), {
    method,
    headers: { "content-type": "application/json", "X-MF-Client-Id": "ls1" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

beforeAll(() => {
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
 * D9 —— i18n catalog 完整性。
 *
 * `translate(key)` 的契约是「命中 catalog → 渲染；未命中 → **原样返回 key**」。
 * 也就是说,只要有一个 key 漏进 catalog,用户界面上就会出现一串 `errors.xxx`。
 * 修复前 `errors.sendspin.*` 的 **11 个 key 全部缺失**(catalog 里 0 条),
 * 而 `sendspin.ts` 有 29 处在用它们 —— 配对/拨号相关报错文案 100% 是裸 key。
 *
 * 前端 `utils/apiError.ts` 里那句「带 errors. 前缀的裸 key 一律回退到调用方文案」
 * 正是被这类漏配逼出来的兜底;有了本文件的守卫,才谈得上把它当兜底而非常态。
 */

const SENDSPIN_KEYS = [
  "errors.sendspin.needsClientId",
  "errors.sendspin.notEnabled",
  "errors.sendspin.badFormat",
  "errors.sendspin.pairStartFailed",
  "errors.sendspin.needsClientIdAndCode",
  "errors.sendspin.codeFailed",
  "errors.sendspin.needsClientIdAndToken",
  "errors.sendspin.tokenFailed",
  "errors.sendspin.badDialTarget",
  "errors.sendspin.dialFailed",
  "errors.sendspin.noSuchTarget",
];

function srcDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "src"),
    path.resolve(process.cwd(), "backend", "src"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("src not found from cwd=" + process.cwd());
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("D9 i18n catalog 完整性", () => {
  it("src 下所有 errors.* 字面量在两个 locale 都能解析(不是裸 key)", () => {
    const root = srcDir();
    const found = new Map<string, string>();
    for (const f of walk(root)) {
      const txt = fs.readFileSync(f, "utf8");
      for (const m of txt.matchAll(/"(errors\.[A-Za-z0-9_.]+)"/g)) {
        if (!found.has(m[1])) found.set(m[1], path.relative(root, f));
      }
    }
    // 防止扫描器本身失效导致空跑
    expect(found.size).toBeGreaterThan(100);

    const unresolvable: string[] = [];
    for (const locale of ["zh-CN", "en-US"] as const) {
      for (const [key, file] of found) {
        const out = runWithLocale(locale, () => translate(key));
        if (out === key) unresolvable.push(`${locale} ${key}  (${file})`);
      }
    }
    expect(unresolvable).toEqual([]);
  });

  it("errors.sendspin.* 11 个 key 全部有中文/英文文案(修复前 catalog 里 0 条)", () => {
    for (const key of SENDSPIN_KEYS) {
      const zh = runWithLocale("zh-CN", () => translate(key));
      const en = runWithLocale("en-US", () => translate(key));
      expect(zh, key).not.toBe(key);
      expect(en, key).not.toBe(key);
      expect(zh, key + " zh").not.toBe(en);
      expect(zh).not.toContain("errors.");
      expect(en).not.toContain("errors.");
    }
  });

  it("sendspin 未启用时的报错是已翻译文案,而不是 errors.sendspin.notEnabled", async () => {
    const r = await call("POST", "/v1/sendspin/pairing/start", { body: { clientId: "c1" } });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ success: false, code: "NOT_FOUND" });
    expect(r.body.error).toBe("Sendspin 未启用或配对功能不可用");
    expect(r.body.error).not.toContain("errors.");
  });
});
