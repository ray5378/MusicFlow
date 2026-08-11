// WebSocket auth helper.
//
// auth.ts's authMiddleware is Hono-bound and can't run on a raw http.Server
// upgrade request, so this mirrors its JWT-then-API-key logic for the WS
// handshake. Keeping it here avoids exposing authenticateApiKey/jwt logic
// through auth.ts's public surface.
import jwt from "jsonwebtoken";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { JWT_SECRET } from "../../utils/env.js";

export interface WsUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

/** Validate a WS handshake token (JWT or long-lived API key). */
export function authenticateWsToken(token: string): WsUser | null {
  if (!token) return null;
  // 1. Try JWT.
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    const user = getUserById(payload.uid || payload.sub);
    if (user) return user;
  } catch {
    // Not a JWT — fall through.
  }
  // 2. Try API key (linear scan; user count is small for self-hosted).
  return findByApiKey(token);
}

function getUserById(id: string): WsUser | null {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  if (!row || !row.isActive) return null;
  return { id: row.id, username: row.username, isAdmin: !!row.isAdmin };
}

function findByApiKey(key: string): WsUser | null {
  for (const u of db.select().from(users).all()) {
    if (u.apiKey && u.apiKey === key) {
      if (!u.isActive) return null;
      if (u.apiKeyExpiresAt && new Date(u.apiKeyExpiresAt) < new Date()) return null;
      return { id: u.id, username: u.username, isAdmin: !!u.isAdmin };
    }
  }
  return null;
}
