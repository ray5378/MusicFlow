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
import { buildLocalPeerId, isOwnLocalPeer, maskLocalPeerId, userIdOfLocalPeer } from "../utils/peerId.js";
import { getGroupManager } from "./group/index.js";
import { getHiddenPeerIds, getNameOverrides } from "./playerPrefs.js";
// sendspin 音量回显取值(实时优先/离线回退持久值)。此处只做「补齐字段」,
// 不引入 sendspin 运行时依赖(peerVolume 内部才碰 sendspin/index);
// 依赖方向 access → group → sendspin 本就存在,不新增环。
import { attachSendspinPeerVolumes } from "./sendspin/peerVolume.js";

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
  { key: PERM.LIBRARY_BROWSE, label: "浏览曲库", category: "library", desc: "查看歌曲、专辑、艺术家、风格列表与详情", defaultGranted: true },
  { key: PERM.LIBRARY_SEARCH, label: "搜索", category: "library", desc: "本地搜索与在线/插件搜索", defaultGranted: true },
  { key: PERM.LIBRARY_STREAM, label: "播放音频", category: "library", desc: "播放 / 试听 / 获取音频流(stream / download)", defaultGranted: true },
  { key: PERM.PLAYLIST_VIEW, label: "查看歌单", category: "playlist", desc: "查看歌单与曲目列表", defaultGranted: true },
  { key: PERM.PLAYLIST_MANAGE, label: "管理歌单", category: "playlist", desc: "创建、编辑、删除歌单", defaultGranted: true },
  { key: PERM.PLAYLIST_IMPORT, label: "导入导出歌单", category: "playlist", desc: "URL / 文件导入、导出、平台同步", defaultGranted: true },
  { key: PERM.FAVORITES_MANAGE, label: "我喜欢", category: "interaction", desc: "收藏 / 取消收藏歌曲与歌单、查看我的喜欢", defaultGranted: true },
  { key: PERM.HISTORY_MANAGE, label: "播放历史", category: "interaction", desc: "查看与清空自己的播放历史", defaultGranted: true },
  { key: PERM.LYRICS_VIEW, label: "歌词", category: "interaction", desc: "查看歌词(在线 / 已落库)", defaultGranted: true },
  { key: PERM.COVER_VIEW, label: "封面", category: "interaction", desc: "查看封面图", defaultGranted: true },
  { key: PERM.RECOMMEND_VIEW, label: "每日推荐", category: "recommend", desc: "每日推荐 / 首页平台精选 / 推荐池", defaultGranted: true },
  { key: PERM.WISH_VIEW, label: "点歌台", category: "system", desc: "查看点歌台(愿望单)", defaultGranted: false },
  { key: PERM.RENDERER_USE, label: "使用播放器", category: "player", desc: "可控制被授权的 DLNA / AirPlay / 群组播放器", defaultGranted: false },
  { key: PERM.RENDERER_MANAGE, label: "管理播放器", category: "player", desc: "扫描 / 改名 / 删除 / 禁用设备、管理群组", defaultGranted: false },
  { key: PERM.FLOW_MANAGE, label: "音流管理", category: "system", desc: "音流自动化流程的创建与触发", defaultGranted: false },
  { key: PERM.SETTINGS_MANAGE, label: "系统设置", category: "system", desc: "系统设置 / 代理 / 内存 / 歌词封面配置", defaultGranted: false },
  { key: PERM.USER_MANAGE, label: "用户管理", category: "system", desc: "用户增删改、API Key、权限分配", defaultGranted: false },
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

/** 播放器可用判定:管理员恒可用;普通用户需 renderer.use + 设备授权。
 *  群组例外:用户自己创建的群组(ownerUserId === userId)创建即可控,无需额外授权。 */
export function canUseRenderer(userId: string, isAdmin: boolean, deviceKey: string): boolean {
  if (isAdmin) return true;
  const perms = getUserPermissions(userId);
  if (!perms[PERM.RENDERER_USE]) return false;
  if (deviceKey.startsWith("group:")) {
    const groupId = deviceKey.slice("group:".length);
    try {
      if (getGroupManager().isOwnedBy(groupId, userId, false)) return true;
    } catch { /* 忽略,退回授权判定 */ }
  }
  return getUserRendererGrants(userId).has(deviceKey);
}

/** peerId → 设备授权 key("dlna:<id>" / "airplay:<id>" / "group:<id>");
 *  local peer 返回 null(用户自己的 Web 播放器,不受播放器授权限制)。 */
export function peerToDeviceKey(peerId: string): string | null {
  const idx = peerId.indexOf(":");
  if (idx <= 0) return null;
  const kind = peerId.slice(0, idx);
  const id = peerId.slice(idx + 1);
  if (kind === "dlna" || kind === "airplay" || kind === "group" || kind === "sendspin") return `${kind}:${id}`;
  return null;
}

/** 该用户能看到的 cast peer 判定(含本机 local:<userId>[:<clientId>])。
 *  本机播放器按「同账号」放行 —— 同账号的多个客户端实例都是他自己在用。 */
export function canControlPeer(userId: string, isAdmin: boolean, peerId: string): boolean {
  if (isAdmin) return true;
  if (isOwnLocalPeer(peerId, userId)) return true;
  const key = peerToDeviceKey(peerId);
  return key ? canUseRenderer(userId, false, key) : false;
}

/** 单条 peer 对「这个调用方」是否可见 —— 与 filterPeersByAccess 同一口径。
 *
 *  本机(local)播放器是**按账号**可见的:同账号在多个标签页 / 多个客户端登录时,
 *  服务端为每个实例各存一条队列;「播放器」页要把它们在「客户端」/「Web 播放器」
 *  两个模块里各列一行,所以同账号的全部实例都放行。
 *  **别账号的本机播放器仍不可见**(管理员也不例外)——否则切换器会列出全服务器
 *  所有客户端的本机播放器。
 *  对外标识用不可逆实例键(`local:<userId>:<instanceKey>`,见 utils/peerId.ts);
 *  「哪条是我自己」由服务端打 `self` 标记,不靠调用方比对 clientId。
 *  dlna / airplay / group 仍按原规则(管理员全量,普通用户按授权)。 */
export function peerVisibleTo(
  userId: string,
  isAdmin: boolean,
  peerId: string,
  _clientId?: string | null,
): boolean {
  if (peerId.startsWith("local:")) {
    return !!userId && userIdOfLocalPeer(peerId) === userId;
  }
  return isAdmin ? true : canControlPeer(userId, false, peerId);
}

/** 从完整 peer 列表里筛出当前调用方可见的部分(口径见 peerVisibleTo)。 */
export function filterPeersByAccess<T extends { peerId: string }>(
  userId: string,
  isAdmin: boolean,
  peers: T[],
  clientId?: string | null,
): T[] {
  return peers.filter((p) => peerVisibleTo(userId, isAdmin, p.peerId, clientId));
}

/**
 * 服务端真实 peer 列表 → 调用方视角列表(`/v1/peers` 与 WS `peer_snapshot` 的**唯一出口**)。
 *
 * 顺序至关重要:可见性 → **打码 + self 标记** → 隐藏剪枝 → 显示名覆盖。
 * 偏好(隐藏 / 改名)一律以**对外 id** 为键存储与比对,而打码是它的前置条件 ——
 * 若在打码前套偏好,本机实例的真实 peerId(`local:<uid>:<clientId>`)与客户端手里
 * 的对外 id 永远对不上,针对客户端 / Web 播放器的改名与隐藏就会静默失效。
 *
 * 对外 id 的两种形态(与前端 `localPeerId` 规范一致):
 *   - 「调用方自己那条」→ `local:<userId>`,前端据 self 渲染角标并置顶;
 *   - 同账号的其它实例 → `local:<userId>:<instanceKey>`,各占一行;
 *   - dlna / airplay / group / sendspin → 原样(打码对它们恒等)。
 *
 * 另:sendspin 行的 volume/muted 在**入口**补齐(attachSendspinPeerVolumes),
 * 与「可见性/打码/隐藏/改名」四条正交 —— 它只是给原始行添两个展示字段,
 * 不参与 id 规范与筛选,故放在最先执行不影响既有顺序语义。
 */
export function decoratePeersForClient<T extends { peerId: string; kind?: string; name?: string; platform?: string }>(
  peers: T[],
  userId: string,
  isAdmin: boolean,
  clientId?: string | null,
  includeHidden = false,
): (T & { self: boolean; hidden?: boolean; instancePeerId?: string; volume?: number; muted?: boolean })[] {
  const myLocalPeerId = buildLocalPeerId(userId, clientId);
  const seen = new Set<string>();
  // sendspin 音量/静音回显：在这个**唯一出口**补齐（实时优先、离线回退持久库值），
  // 后面的可见性/打码/隐藏剪枝/改名都不改变取值口径；其它 kind 不带这两个字段。
  const out: (T & { self: boolean; instancePeerId?: string; volume?: number; muted?: boolean })[] = [];
  for (const p of filterPeersByAccess(userId, isAdmin, attachSendspinPeerVolumes(peers), clientId)) {
    const self = p.kind === "local" && p.peerId === myLocalPeerId;
    // 播放器统一化方案收敛:Web 播放器不再作为「可被遥控端」。对外列表一律隐藏
    // 其它 web 本机实例(自己那条 self 行保留 —— Web 前端仍靠它归一化本机队列)。
    // 客户端切换器、Web 切换器、管理页由此统一看不到「Web 播放器」,
    // 客户端→Web 遥控从源头断掉;Web→客户端、客户端→客户端不受影响。
    if (p.kind === "local" && !self && p.platform === "web") continue;
    const masked = maskLocalPeerId(p.peerId);
    // 自己那条归一化成规范形式;同账号的旧格式遗留行会与之撞 id,故此处去重(self 优先)。
    const peerId = self ? `local:${userId}` : masked;
    if (seen.has(peerId)) continue;
    seen.add(peerId);
    // self 行额外带**按实例**的键供管理页写偏好用:规范形式 local:<uid> 是账号级的,
    // 拿它改名/隐藏会串到该账号的其它设备(手机上给「本机」改名,电脑上的「本机」跟着变)。
    // 管理页(侧边栏·播放器)读写一律用 instancePeerId;渲染仍用 peerId。
    out.push({ ...p, peerId, self, ...(self && masked !== peerId ? { instancePeerId: masked } : {}) });
  }
  const hidden = getHiddenPeerIds(userId);
  const overrides = getNameOverrides(userId);
  // 隐藏语义有两副面孔,由 includeHidden 决定:
  //  - 默认(切换器 / 选择器):剪掉该用户隐藏的 peer —— 隐藏即「不出现在我可选目标里」。
  //  - includeHidden(侧边栏·播放器管理页):**不剪**,改为逐条打 hidden 标记。
  //    管理页的行必须恒在(与 DLNA 设备行同构),否则「隐藏」开关一拨,行就从列表消失、
  //    再也没有落点去取消隐藏;刷新后更是无法恢复。
  // 偏好键统一取 instancePeerId ?? peerId:本机实例一律按**实例**存偏好,self 行的
  // 规范形式 local:<uid> 只用于渲染与前端的「自己那条」判定,不作为偏好键。
  const prefKey = (p: { peerId: string; instancePeerId?: string }) => p.instancePeerId ?? p.peerId;
  const rows = includeHidden ? out : out.filter((p) => !hidden.has(prefKey(p)));
  return rows.map((p) => {
    const override = overrides.get(prefKey(p));
    const named = override ? { ...p, name: override } : p;
    return includeHidden ? { ...named, hidden: hidden.has(prefKey(p)) } : named;
  });
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
    return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.forbidden.operation"), 403);
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
    return c.json(apiError(BusinessErrorCode.FORBIDDEN, "errors.forbidden.renderer"), 403);
  };
}
