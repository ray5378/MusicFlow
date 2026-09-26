// 自动生成 —— 由 index.ts 物理拆分而来（users 域，15 条路由）。零逻辑改动。
import type { Hono } from "hono";
import {
  BusinessErrorCode,
  adminMiddleware,
  apiError,
  assertKeyAccess,
  clearPlaylistCoverCache,
  db,
  effectiveAccessView,
  encryptPassword,
  eq,
  getCachedDevices,
  getUserPermissions,
  getUserRendererGrants,
  gm,
  inArray,
  invalidateAccessCaches,
  invalidateAuthCaches,
  like,
  listAirPlayDevices,
  md5,
  or,
  playHistory,
  playlistFavorites,
  playlistSongs,
  playlists,
  randomBytes,
  replaceRendererGrants,
  replaceUserPermissions,
  userFavoriteAlbums,
  userFavoriteArtists,
  userFavoriteSongs,
  users,
  uuidv4,
  wishes,
} from "./shared.js";

export function registerUsers(app: Hono): void {
app.get("/v1/users", adminMiddleware, (c) => {
  return c.json(db.select().from(users).all().map(u => ({ id: u.id, username: u.username, isAdmin: !!u.isAdmin, isActive: !!u.isActive, apiKeySet: !!u.apiKey, apiKeyExpiresAt: u.apiKeyExpiresAt, createdAt: u.createdAt, updatedAt: u.updatedAt })));
});

app.post("/v1/users", adminMiddleware, async (c) => {
  const body = await c.req.json();
  const { username, password } = body;
  const subsonicSalt = Math.random().toString(16).substring(2, 10);
  const id = uuidv4();
  db.insert(users).values({ id, username, password: md5(password + subsonicSalt), salt: Math.random().toString(36).substring(2, 10), subsonicSalt, passEnc: encryptPassword(password), isAdmin: 0, isActive: 1 }).run();
  return c.json({ id, username });
});

app.put("/v1/users/:id/password", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  if (id !== user?.id && !user?.isAdmin) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.user.changePasswordForbidden"), 403);
  const body = await c.req.json();
  if (!body.newPassword) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.user.passwordEmpty"), 400);
  const newSubsonicSalt = Math.random().toString(16).substring(2, 10);
  db.update(users).set({ password: md5(body.newPassword + newSubsonicSalt), subsonicSalt: newSubsonicSalt, passEnc: encryptPassword(body.newPassword), mustChangePassword: 0, apiKey: null, updatedAt: new Date().toISOString() }).where(eq(users.id, id)).run();
  invalidateAuthCaches(); // 密码变更会清空 apiKey → 重建鉴权索引
  return c.json({ success: true });
});

app.put("/v1/users/:id/username", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  if (id !== user?.id && !user?.isAdmin) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.user.changeNameForbidden"), 403);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.username || "").trim();
  if (!name) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.user.nameEmpty"), 400);
  const existing = db.select().from(users).where(eq(users.username, name)).get();
  if (existing && existing.id !== id) return c.json(apiError(BusinessErrorCode.CONFLICT, "errors.user.nameTaken"), 409);
  db.update(users).set({ username: name, updatedAt: new Date().toISOString() }).where(eq(users.id, id)).run();
  invalidateAuthCaches(); // 用户名变更影响鉴权缓存
  return c.json({ success: true, username: name });
});

app.delete("/v1/users/:id", adminMiddleware, (c) => {
  const user = c.get("user");
  const id = c.req.param("id")!;
  if (id === user?.id) return c.json(apiError(BusinessErrorCode.INVALID_PARAM, "errors.user.selfDelete"), 400);
  const target = db.select().from(users).where(eq(users.id, id)).get();
  if (!target) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.user.notFound"), 404);
  const owned = db.select().from(playlists).where(eq(playlists.ownerId, id)).all();
  if (owned.length > 0) {
    db.delete(playlistSongs).where(inArray(playlistSongs.playlistId, owned.map(p => p.id))).run();
    owned.forEach(p => clearPlaylistCoverCache(p.id));
    db.delete(playlists).where(inArray(playlists.id, owned.map(p => p.id))).run();
  }
  db.delete(userFavoriteSongs).where(eq(userFavoriteSongs.userId, id)).run();
  db.delete(userFavoriteAlbums).where(eq(userFavoriteAlbums.userId, id)).run();
  db.delete(userFavoriteArtists).where(eq(userFavoriteArtists.userId, id)).run();
  db.delete(playlistFavorites).where(eq(playlistFavorites.userId, id)).run();
  db.delete(playHistory).where(eq(playHistory.userId, id)).run();
  db.delete(wishes).where(eq(wishes.userId, id)).run();
  db.delete(users).where(eq(users.id, id)).run();
  // 清理该用户的权限与播放器授权(避免孤儿行)。
  invalidateAccessCaches(id);
  return c.json({ success: true });
});

// ==================== 细粒度权限管理(管理员) ====================
// GET  /v1/users/:id/access    — 目录 + 该用户功能权限有效值 + 播放器授权列表
// PUT  /v1/users/:id/access    — 整表替换(功能权限 + 播放器授权),一次性勾选提交
// GET  /v1/access/renderers    — 可授权播放器清单(DLNA / AirPlay / 群组)

app.get("/v1/users/:id/access", adminMiddleware, (c) => {
  const id = c.req.param("id")!;
  const target = db.select().from(users).where(eq(users.id, id)).get();
  if (!target) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.user.notFound"), 404);
  const view = effectiveAccessView(id, !!target.isAdmin);
  // 管理员无授权限制,rendererGrants 返回 null 由前端展示"管理员不限"。
  return c.json({ success: true, ...view });
});

app.put("/v1/users/:id/access", adminMiddleware, async (c) => {
  const id = c.req.param("id")!;
  const target = db.select().from(users).where(eq(users.id, id)).get();
  if (!target) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.user.notFound"), 404);
  const body = await c.req.json().catch(() => ({}));
  if (body.permissions !== undefined && body.permissions !== null && typeof body.permissions === "object") {
    replaceUserPermissions(id, body.permissions);
  }
  if (Array.isArray(body.renderers)) {
    replaceRendererGrants(id, body.renderers.filter((k: unknown) => typeof k === "string"));
  }
  const view = effectiveAccessView(id, !!target.isAdmin);
  return c.json({ success: true, ...view });
});

// 可授权播放器清单:DLNA 设备、AirPlay 设备、播放器群组(管理端勾选 UI 用)。

app.get("/v1/access/renderers", adminMiddleware, (c) => {
  const dlna = getCachedDevices().map((d) => ({
    kind: "dlna" as const,
    deviceKey: `dlna:${d.id}`,
    name: d.alias || d.name || d.id,
    available: !!d.available,
    disabled: !!d.disabled,
  }));
  const airplay = listAirPlayDevices().map((d: any) => ({
    kind: "airplay" as const,
    deviceKey: `airplay:${d.id}`,
    name: d.alias || d.name || d.id,
    available: !!d.available,
    disabled: !!d.disabled,
  }));
  const groups = gm.listWithMembers().map((g: any) => ({
    kind: "group" as const,
    deviceKey: `group:${g.id}`,
    name: g.name || g.id,
    available: (g.members || []).some((m: any) => m.available),
    memberCount: (g.members || []).length,
  }));
  return c.json({ success: true, renderers: [...dlna, ...airplay, ...groups] });
});

// ==================== Current user (HA integration health check) ====================
// Used by the hass-musicflow config flow to verify the API key works.
// 附带细粒度权限载荷(与登录一致),供前端刷新后恢复菜单/播放器可见性。

app.get("/v1/users/me", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ id: null, username: null, isAdmin: false });
  const isAdmin = !!user.isAdmin;
  return c.json({
    id: user.id,
    username: user.username,
    isAdmin,
    permissions: isAdmin ? { admin: true } : getUserPermissions(user.id),
    rendererGrants: isAdmin ? null : [...getUserRendererGrants(user.id)].sort(),
  });
});

// ==================== API Key (long-lived token for third-party clients) ====================
// JWT expires in 24h, which is useless for an always-on client like the Home
// Assistant integration. middleware/auth.ts already accepts users.api_key as a
// Bearer fallback — this is the missing management surface for it.
// Stored in plaintext because authenticateApiKey() compares it directly; that
// also lets the user re-read the key later instead of it being show-once.

app.get("/v1/users/me/api-key", (c) => {
  const user = c.get("user");
  const row = db.select().from(users).where(eq(users.id, user!.id)).get();
  return c.json({
    apiKey: row?.apiKey || null,
    expiresAt: row?.apiKeyExpiresAt || null,
  });
});

// body: { expiresInDays?: number }  — omit or 0 for a key that never expires

app.post("/v1/users/me/api-key", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({} as any));
  const days = Number(body?.expiresInDays) || 0;
  const apiKey = `mf_${randomBytes(24).toString("base64url")}`;
  const expiresAt = days > 0
    ? new Date(Date.now() + days * 86400_000).toISOString()
    : null;
  db.update(users)
    .set({ apiKey, apiKeyExpiresAt: expiresAt, updatedAt: new Date().toISOString() })
    .where(eq(users.id, user!.id))
    .run();
  invalidateAuthCaches(); // 新 key 生效前重建索引
  return c.json({ apiKey, expiresAt });
});

app.delete("/v1/users/me/api-key", (c) => {
  const user = c.get("user");
  db.update(users)
    .set({ apiKey: null, apiKeyExpiresAt: null, updatedAt: new Date().toISOString() })
    .where(eq(users.id, user!.id))
    .run();
  invalidateAuthCaches(); // 撤销 key 后立即失效
  return c.json({ success: true });
});

// Per-user variants, used by the admin user list so an admin can issue a key for
// a dedicated service account (e.g. a "homeassistant" user) without logging in
// as them. Declared after the /me routes so "me" is not captured by :id.
// Self-service is allowed too, mirroring the password/username endpoints.

app.get("/v1/users/:id/api-key", (c) => {
  const id = c.req.param("id")!;
  if (!assertKeyAccess(c, id)) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.apikey.viewForbidden"), 403);
  const row = db.select().from(users).where(eq(users.id, id)).get();
  if (!row) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.user.notFound"), 404);
  return c.json({ apiKey: row.apiKey || null, expiresAt: row.apiKeyExpiresAt || null });
});

// body: { expiresInDays?: number }  — omit or 0 for a key that never expires

app.post("/v1/users/:id/api-key", async (c) => {
  const id = c.req.param("id")!;
  if (!assertKeyAccess(c, id)) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.apikey.issueForbidden"), 403);
  const row = db.select().from(users).where(eq(users.id, id)).get();
  if (!row) return c.json(apiError(BusinessErrorCode.NOT_FOUND, "errors.user.notFound"), 404);
  const body = await c.req.json().catch(() => ({} as any));
  const days = Number(body?.expiresInDays) || 0;
  const apiKey = `mf_${randomBytes(24).toString("base64url")}`;
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null;
  db.update(users)
    .set({ apiKey, apiKeyExpiresAt: expiresAt, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .run();
  invalidateAuthCaches(); // 新 key 生效前重建索引
  return c.json({ apiKey, expiresAt });
});

app.delete("/v1/users/:id/api-key", (c) => {
  const id = c.req.param("id")!;
  if (!assertKeyAccess(c, id)) return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.apikey.revokeForbidden"), 403);
  db.update(users)
    .set({ apiKey: null, apiKeyExpiresAt: null, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .run();
  invalidateAuthCaches(); // 撤销 key 后立即失效
  return c.json({ success: true });
});

// ==================== Sources ====================
}
