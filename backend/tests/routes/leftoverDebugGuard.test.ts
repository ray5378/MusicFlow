// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import md5 from "md5";
import { eq } from "drizzle-orm";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { registerSources } from "../../src/routes/api/sources.js";

const app = new Hono();
app.use("/rest/api/*", authMiddleware);
const api = new Hono();
registerSources(api);
app.route("/rest/api", api);

const PLAIN = "hunter2";
const SALT = "clientsalt123";
const authQS = () => `u=alice&t=${md5(PLAIN + SALT)}&s=${SALT}`;
async function call(method: string, p: string, body?: any) {
  const res = await app.request(`/rest/api${p}${p.includes("?") ? "&" : "?"}${authQS()}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

/** 收集 console 的全部输出(四个级别都截住,免得漏掉 debug 行)。 */
function captureConsole() {
  const echoed: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      echoed.push(a.map(String).join(" "));
    }),
  );
  return { echoed, restore: () => spies.forEach((s) => s.mockRestore()) };
}

const LEAK_URL = "http://127.0.0.1:1/dav"; // 端口 1 必然拒连,探测快速失败

async function createWebdavSource(config: Record<string, unknown>) {
  const r = await call("POST", "/v1/sources", { name: "凭据不落日志", type: "webdav", config });
  expect(r.status).toBe(200);
  expect(typeof r.body.id).toBe("string");
  return r.body.id as string;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "alice")).get()) {
    db.insert(users).values({
      id: "u1", username: "alice", password: "", salt: "s",
      subsonicSalt: SALT, passEnc: encryptPassword(PLAIN), isAdmin: 1, isActive: 1,
    }).run();
  }
});

/**
 * D12 —— 遗留调试代码。
 *
 * logger.ts 头部写着本项目自己的约定:「新代码一律用本模块,不再裸 console.log」。
 * 仍有 4 处遗留调试代码违反它,且都落在**每次都会走到**的路径上:
 *   - POST /v1/sources/:id/test  3 处 console.log("[TEST] …"):把媒体源的
 *     url / root_path / **username** 以及探测结果无条件打到 stdout;
 *   - PlayerController.evaluate() 1 处 console.log("[…][evaluateDBG] …"):双层去抖
 *     每次转发都会打。
 * console.* 直接输出**绕过 LOG_LEVEL**(默认 info),所以生产环境既关不掉这些噪音,
 * 也没法通过「设置 → 日志等级」按需打开 —— 一个本可以分级的信息,被写成了不可控输出。
 */
describe("D12 遗留调试代码", () => {
  it("源码守卫:src 下不得残留 [TEST] / DBG 调试标记", () => {
    const srcDir = path.resolve(process.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "node_modules") continue;
          walk(p);
        } else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts")) {
          files.push(p);
        }
      }
    };
    walk(srcDir);
    // 防扫描器空跑:src 下有效 ts 文件远超 100 个
    expect(files.length).toBeGreaterThan(100);

    const hits: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.includes("[TEST]") || line.includes("DBG")) {
          hits.push(`${path.relative(srcDir, f)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("默认级别:连接测试失败不打印用户名/密码,但失败原因仍回给调用方", async () => {
    const cap = captureConsole();
    try {
      const id = await createWebdavSource({
        url: LEAK_URL,
        username: "leaked-user",
        password: "leaked-pass",
        root_path: "/x",
      });
      const r = await call("POST", `/v1/sources/${id}/test`);

      const all = cap.echoed.join("\n");
      expect(all).not.toContain("leaked-user");
      expect(all).not.toContain("leaked-pass");

      // 修复不得以牺牲功能为代价:探测结论仍照常返回
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(false);
      expect(typeof r.body.error).toBe("string");
      expect(r.body.error.length).toBeGreaterThan(0);
    } finally {
      cap.restore();
    }
  });

  it("切到 debug 级别后探测目标重新可见:观测能力只是移到了 debug,没被删掉", async () => {
    const cap = captureConsole();
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    try {
      const id = await createWebdavSource({ url: LEAK_URL, root_path: "/dbg" });
      await call("POST", `/v1/sources/${id}/test`);

      const all = cap.echoed.join("\n");
      expect(all).toContain("127.0.0.1:1");
      expect(all).toContain("rootPath=/dbg");
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
      cap.restore();
    }
  });
});
