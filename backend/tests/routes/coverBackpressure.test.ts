// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { restRoutes } from "../../src/routes/rest/index.js";
import { getDataDir } from "../../src/utils/env.js";
import { RENDER_CONCURRENCY } from "../../src/services/coverImage.js";

// 端到端背压(ADR-4):/rest/getCoverArt 在响应头回传封面渲染并发上限(供调用方
// 对齐自身并发),并在渲染管线饱和时附 Retry-After。此处验证「成功取图」这条路径
// 确实带上了压力头;饱和分支由 services 侧的纯函数用例确定性覆盖,避免依赖真实
// 渲染时序。
//
// 复刻 index.ts 的 /rest/* 中间件:仅放行 dlna/stream,其余走 authMiddleware。
const app = new Hono();
app.use("/rest/*", async (c, next) => {
  const p = c.req.path;
  if (p.includes("/dlna/stream/")) return next();
  return authMiddleware(c, next);
});
app.route("/rest", restRoutes);

const PW = { root: "rootpass" };
const SALT = "clientsalt123";
const authQS = () => "u=root&t=" + md5(PW.root + SALT) + "&s=" + SALT;

beforeAll(async () => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  if (!db.select().from(users).where(eq(users.username, "root")).get()) {
    db.insert(users).values({
      id: "u-root-bp",
      username: "root",
      password: "",
      salt: "salt",
      subsonicSalt: "subsalt",
      passEnc: encryptPassword(PW.root),
      isAdmin: 1,
      isActive: 1,
      email: "root@x.y",
    }).run();
  }
  // 造一张真实封面文件,让 getCoverArt 走到「解析到文件 → 渲染 → 回图」分支
  // (裸 id 经 resolveCoverFile 在 data/covers 下查找)。
  const dir = path.join(getDataDir(), "covers");
  fs.mkdirSync(dir, { recursive: true });
  const buf = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 12, g: 34, b: 56 } },
  })
    .jpeg()
    .toBuffer();
  fs.writeFileSync(path.join(dir, "bp-cover.jpg"), buf);
});

describe("getCoverArt 端到端背压:响应头回传渲染并发上限", () => {
  it("成功取图:回传 X-MusicFlow-Cover-Concurrency,未饱和时不给 Retry-After", async () => {
    const res = await app.request(
      `/rest/getCoverArt?id=bp-cover.jpg&size=64&${authQS()}`,
    );
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") || "").toLowerCase()).toContain("image/");
    expect(res.headers.get("x-musicflow-cover-concurrency")).toBe(
      String(RENDER_CONCURRENCY),
    );
    // 单次串行请求:渲染已结束,不应处于饱和态。
    expect(res.headers.get("retry-after")).toBeNull();
  });
});