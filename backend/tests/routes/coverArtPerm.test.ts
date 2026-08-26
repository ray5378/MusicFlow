// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import md5 from "md5";
import { db, initDatabase, encryptPassword } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../../src/middleware/auth.js";
import { restRoutes } from "../../src/routes/rest/index.js";
import { PERM, setUserPermission } from "../../src/services/access.js";

// 封面回归:getCoverArt 经 <img> 标签加载,请求带不上鉴权头,
// 因此 /rest/* 刻意放行它(不跑 authMiddleware),路由也不做权限门禁——
// 匿名必须能取图(占位图),否则所有封面 401 不显示。
// (复刻 index.ts 的 /rest/* 中间件编排,含 getCoverArt 匿名放行分支。)
const app = new Hono();
app.use("/rest/*", async (c, next) => {
  const p = c.req.path;
  if (p === "/getCoverArt" || p.endsWith("/getCoverArt")) return next();
  return authMiddleware(c, next);
});
app.route("/rest", restRoutes);

const PW = { root: "rootpass", dave: "davepass" };
const SALT = "clientsalt123";
const authQS = (u: string) => "u=" + u + "&t=" + md5(PW[u] + SALT) + "&s=" + SALT;
const U = { root: "u-root", dave: "u-dave" };

function seedUser(id: string, username: string, isAdmin: number) {
  if (db.select().from(users).where(eq(users.username, username)).get()) return;
  db.insert(users).values({
    id, username, password: "", salt: "salt", subsonicSalt: "subsalt",
    passEnc: encryptPassword(PW[username]), isAdmin, isActive: 1, email: username + "@x.y",
  }).run();
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
  seedUser(U.root, "root", 1);
  seedUser(U.dave, "dave", 0);
});

describe("getCoverArt 匿名放行(封面 <img> 不 401)", () => {
  it("匿名 <img> 请求不被 401,返回占位封面(200 image)", async () => {
    const res = await app.request("/rest/getCoverArt?id=al-no-such-album&size=300");
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") || "").toLowerCase()).toContain("image/");
  });

  it("携带鉴权的请求同样可取图", async () => {
    const res = await app.request("/rest/getCoverArt?id=al-no-such-album&size=300&" + authQS("dave"));
    expect(res.status).toBe(200);
  });

  it("管理员撤销 cover.view 也不影响 <img> 取图(封面公开,权限在 UI 层控制)", async () => {
    setUserPermission(U.dave, PERM.COVER_VIEW, false);
    const res = await app.request("/rest/getCoverArt?id=al-no-such-album&size=300&" + authQS("dave"));
    expect(res.status).toBe(200);
    setUserPermission(U.dave, PERM.COVER_VIEW, true);
  });

  it("其余 /rest/* 端点(如 getAlbumList)仍要求鉴权", async () => {
    const res = await app.request("/rest/getAlbumList?type=newest");
    expect(res.status).toBe(401);
  });
});
