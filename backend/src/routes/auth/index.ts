import { Hono } from "hono";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { generateToken, md5Hash } from "../../utils/auth.js";
import { encryptPassword } from "../../db/index.js";
import { v4 as uuidv4 } from "uuid";
import { getUserPermissions, getUserRendererGrants } from "../../services/access.js";

export const authRoutes = new Hono();

// 登录防爆破限流:连续失败 MAX_FAILS 次后,锁定 LOCK_MS 时长,期间拒绝所有登录尝试。
// 计数/锁定时间保存在进程内 Map —— 服务器重启即清零(符合运维预期),多实例各自独立。
// 按"具体账号"锁定,避免账号枚举的同时最大化命中爆破目标;仅内存实现最简洁,无 DB 写放大。
const MAX_FAILS = 5;
const LOCK_MS = 24 * 60 * 60 * 1000; // 连续失败 5 次,锁 24 小时

// username -> { failCount, lockedUntil(ms) }。用账号名作 key,与 DB 用户名强一致。
const loginAttempts = new Map<string, { failCount: number; lockedUntil: number }>();

/** 检查账号是否处于锁定期。
 *  @returns { ok: boolean; retryAfterSeconds?: number }
 */
function checkLocked(username: string): { ok: boolean; retryAfterSeconds?: number } {
  const entry = loginAttempts.get(username);
  if (!entry || !entry.lockedUntil || entry.lockedUntil <= Date.now()) return { ok: true };
  return { ok: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - Date.now()) / 1000) };
}

/** 记录一次登录失败;达到阈值时锁定账号。
 *  @returns { locked: boolean; retryAfterSeconds?: number }
 */
function recordLoginFailure(username: string): { locked: boolean; retryAfterSeconds?: number } {
  const cur = loginAttempts.get(username) || { failCount: 0, lockedUntil: 0 };
  const failCount = cur.failCount + 1;
  if (failCount >= MAX_FAILS) {
    loginAttempts.set(username, { failCount: 0, lockedUntil: Date.now() + LOCK_MS });
    return { locked: true, retryAfterSeconds: Math.ceil(LOCK_MS / 1000) };
  }
  loginAttempts.set(username, { failCount, lockedUntil: 0 });
  return { locked: false };
}

/** 登录成功后清零该账号的失败计数与锁定。 */
function resetLoginFails(username: string): void {
  loginAttempts.delete(username);
}

/** 统一登录入口:校验 + 防爆破 + 返回登录成功后的 payload 或错误响应。
 *  @returns { payload?: any } 成功时返回 payload;失败时返回值用于组装 4xx / 423。
 */
function handleLogin(c: any, username: string, password: string) {
  if (!username || !password) return { code: 400, body: { error: "Username and password required" } };
  const user = db.select().from(users).where(eq(users.username, username)).get() as any;
  // 账号不存在:普通"凭据错误"(不区分账号是否存在,避免账号枚举)。
  if (!user || !user.isActive) return { code: 401, body: { error: "Invalid credentials" } };

  // 防爆破:先查是否已被锁定。
  const lock = checkLocked(username);
  if (!lock.ok) return { code: 423, body: { error: "Too many login attempts", retryAfterSeconds: lock.retryAfterSeconds } };

  const passwordHash = md5Hash(password + user.subsonicSalt);
  if (passwordHash !== user.password) {
    recordLoginFailure(username);
    return { code: 401, body: { error: "Invalid credentials" } };
  }
  resetLoginFails(username);
  // Always re-encrypt pass_enc with the current key so that rotating
  // JWT_SECRET (which derives the AES key) self-heals on next login.
  db.update(users).set({ passEnc: encryptPassword(password), updatedAt: new Date().toISOString() }).where(eq(users.id, user.id)).run();
  const token = generateToken(user.id, user.username, !!user.isAdmin);
  return { code: 200, payload: loginPayload(user, token) };
}

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
  const r = handleLogin(c, username, password);
  if (r.payload) return c.json(r.payload);
  return c.json(r.body, r.code as any);
});

authRoutes.post("/auth/login", async (c) => {
  const body = await c.req.json();
  const { username, password } = body;
  const r = handleLogin(c, username, password);
  if (r.payload) return c.json(r.payload);
  return c.json(r.body, r.code as any);
});
