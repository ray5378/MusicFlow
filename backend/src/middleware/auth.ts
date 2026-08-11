import { Context, Next } from "hono";
import jwt from "jsonwebtoken";
import md5 from "md5";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { decryptPassword } from "../db/index.js";
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
  const result = db.select().from(users).where(eq(users.id, id)).get();
  if (!result || !result.isActive) return null;
  return { id: result.id, username: result.username, isAdmin: !!result.isAdmin };
}

async function authenticateApiKey(key: string): Promise<AuthUser | null> {
  const allUsers = db.select().from(users).all();
  for (const u of allUsers) {
    if (u.apiKey && u.apiKey === key) {
      if (!u.isActive) return null;
      if (u.apiKeyExpiresAt && new Date(u.apiKeyExpiresAt) < new Date()) return null;
      return { id: u.id, username: u.username, isAdmin: !!u.isAdmin };
    }
  }
  return null;
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
