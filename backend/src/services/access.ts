// ==================== 细粒度权限服务(管理员在前端为用户逐项勾选) ====================
//
// 双层模型:
//   1) 功能权限(user_permissions):"曲库/歌单/互动/推荐/系统"等库功能的开关。
//      granted=1 显式授权 / 0 显式撤销;无行时回退到 PERMISSION_CATALOG 的
//      defaultGranted(绝大多数库功能默认放行,renderer:use / 管理类默认收紧)。
//   2) 播放器授权(user_renderer_grants):device_key = "dlna:<id>" | "airplay:<id>"
//      | "group:<id>",决定普通用户能控制哪些 DLNA/AirPlay 设备与播放器群组。
//      管理员恒可控制全部(短路,不看任何记录)。
//
// 判定规则:
//   - 管理员(isAdmin)一律通过(hasPerm / canUseRenderer 短路)。
//   - 普通用户:功能权限按 显式覆盖 → 默认值 求值;播放器按
//     renderer.use 功能权限 + 设备授权 双重门禁。
//   - local:<userId> 本机播放器是用户自己的 Web 播放器,不属"播放器插件",
//     永远可用(不受 renderer.use / 设备授权限制)。
//
// 缓存:权限/授权结果带 TTL(30s)。管理员改动后调 invalidateAccessCaches(userId)
// 立即生效(也可全量清空)。
import { Context, Next } from "hono";
import { db } from "../db/index.js";
import { userPermissions, userRendererGrants } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { apiError, BusinessErrorCode } from "../utils/errors.js";

export interface PermDefinition {
  key: string;
  label: string;
  category: string; // 分组: 曲库 | 歌单 | 互动 | 推荐 | 播放器 | 系统
  desc: string;
  defaultGranted: boolean;
}

/** 功能权限常量(路由层引用,避免字符串散落)。 */
export const PERM = {
  LIBRARY_BROWSE: "library.browse", // 浏览曲库(歌曲/专辑/艺术家/风格)
  LIBRARY_SEARCH: "library.search", // 搜索(本地 + 在线/插件)
  LIBRARY_STREAM: "library.stream", // 播放 / 试听 / 下载音频流
  PLAYLIST_VIEW: "playlist.view",   // 查看歌单
  PLAYLIST_MANAGE: "playlist.manage", // 创建 / 编辑 / 删除歌单
  PLAYLIST_IMPORT: "playlist.import", // 导入 / 导出 / 同步歌单
  FAVORITES_MANAGE: "favorites.manage", // 我喜欢(收藏 / 查看)
  HISTORY_MANAGE: "history.manage",   // 播放历史(查看 / 清空)
  LYRICS_VIEW: "lyrics.view",         // 歌词
  COVER_VIEW: "cover.view",           // 封面
  RECOMMEND_VIEW: "recommend.view",   // 每日推荐 / 首页精选 / 推荐池
  WISH_VIEW: "wish.view",             // 点歌台(愿望单)
  RENDERER_USE: "renderer.use",       // 使用播放器(DLNA/AirPlay/群组,需设备授权)
  RENDERER_MANAGE: "renderer.manage", // 管理播放器(设备改名/删除/禁用、群组、扫描)
  FLOW_MANAGE: "flow.manage",         // 音流(自动化流程)
  SETTINGS_MANAGE: "settings.manage", // 系统设置
  USER_MANAGE: "user.manage",         // 用户管理
} as const;

export const PERMISSION_CATALOG: PermDefinition[] = [
  { key: PERM.LIBRARY_BROWSE, label: "浏览曲库", category: "曲库", desc: "查看歌曲、专辑、艺术家、风格列表与详情", defaultGranted: true },
  { key: PERM.LIBRARY_SEARCH, label: "搜索", category: "曲库", desc: "本地搜索与在线/插件搜索", defaultGranted: true },
  { key: PERM.LIBRARY_STREAM, label: "播放音频", category: "曲库", desc: "播放 / 试听 / 获取音频流(stream / download)", defaultGranted: true },
  { key: PERM.PLAYLIST_VIEW, label: "查看歌单", category: "歌单", desc: "查看歌单与曲目列表", defaultGranted: true },
  { key: PERM.PLAYLIST_MANAGE, label: "管理歌单", category: "歌单", desc: "创建、编辑、删除歌单", defaultGranted: true },
  { key: PERM.PLAYLIST_IMPORT, label: "导入导出歌单", category: "歌单", desc: "URL / 文件导入、导出、平台同步", defaultGranted: true },
  { key: PERM.FAVORITES_MANAGE, label: "我喜欢", category: "互动", desc: "收藏 / 取消收藏歌曲与歌单、查看我的喜欢", defaultGranted: true },
  { key: PERM.HISTORY_MANAGE, label: "播放历史", category: "互动", desc: "查看与清空自己的播放历史", defaultGranted: true },
  { key: PERM.LYRICS_VIEW, label: "歌词", category: "互动", desc: "查看歌词(在线 / 已落库)", defaultGranted: true },
  { key: PERM.COVER_VIEW, label: "封面", category: "互动", desc: "查看封面图", defaultGranted: true },
  { key: PERM.RECOMMEND_VIEW, label: "每日推荐", category: "推荐", desc: "每日推荐 / 首页平台精选 / 推荐池", defaultGranted: true },
  { key: PERM.WISH_VIEW, label: "点歌台", category: "系统", desc: "查看点歌台(愿望单)", defaultGranted: false },
  { key: PERM.RENDERER_USE, label: "使用播放器", category: "播放器", desc: "可控制被授权的 DLNA / AirPlay / 群组播放器", defaultGranted: false },
  { key: PERM.RENDERER_MANAGE, label: "管理播放器", category: "播放器", desc: "扫描 / 改名 / 删除 / 禁用设备、管理群组", defaultGranted: false },
  { key: PERM.FLOW_MANAGE, label: "音流管理", category: "系统", desc: "音流自动化流程的创建与触发", defaultGranted: false },
  { key: PERM.SETTINGS_MANAGE, label: "系统设置", category: "系统", desc: "系统设置 / 代理 / 内存 / 歌词封面配置", defaultGranted: false },
  { key: PERM.USER_MANAGE, label: "用户管理", category: "系统", desc: "用户增删改、API Key、权限分配", defaultGranted: false },
];

const DEFAULTS: Record<string, boolean> = {};
for (const p of PERMISSION_CATALOG) DEFAULTS[p.key] = p.defaultGranted;

// ==================== 缓存 ====================
const CACHE_TTL_MS = 30_000;
const permCache = new Map<string, { at: number; map: Record<string, boolean> }>();
const grantCache = new Map<string, { at: number; keys: Set<string> }>();

/** 权限 / 授权写操作后调用:指定 userId 立即失效;不传则全量清空。 */
export function invalidateAccessCaches(userId?: string): void {
  if (userId) {
    permCache.delete(userId);
    grantCache.delete(userId);
  } else {
    permCache.clear();
    grantCache.clear();
  }
}

/** 权限目录默认值快照(管理端 UI 展示用)。 */
export function getPermissionDefaults(): Record<string, boolean> {
  return { ...DEFAULTS };
}

export function permissionCatalog(): PermDefinition[] {
  return PERMISSION_CATALOG;
}

// ==================== 读侧 ====================
/** 某用户的功能权限有效值(显式覆盖 → 默认值),带 TTL 缓存。 */
export function getUserPermissions(userId: string): Record<string, boolean> {
  const now = Date.now();
  const cached = permCache.get(userId);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.map;
  const rows = db.select().from(userPermissions).where(eq(userPermissions.userId, userId)).all();
  const map: Record<string, boolean> = { ...DEFAULTS };
  for (const r of rows) map[r.permKey] = !!r.granted;
  permCache.set(userId, { at: now, map });
  return map;
}

/** 功能权限判定:管理员恒通过。 */
export function hasPerm(userId: string, isAdmin: boolean, key: string): boolean {
  if (isAdmin) return true;
  const map = getUserPermissions(userId);
  return key in map ? map[key] : (DEFAULTS[key] ?? false);
}

/** 某用户的播放器授权集合("dlna:<id>" 等),带 TTL 缓存。 */
export function getUserRendererGrants(userId: string): Set<string> {
  const now = Date.now();
  const cached = grantCache.get(userId);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.keys;
  const rows = db.select().from(userRendererGrants).where(eq(userRendererGrants.userId, userId)).all();
  const keys = new Set(rows.map((r) => r.deviceKey));
  grantCache.set(userId, { at: now, keys });
  return keys;
}

/** 播放器可用判定:管理员恒可用;普通用户需 renderer.use + 设备授权。 */
export function canUseRenderer(userId: string, isAdmin: boolean, deviceKey: string): boolean {
  if (isAdmin) return true;
  const perms = getUserPermissions(userId);
  if (!perms[PERM.RENDERER_USE]) return false;
  return getUserRendererGrants(userId).has(deviceKey);
}

/** peerId → 设备授权 key("dlna:<id>" / "airplay:<id>" / "group:<id>");
 *  local peer 返回 null(用户自己的 Web 播放器,不受播放器授权限制)。 */
export function peerToDeviceKey(peerId: string): string | null {
  const idx = peerId.indexOf(":");
  if (idx <= 0) return null;
  const kind = peerId.slice(0, idx);
  const id = peerId.slice(idx + 1);
  if (kind === "dlna" || kind === "airplay" || kind === "group") return `${kind}:${id}`;
  return null;
}

/** 该用户能看到的 cast peer 判定(含本机 local:<userId>)。 */
export function canControlPeer(userId: string, isAdmin: boolean, peerId: string): boolean {
  if (isAdmin) return true;
  if (peerId === `local:${userId}`) return true;
  const key = peerToDeviceKey(peerId);
  return key ? canUseRenderer(userId, false, key) : false;
}

/** 从完整 peer 列表里筛出当前用户可见的部分(管理员全量)。 */
export function filterPeersByAccess<T extends { peerId: string }>(userId: string, isAdmin: boolean, peers: T[]): T[] {
  if (isAdmin) return peers;
  return peers.filter((p) => canControlPeer(userId, false, p.peerId));
}

// ==================== 写侧(管理员调用) ====================
export function setUserPermission(userId: string, key: string, granted: boolean): void {
  if (!(key in DEFAULTS)) return;
  const now = new Date().toISOString();
  if (granted === DEFAULTS[key]) {
    // 与默认一致 → 删除显式行,回退默认值(保持表精简)。
    db.delete(userPermissions).where(and(eq(userPermissions.userId, userId), eq(userPermissions.permKey, key))).run();
  } else {
    db.insert(userPermissions)
      .values({ userId, permKey: key, granted: granted ? 1 : 0, updatedAt: now })
      .onConflictDoUpdate({
        target: [userPermissions.userId, userPermissions.permKey],
        set: { granted: granted ? 1 : 0, updatedAt: now },
      })
      .run();
  }
  invalidateAccessCaches(userId);
}

/** 整表替换用户功能权限(管理员前端一次性勾选提交)。 */
export function replaceUserPermissions(userId: string, patch: Record<string, boolean>): void {
  for (const [key, granted] of Object.entries(patch)) {
    if (key in DEFAULTS) setUserPermission(userId, key, granted);
  }
}

export function grantRenderer(userId: string, deviceKey: string): void {
  if (!deviceKey) return;
  db.insert(userRendererGrants)
    .values({ userId, deviceKey, createdAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();
  invalidateAccessCaches(userId);
}

export function revokeRenderer(userId: string, deviceKey: string): void {
  db.delete(userRendererGrants).where(and(eq(userRendererGrants.userId, userId), eq(userRendererGrants.deviceKey, deviceKey))).run();
  invalidateAccessCaches(userId);
}

/** 整表替换播放器授权(管理员前端一次性勾选提交)。 */
export function replaceRendererGrants(userId: string, deviceKeys: string[]): void {
  db.delete(userRendererGrants).where(eq(userRendererGrants.userId, userId)).run();
  const now = new Date().toISOString();
  for (const k of deviceKeys) {
    if (k) {
      db.insert(userRendererGrants).values({ userId, deviceKey: k, createdAt: now }).run();
    }
  }
  invalidateAccessCaches(userId);
}

/** 管理端视图:目录 + 用户有效权限 + 授权设备。 */
export function effectiveAccessView(userId: string, isAdmin: boolean): {
  catalog: PermDefinition[];
  permissions: Record<string, boolean>;
  rendererGrants: string[];
} {
  return {
    catalog: PERMISSION_CATALOG,
    permissions: isAdmin ? { ...DEFAULTS } : getUserPermissions(userId),
    rendererGrants: isAdmin ? [] : [...getUserRendererGrants(userId)].sort(),
  };
}

// ==================== 中间件 ====================
/** 功能权限门禁中间件:管理员短路;无权限返回 403。 */
export function permMiddleware(key: string) {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ "subsonic-response": { status: "failed", error: { code: 40, message: "Unauthorized" }, version: "1.16.1", type: "MusicFlow" } }, 401);
    }
    if (hasPerm(user.id, !!user.isAdmin, key)) return next();
    return c.json(apiError(BusinessErrorCode.FORBIDDEN, "无权执行该操作"), 403);
  };
}

/**
 * 播放器授权中间件(按 URL 参数里的设备 id 判定)。
 * kind: "dlna" | "airplay" | "group";paramName 默认 "deviceId"。
 * 管理员短路;普通用户需 renderer.use + 对应设备授权。
 */
export function rendererGrantParamMiddleware(kind: "dlna" | "airplay" | "group", paramName = "deviceId") {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ "subsonic-response": { status: "failed", error: { code: 40, message: "Unauthorized" }, version: "1.16.1", type: "MusicFlow" } }, 401);
    }
    if (user.isAdmin) return next();
    const id = c.req.param(paramName);
    if (canUseRenderer(user.id, false, `${kind}:${id}`)) return next();
    return c.json(apiError(BusinessErrorCode.FORBIDDEN, "无权控制该播放器"), 403);
  };
}
