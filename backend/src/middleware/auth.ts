import { Context, Next } from "hono";
import jwt from "jsonwebtoken";
import md5 from "md5";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { decryptPassword } from "../db/index.js";
import { hashApiKey } from "../utils/auth.js";
import { JWT_SECRET } from "../utils/env.js";

export interface AuthUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
    mergedParams?: Record<string, any>;
  }
}

// ==================== 鉴权缓存(避免每请求全表扫描 / 每请求查库) ====================
// 1) apiKey 索引: apiKeyHash(sha256) → { userId, expiresAt },O(1) 命中,
//    替代原 authenticateApiKey 的 db.select().from(users).all() 逐行明文比对。
// 2) 用户缓存: userId → AuthUser + isActive,短 TTL(60s),替代 JWT 每请求查库。
// 失效: 用户管理/apiKey 写操作后调用 invalidateAuthCaches()(见 api/index.ts 各端点)。
// 存量兼容: 有明文 apiKey 无 apiKeyHash 的行,构建索引时即时计算 hash 并回填(自愈迁移)。
const USER_CACHE_TTL_MS = 60_000;
const userCache = new Map<string, { user: AuthUser; isActive: boolean; at: number }>();
let apiKeyIndex: Map<string, { userId: string; expiresAt: string | null }> | null = null;

function buildApiKeyIndex(): void {
  const idx = new Map<string, { userId: string; expiresAt: string | null }>();
  const rows = db.select().from(users).all();
  for (const u of rows) {
    let h: string | null = u.apiKeyHash || null;
    if (!h && u.apiKey) {
      // 存量行(apiKeyHash 列此前从未写入):用明文即时计算并回填。
      h = hashApiKey(u.apiKey);
      try {
        db.update(users).set({ apiKeyHash: h, updatedAt: new Date().toISOString() }).where(eq(users.id, u.id)).run();
      } catch { /* 回填失败不阻断(下次重建再试) */ }
    }
    if (h) idx.set(h, { userId: u.id, expiresAt: u.apiKeyExpiresAt || null });
  }
  apiKeyIndex = idx;
}

function ensureApiKeyIndex(): void {
  if (!apiKeyIndex) buildApiKeyIndex();
}

/** 用户资料 / apiKey 变更后调用:重建索引 + 清用户缓存。 */
export function invalidateAuthCaches(): void {
  apiKeyIndex = null;
  userCache.clear();
}

export async function authMiddleware(c: Context, next: Next) {
  const apiKey = c.req.header("X-API-Key");
  if (apiKey) {
    const user = await authenticateApiKey(apiKey);
    if (user) { c.set("user", user); return next(); }
  }

  // Bearer token: first try JWT, then fall back to a long-lived API key.
  // The API-key fallback lets the Home Assistant integration present the
  // user's apiKey here (HA integrations conventionally use Authorization:
  // Bearer) and also covers /rest/* OpenSubsonic calls from the integration.
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    let user: AuthUser | null = null;
    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      user = await getUserById(payload.uid || payload.sub);
    } catch {
      // Not a valid JWT — fall through to API-key check below.
    }
    if (!user) user = await authenticateApiKey(token);
    if (user) { c.set("user", user); return next(); }
  }

  const ndAuth = c.req.header("X-ND-Authorization");
  if (ndAuth?.startsWith("Bearer ")) {
    const token = ndAuth.substring(7);
    let user: AuthUser | null = null;
    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      user = await getUserById(payload.uid || payload.sub);
    } catch {}
    if (!user) user = await authenticateApiKey(token);
    if (user) { c.set("user", user); return next(); }
  }

  // Read OpenSubsonic auth params from query string OR form body (MA/libopensonic POSTs form data)
  const body = await c.req.parseBody().catch(() => ({})) as Record<string, string | File | undefined>;
  const q = c.req.queries();
  const getParam = (name: string): string | undefined => {
    return c.req.query(name) || (typeof body[name] === "string" ? body[name] as string : undefined) || (q[name]?.[0]);
  };
  const u = getParam("u");
  const t = getParam("t");
  const s = getParam("s");
  const p = getParam("p");
  if (u && t && s) {
    const user = await authenticateOpenSubsonic(u, t, s);
    if (user) { c.set("user", user); return next(); }
  }
  if (u && p) {
    const user = await authenticateLegacy(u, p);
    if (user) { c.set("user", user); return next(); }
  }

  // token via query param (for audio streaming). Accepts a JWT first, then falls
  // back to a long-lived API key — same order as the Bearer header branch above,
  // and the same contract the WebSocket upgrade already uses (?token=<apiKey|jwt>).
  // Needed because播放器/HA media_source 只能把凭据带在 URL 里(不能加请求头)。
  const tokenParam = getParam("token");
  if (tokenParam) {
    try {
      const payload = jwt.verify(tokenParam, JWT_SECRET) as any;
      const user = await getUserById(payload.uid || payload.sub);
      if (user) { c.set("user", user); return next(); }
    } catch {}
    const user = await authenticateApiKey(tokenParam);
    if (user) { c.set("user", user); return next(); }
  }

  return c.json({ "subsonic-response": { status: "failed", error: { code: 40, message: "Unauthorized" }, version: "1.16.1", type: "MusicFlow" } }, 401);
}

async function getUserById(id: string): Promise<AuthUser | null> {
  const now = Date.now();
  const cached = userCache.get(id);
  if (cached && now - cached.at < USER_CACHE_TTL_MS) {
    return cached.isActive ? cached.user : null;
  }
  const result = db.select().from(users).where(eq(users.id, id)).get();
  if (!result) return null;
  const entry = {
    user: { id: result.id, username: result.username, isAdmin: !!result.isAdmin },
    isActive: !!result.isActive,
    at: now,
  };
  userCache.set(id, entry);
  return entry.isActive ? entry.user : null;
}

async function authenticateApiKey(key: string): Promise<AuthUser | null> {
  ensureApiKeyIndex();
  const hit = apiKeyIndex!.get(hashApiKey(key));
  if (!hit) return null;
  if (hit.expiresAt && new Date(hit.expiresAt) < new Date()) return null;
  // isActive 检查走用户缓存(getUserById 已处理);用户被禁用/改名后 TTL 内自动收敛,
  // 且用户管理端点写操作会 invalidateAuthCaches() 立即生效。
  return getUserById(hit.userId);
}

// OpenSubsonic standard: token = md5(plaintext_password + clientSalt)
async function authenticateOpenSubsonic(username: string, token: string, salt: string): Promise<AuthUser | null> {
  const result = db.select().from(users).where(eq(users.username, username)).get();
  if (!result || !result.isActive) return null;
  // Verify against the decrypted plaintext password (stored encrypted, like Navidrome)
  const plain = decryptPassword(result.passEnc);
  if (plain) {
    if (md5(plain + salt) === token) return { id: result.id, username: result.username, isAdmin: !!result.isAdmin };
  }
  // Fallbacks for users created before pass_enc existed
  const valid1 = md5(result.password + salt) === token;
  const valid2 = md5(md5(result.password) + salt) === token;
  if (valid1 || valid2) return { id: result.id, username: result.username, isAdmin: !!result.isAdmin };
  return null;
}

// Legacy: p = plaintext or enc:hex(password)
async function authenticateLegacy(username: string, p: string): Promise<AuthUser | null> {
  const result = db.select().from(users).where(eq(users.username, username)).get();
  if (!result || !result.isActive) return null;
  let pass = p;
  if (pass.startsWith("enc:")) {
    try { pass = Buffer.from(pass.slice(4), "hex").toString("utf8"); } catch { return null; }
  }
  const plain = decryptPassword(result.passEnc);
  if (plain && plain === pass) return { id: result.id, username: result.username, isAdmin: !!result.isAdmin };
  if (result.password === md5(pass + result.subsonicSalt)) return { id: result.id, username: result.username, isAdmin: !!result.isAdmin };
  return null;
}

export async function adminMiddleware(c: Context, next: Next) {
  const user = c.get("user");
  if (!user?.isAdmin) {
    return c.json({ "subsonic-response": { status: "failed", error: { code: 50, message: "Admin required" }, version: "1.16.1", type: "MusicFlow" } }, 403);
  }
  return next();
}
