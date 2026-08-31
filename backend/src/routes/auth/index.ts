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
// 计数/锁定截止时间持久化在 users 行(login_fail_count / locked_until),多实例一致性
// 由 DB 保证;成功后清零。仅用纯内存计数会有多副本竞态,仅用 IP 限流又无法锁定具体
// 账号——两者结合可有效提升口令爆破成本(即便其中一种被绕过,另一种仍构成障碍)。
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const LOCK_COOLDOWN_MS = 60 * 1000; // 解冻后若再次连续失败,恢复锁定所需的最小冷却

/** 检查账号是否处于锁定期;处于则记录一次"被锁期间尝试"并累进,延长锁定。
 *  @returns { ok: boolean; retryAfterSeconds?: number }
 */
function checkLocked(user: any): { ok: boolean; retryAfterSeconds?: number } {
  if (!user.lockedUntil) return { ok: true };
  const until = Date.parse(user.lockedUntil);
  if (Number.isNaN(until) || until <= Date.now()) {
    // 锁定已过期:清空截止时间(计数保留,便于解锁后立即锁定策略)。
    db.update(users).set({ lockedUntil: null, updatedAt: new Date().toISOString() }).where(eq(users.id, user.id)).run();
    return { ok: true };
  }
  return { ok: false, retryAfterSeconds: Math.ceil((until - Date.now()) / 1000) };
}

/** 记录一次登录失败;达到阈值时锁定账号,并返回是否已被锁定。
 *  @returns { locked: boolean; retryAfterSeconds?: number }
 */
function recordLoginFailure(user: any): { locked: boolean; retryAfterSeconds?: number } {
  const failCount = (user.loginFailCount || 0) + 1;
  let lockedUntil: number | null = null;
  if (failCount >= MAX_FAILS) {
    // 锁定时长:LOCK_MS;若上次锁定刚过不久又再触发,说明持续被爆破,延长惩罚。
    const lastLock = user.lockedUntil ? Date.parse(user.lockedUntil) : 0;
    const extended = !Number.isNaN(lastLock) && Date.now() - lastLock < LOCK_COOLDOWN_MS;
    lockedUntil = Date.now() + (extended ? LOCK_MS * 2 : LOCK_MS);
    db.update(users).set({
      loginFailCount: failCount,
      lockedUntil: new Date(lockedUntil).toISOString(),
      updatedAt: new Date().toISOString(),
    }).where(eq(users.id, user.id)).run();
    const locked = checkLocked({ ...user, lockedUntil: new Date(lockedUntil).toISOString() });
    return { locked: !locked.ok, retryAfterSeconds: locked.retryAfterSeconds };
  }
  db.update(users).set({ loginFailCount: failCount, updatedAt: new Date().toISOString() }).where(eq(users.id, user.id)).run();
  return { locked: false };
}

/** 登录成功后清零失败计数与锁定。 */
function resetLoginFails(user: any): void {
  if ((user.loginFailCount || 0) > 0 || user.lockedUntil) {
    db.update(users).set({
      loginFailCount: 0,
      lockedUntil: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(users.id, user.id)).run();
  }
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
  const lock = checkLocked(user);
  if (!lock.ok) return { code: 423, body: { error: "Too many login attempts", retryAfterSeconds: lock.retryAfterSeconds } };

  const passwordHash = md5Hash(password + user.subsonicSalt);
  if (passwordHash !== user.password) {
    recordLoginFailure(user);
    return { code: 401, body: { error: "Invalid credentials" } };
  }
  resetLoginFails(user);
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
