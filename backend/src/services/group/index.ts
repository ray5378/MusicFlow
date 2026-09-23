// 播放器群组(SyncGroup)管理服务。仿 MA sync_group provider:
//   - 组 = 多台设备的集合,组持有自己的队列(在 QueueController 接 group:<id> 后生效)
//   - 成员用带命名空间的 peer 成员 id:`sendspin:<clientId>` / `dlna:<deviceId>` /
//     裸 id(历史数据,一律视为 DLNA);组不能套组(`group:` 前缀拒绝)
//   - 一台设备可同时加入多个组(如"客厅组"+ "所有设备组"),设备同一时刻只能渲染一路流,
//     多个组同时向同一设备投递时以最后一次命令为准(物理限制,非漂移校正范畴)
//   - 组名必填、非空、限长;成员用全量替换(前端勾选框提交完整列表)或增量
//     (applyMemberDelta,供移动端随时加减)
//   - 成员变更通过 EventEmitter 广播(WS 推送在 services/ws 订阅,前端据此刷新)
import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { playerGroups } from "../../db/schema.js";
import { getCachedDevices } from "../dlna/control.js";
import { getServer as getSendspinServer } from "../sendspin/runtime.js";
import { sendspinSupervisor } from "../sendspin/supervisor.js";
import { getSendspinDeviceVolume } from "../sendspin/peerVolume.js";
import { createLogger } from "../../utils/logger.js";

/** 成员 kind:dlna(默认,裸 id 亦属此) / sendspin。airplay/local 暂不支持进组。 */
export type GroupMemberKind = "dlna" | "sendspin";

/** 拆成员 id 为 kind＋裸 id。`group:`/`local:` 前缀返回 null(组不能套组/含本机)。 */
export function splitMemberId(m: string): { kind: GroupMemberKind; id: string } | null {
  if (typeof m !== "string" || !m) return null;
  if (m.startsWith("group:") || m.startsWith("local:")) return null;
  if (m.startsWith("sendspin:")) {
    const id = m.slice("sendspin:".length);
    return id ? { kind: "sendspin", id } : null;
  }
  if (m.startsWith("dlna:")) {
    const id = m.slice("dlna:".length);
    return id ? { kind: "dlna", id } : null;
  }
  return { kind: "dlna", id: m }; // 裸 id = 历史数据,视为 DLNA
}

const log = createLogger("group");

/** 新建组默认音量(用户定稿 2026-09-23):未手动改过前保持 20。 */
export const DEFAULT_GROUP_VOLUME = 20;

export interface PlayerGroup {
  id: string;
  ownerUserId: string; // 创建者;管理员可为空串(历史数据)或管理员 id
  name: string;
  memberIds: string[]; // dlna deviceIds
  /** 组级音量 0-100:与成员设备音量独立,空组/全离线也持久(重启恢复)。 */
  volume: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMemberInfo {
  deviceId: string;
  name: string;
  available: boolean;
  /** sendspin 成员专属:音量/静音回显(Groups 页成员迷你音量条)。
   *  离线时不缺席 —— 回退持久库值,灰态仍可调,调完即持久、重连生效。
   *  其它 kind 不填,前端按存在性渲染。 */
  volume?: number;
  muted?: boolean;
}

export interface PlayerGroupWithMembers extends PlayerGroup {
  members: GroupMemberInfo[];
}

const GROUP_NAME_MAX = 50;

export class GroupManager extends EventEmitter {
  // 组=用户级数量,成员归属查询直接全量扫描(命名空间写法下裸 id/全称都要命中,
  // 倒排索引省不下双写一致性麻烦,此处刻意不用索引)。
  private groups = new Map<string, PlayerGroup>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** 启动时从 DB 加载全部组。 */
  loadFromDb(): void {
    this.groups.clear();
    const rows = db.select().from(playerGroups).all();
    for (const r of rows) {
      let memberIds: string[] = [];
      try { memberIds = JSON.parse(r.memberIds || "[]"); } catch {}
      this.groups.set(r.id, {
        id: r.id,
        ownerUserId: r.ownerUserId || "",
        name: r.name,
        memberIds,
        volume: clampVolume(r.volume),
        createdAt: r.createdAt || "",
        updatedAt: r.updatedAt || "",
      });
    }
    log.info(`[group] loaded ${this.groups.size} player group(s) from DB`);
  }

  list(): PlayerGroup[] {
    return Array.from(this.groups.values());
  }

  /** 某用户「自己的」组(仅 ownerUserId === ownerUserId)。管理员传 all。 */
  listForOwner(ownerUserId: string): PlayerGroup[] {
    if (!ownerUserId) return [];
    return this.list().filter(g => g.ownerUserId === ownerUserId);
  }

  get(id: string): PlayerGroup | undefined {
    return this.groups.get(id);
  }

  /** 该用户是否有权操作该组(管理员恒有权;普通用户须为组 owner)。 */
  isOwnedBy(id: string, userId: string, isAdmin: boolean): boolean {
    if (isAdmin) return true;
    const g = this.groups.get(id);
    if (!g) return false;
    return g.ownerUserId === userId;
  }

  getWithMembers(id: string): PlayerGroupWithMembers | undefined {
    const g = this.groups.get(id);
    return g ? { ...g, members: this.resolveMembers(g.memberIds) } : undefined;
  }

  listWithMembers(): PlayerGroupWithMembers[] {
    return this.list().map(g => ({ ...g, members: this.resolveMembers(g.memberIds) }));
  }

  /** 某用户自己的组(含成员详情)。管理员传入空串返回全量。 */
  listWithMembersForOwner(ownerUserId: string): PlayerGroupWithMembers[] {
    return this.listForOwner(ownerUserId).map(g => ({ ...g, members: this.resolveMembers(g.memberIds) }));
  }

  createGroup(name: string, memberIds: string[] = [], ownerUserId = ""): PlayerGroup {
    const id = uuidv4();
    this.assertMembersAvailable(memberIds);
    const now = new Date().toISOString();
    const g: PlayerGroup = {
      id, ownerUserId, name: this.normalizeName(name), memberIds: [...memberIds],
      volume: DEFAULT_GROUP_VOLUME,
      createdAt: now, updatedAt: now,
    };
    this.persist(g);
    this.groups.set(id, g);
    this.emit("group_created", g);
    return g;
  }

  /** 读组音量(缺省 DEFAULT_GROUP_VOLUME;组不存在也返回缺省,供 status 回显)。 */
  getVolume(id: string): number {
    return this.groups.get(id)?.volume ?? DEFAULT_GROUP_VOLUME;
  }

  /** 写组音量并落库。**无成员也持久** —— 空组调完重启仍恢复。
   *  返回实际生效值(非法入参回退当前/缺省)。 */
  setVolume(id: string, vol: number): number {
    const g = this.groups.get(id);
    const next = clampVolume(vol);
    if (!g) return next; // 组不存在:无处可写,返回钳后值(路由层仍会先落 try)
    if (g.volume === next) return next;
    g.volume = next;
    g.updatedAt = new Date().toISOString();
    this.persist(g);
    this.emit("group_updated", g);
    return next;
  }

  renameGroup(id: string, name: string): PlayerGroup | undefined {
    const g = this.groups.get(id);
    if (!g) return undefined;
    g.name = this.normalizeName(name);
    g.updatedAt = new Date().toISOString();
    this.persist(g);
    this.emit("group_updated", g);
    return g;
  }

  /** 全量替换成员(前端勾选框提交完整列表)。设备可同时属于多个组,这里只改本组归属。 */
  setMembers(id: string, memberIds: string[]): PlayerGroup | undefined {
    const g = this.groups.get(id);
    if (!g) return undefined;
    this.assertMembersAvailable(memberIds);
    g.memberIds = [...memberIds];
    g.updatedAt = new Date().toISOString();
    this.persist(g);
    this.emit("group_updated", g);
    return g;
  }

  /** 增量变更成员(移动端随时加减):先删后加,结果去重保序(原成员相对顺序不变,
   *  新增 append)。PUT 全量替换与新增 delta 口都走这里,语义单源。
   *  返回实际生效的 added/removed(已在组内的 add / 不在组内的 remove 为 no-op)。 */
  applyMemberDelta(
    id: string,
    delta: { add?: string[]; remove?: string[] },
  ): { group: PlayerGroup; added: string[]; removed: string[] } | undefined {
    const g = this.groups.get(id);
    if (!g) return undefined;
    const add = Array.isArray(delta.add) ? delta.add : [];
    const remove = Array.isArray(delta.remove) ? delta.remove : [];
    const removeSet = new Set(remove);
    const kept = g.memberIds.filter(m => !removeSet.has(m));
    const removed = g.memberIds.filter(m => removeSet.has(m));
    const keptSet = new Set(kept);
    const added: string[] = [];
    for (const m of add) {
      if (typeof m !== "string" || keptSet.has(m)) continue; // 非法/已在组内按 no-op 跳过
      keptSet.add(m);
      kept.push(m);
      added.push(m);
    }
    this.assertMembersAvailable(kept);
    g.memberIds = kept;
    g.updatedAt = new Date().toISOString();
    this.persist(g);
    this.emit("group_updated", g);
    return { group: g, added, removed };
  }

  deleteGroup(id: string): boolean {
    const g = this.groups.get(id);
    if (!g) return false;
    this.groups.delete(id);
    db.delete(playerGroups).where(eq(playerGroups.id, id)).run();
    this.emit("group_deleted", id);
    return true;
  }

  /** 设备当前属于哪些组(可多个)。deviceId 可为裸 id 或命名空间 id,
   *  按裸 id 比对(成员两种写法都命中)。 */
  groupsOfDevice(deviceId: string): string[] {
    const bare = splitMemberId(deviceId)?.id ?? deviceId;
    const out: string[] = [];
    for (const [gid, g] of this.groups) {
      if (g.memberIds.some(m => splitMemberId(m)?.id === bare)) out.push(gid);
    }
    return out;
  }

  // ==================== 内部 ====================

  /** 解析全部成员的展示信息(名称/可用性/sendspin 音量)。
   *
   *  **对外公开:这是「成员在线判定」的单一真相源。**
   *  成员 id 带命名空间(`sendspin:<clientId>` / `dlna:<deviceId>` / 裸 id≡DLNA),
   *  必须按 kind 分派到各自的设备源 —— sendspin 成员**不在** DLNA 设备缓存里,
   *  拿成员 id 去 `getCachedDevices()` 查永远 miss ⇒ 会被误判成离线。
   *  peer 层的「群组是否可用」(`PeerManager.reconcileGroupPeers`)必须复用本方法,
   *  不得另写一套(曾经就是那样:只查 DLNA 缓存 ⇒ 非 DLNA 群组恒被标离线,
   *  「流转播放」选择器直接把整行剪掉,群组用不了)。 */
  resolveMemberStates(memberIds: string[]): GroupMemberInfo[] {
    return this.resolveMembers(memberIds);
  }

  private resolveMembers(memberIds: string[]): GroupMemberInfo[] {
    const cache = new Map(getCachedDevices().map(d => [d.id, d]));
    return memberIds.map(memberId => {
      const split = splitMemberId(memberId);
      if (!split) return { deviceId: memberId, name: memberId, available: false };
      if (split.kind === "sendspin") return { deviceId: memberId, ...this.resolveSendspinMember(split.id) };
      const d = cache.get(split.id);
      return { deviceId: memberId, name: d ? (d.alias || d.name) : memberId, available: !!d?.available };
    });
  }

  /** sendspin 成员展示信息:in-proc 读真实 server,fork 读 supervisor 镜像,
   *  都没有(服务未运行)则离线占位 —— 组可持久化,成员在线状态动态解析。
   *  音量/静音一并回显(实时优先、离线回退持久库值,见 getSendspinDeviceVolume)。 */
  private resolveSendspinMember(clientId: string): { name: string; available: boolean; volume: number; muted: boolean } {
    // 与 peer 列表 / /status 同源取值:在线取组实时值,离线取 sendspin_device_state。
    const vol = getSendspinDeviceVolume(clientId);
    try {
      const srv = getSendspinServer();
      if (srv) {
        const c = srv.clients.get(clientId);
        if (c) return { name: (c as any).name || clientId, available: (c as any).ready !== false, volume: vol.volume, muted: vol.muted };
      }
      if (sendspinSupervisor.isRunning()) {
        const mc = sendspinSupervisor.mirror.clients.get(clientId);
        if (mc) return { name: (mc as any).name || clientId, available: (mc as any).ready !== false, volume: vol.volume, muted: vol.muted };
      }
    } catch { /* 解析失败即离线占位 */ }
    return { name: clientId, available: false, volume: vol.volume, muted: vol.muted };
  }

  /** 从所有群组中移除一台设备(删除设备时调用),并持久化+广播。
   *  deviceId 可为裸 id 或命名空间 id,按裸 id 比对(两种写法都清掉)。 */
  removeDeviceFromAllGroups(deviceId: string): void {
    const bare = splitMemberId(deviceId)?.id ?? deviceId;
    for (const [groupId, g] of this.groups) {
      const before = g.memberIds;
      const after = before.filter(m => splitMemberId(m)?.id !== bare);
      if (after.length === before.length) continue;
      g.memberIds = after;
      g.updatedAt = new Date().toISOString();
      this.persist(g);
      this.emit("group_updated", g);
    }
  }

  private normalizeName(name: string): string {
    const trimmed = (name || "").trim();
    if (!trimmed) throw new Error("组名不能为空");
    if (trimmed.length > GROUP_NAME_MAX) throw new Error(`组名不能超过 ${GROUP_NAME_MAX} 个字符`);
    return trimmed;
  }

  private assertMembersAvailable(memberIds: string[]): void {
    const normalized = Array.isArray(memberIds) ? memberIds : [];
    const seen = new Set<string>();
    for (const m of normalized) {
      if (typeof m !== "string") throw new Error("成员必须是字符串 id");
      if (seen.has(m)) throw new Error("成员列表不能重复");
      seen.add(m);
      const split = splitMemberId(m);
      // 组不能套组/含本机/airplay 暂不支持进组(旧报错口径保留)。
      if (!split) throw new Error(`成员 ${m} 不是 DLNA 设备`);
      if (split.kind === "sendspin") {
        // sendspin 成员只校验格式(在线状态动态解析):组可持久化,设备离线仍可建组。
        continue;
      }
      const known = getCachedDevices().some(d => d.id === split.id);
      if (!known) throw new Error(`设备 ${m} 不是已知的 DLNA 设备`);
    }
  }

  private persist(g: PlayerGroup): void {
    db.insert(playerGroups)
      .values({
        id: g.id,
        ownerUserId: g.ownerUserId || "",
        name: g.name,
        memberIds: JSON.stringify(g.memberIds),
        volume: g.volume,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      })
      .onConflictDoUpdate({
        target: playerGroups.id,
        set: {
          ownerUserId: g.ownerUserId || "",
          name: g.name,
          memberIds: JSON.stringify(g.memberIds),
          volume: g.volume,
          updatedAt: g.updatedAt,
        },
      })
      .run();
  }
}

/** 钳到 0-100 整数;非法/缺失回缺省。 */
function clampVolume(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_GROUP_VOLUME;
  return Math.min(100, Math.max(0, Math.round(v)));
}

let instance: GroupManager | null = null;
export function getGroupManager(): GroupManager {
  if (!instance) instance = new GroupManager();
  return instance;
}