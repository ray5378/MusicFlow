import { Hono } from "hono";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { generateToken, md5Hash } from "../../utils/auth.js";
import { encryptPassword } from "../../db/index.js";
import { v4 as uuidv4 } from "uuid";
import { getUserPermissions, getUserRendererGrants } from "../../services/access.js";

export const authRoutes = new Hono();

// 登录响应的权限载荷:功能权限有效值 + 播放器授权列表(管理员恒全量授权,
// 前端据此渲染菜单 / 校验播放器可见性)。管理员返回 permission:true 语义。
function loginPayload(user: any, token: string) {
  const isAdmin = !!user.isAdmin;
  const permissions = isAdmin ? { admin: true } : getUserPermissions(user.id);
  const rendererGrants = isAdmin ? null : [...getUserRendererGrants(user.id)].sort();
  return {
    id: user.id,
    username: user.username,
    isAdmin,
    permissions,
    rendererGrants,
    subsonicSalt: user.subsonicSalt,
    subsonicToken: md5Hash(user.password + user.subsonicSalt),
    mustChangePassword: !!user.mustChangePassword,
    token,
  };
}

authRoutes.post("/api/v1/auth/login", async (c) => {
  const body = await c.req.json();
  const { username, password } = body;
  if (!username || !password) return c.json({ error: "Username and password required" }, 400);

  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user) return c.json({ error: "Invalid credentials" }, 401);
  if (!user.isActive) return c.json({ error: "Account disabled" }, 403);

  const passwordHash = md5Hash(password + user.subsonicSalt);
  if (passwordHash !== user.password) return c.json({ error: "Invalid credentials" }, 401);

  // Always re-encrypt pass_enc with the current key so that rotating
  // JWT_SECRET (which derives the AES key) self-heals on next login.
  db.update(users).set({ passEnc: encryptPassword(password), updatedAt: new Date().toISOString() }).where(eq(users.id, user.id)).run();

  const token = generateToken(user.id, user.username, !!user.isAdmin);
  return c.json(loginPayload(user, token));
});

authRoutes.post("/auth/login", async (c) => {
  const body = await c.req.json();
  const { username, password } = body;
  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user || !user.isActive) return c.json({ error: "Invalid credentials" }, 401);
  const passwordHash = md5Hash(password + user.subsonicSalt);
  if (passwordHash !== user.password) return c.json({ error: "Invalid credentials" }, 401);
  db.update(users).set({ passEnc: encryptPassword(password), updatedAt: new Date().toISOString() }).where(eq(users.id, user.id)).run();
  const token = generateToken(user.id, user.username, !!user.isAdmin);
  return c.json(loginPayload(user, token));
});
