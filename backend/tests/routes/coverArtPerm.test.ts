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

// 封面回归(方案B):OpenSubsonic 规范要求 getCoverArt 鉴权,前端封面 <img> 用
// URL ?token= 携带凭据(与 /rest/stream 一致)。因此:
//  - 匿名无凭据 → 401
//  - 带鉴权 + 默认 cover.view → 200
//  - 撤销 cover.view → 403
// (复刻 index.ts 的 /rest/* 中间件:仅放行 dlna/stream,其余走 authMiddleware。)
const app = new Hono();
app.use("/rest/*", async (c, next) => {
  const p = c.req.path;
  if (p.includes("/dlna/stream/")) return next();
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

describe("getCoverArt 需鉴权(方案 B)+ COVER_VIEW 门禁", () => {
  it("无凭据匿名 <img> 请求被拒绝(401)", async () => {
    const res = await app.request("/rest/getCoverArt?id=al-no-such-album&size=300");
    expect(res.status).toBe(401);
  });

  it("带鉴权且保留 cover.view(默认授权)可正常取图", async () => {
    const res = await app.request("/rest/getCoverArt?id=al-no-such-album&size=300&" + authQS("dave"));
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") || "").toLowerCase()).toContain("image/");
  });

  it("管理员撤销 cover.view 后,该用户取封面被 403 拦截", async () => {
    setUserPermission(U.dave, PERM.COVER_VIEW, false);
    const res = await app.request("/rest/getCoverArt?id=al-no-such-album&size=300&" + authQS("dave"));
    expect(res.status).toBe(403);
    setUserPermission(U.dave, PERM.COVER_VIEW, true);
  });

  it("管理员始终可取图(不受 COVER_VIEW 限制)", async () => {
    const res = await app.request("/rest/getCoverArt?id=al-no-such-album&size=300&" + authQS("root"));
    expect(res.status).toBe(200);
  });

  it("其余 /rest/* 端点(如 getAlbumList)同样要求鉴权", async () => {
    const res = await app.request("/rest/getAlbumList?type=newest");
    expect(res.status).toBe(401);
  });
});
