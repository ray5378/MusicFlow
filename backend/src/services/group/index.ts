// 播放器群组(SyncGroup)管理服务。仿 MA sync_group provider:
//   - 组 = 多台设备的集合,组持有自己的队列(在 QueueController 接 group:<id> 后生效)
//   - 成员用带命名空间的 peer 成员 id:`airplay:<deviceId>` / `sendspin:<clientId>` /
//     `dlna:<deviceId>`/裸 id(仅历史数据可解析,新提交一律拒收 —— DLNA 已禁止入组);
//     组不能套组(`group:` 前缀拒绝)
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
import { getAirPlayStatus, hasAirPlayDevice, isAirPlayDeviceDisabled } from "../airplay/control.js";
// 命名空间导入专供 AP2 准入判据的「替身兼容」读取(见 airplaySelectable 注释):
// 命名绑定在 vi.mock 工厂缺该导出时会**抛错**,命名空间属性读取才是 undefined。
import * as airplayControlNs from "../airplay/control.js";
import { getServer as getSendspinServer } from "../sendspin/runtime.js";
import { sendspinSupervisor } from "../sendspin/supervisor.js";
import { getSendspinDeviceVolume } from "../sendspin/peerVolume.js";
import { createLogger } from "../../utils/logger.js";
import { getGroupDelays } from "./delayCalib.js";

/** 成员 kind:airplay / sendspin / dlna(仅历史数据可解析,**新提交一律拒收**,
 *  2026-10-24 起 DLNA 禁止入组 —— 设备自拉流无共享时间线)。 */
export type GroupMemberKind = "airplay" | "dlna" | "sendspin";

/** 拆成员 id 为 kind＋裸 id。`group:`/`local:` 前缀返回 null(组不能套组/含本机);
 *  含冒号但没命中任何已知前缀的**未知命名空间**同样返回 null —— 不得落进裸 id 兜底,
 *  否则会被当成 DLNA 拒收、排障时误导成「用户在加 DLNA 设备」(2026-10-26)。 */
export function splitMemberId(m: string): { kind: GroupMemberKind; id: string } | null {
  if (typeof m !== "string" || !m) return null;
  if (m.startsWith("group:") || m.startsWith("local:")) return null;
  if (m.startsWith("sendspin:")) {
    const id = m.slice("sendspin:".length);
    return id ? { kind: "sendspin", id } : null;
  }
  if (m.startsWith("airplay:")) {
    const id = m.slice("airplay:".length);
    return id ? { kind: "airplay", id } : null;
  }
  if (m.startsWith("dlna:")) {
    const id = m.slice("dlna:".length);
    return id ? { kind: "dlna", id } : null;
  }
  // 含冒号但没命中任何已知前缀 ⇒ **未知命名空间**,不是历史裸 id(裸 id 不含冒号)。
  // 必须在兜底之前返回 null:否则它会被当作 DLNA,错报文变成「DLNA 设备不支持加入群组」。
  if (m.includes(":")) return null;
  return { kind: "dlna", id: m }; // 裸 id = 历史数据,视为 DLNA(仅旧组可解析,新提交在 assertMembersAvailable 拒收)
}

const log = createLogger("group");

/** 「可选」判据的兼容封装。
 *
 *  **判据本身只有一处**:`airplay/control.ts::selectableOf`(经
 *  `isAirPlayMemberSelectable` 导出)。群组准入必须调它,不得另写一套
 *  (否则「前端过滤了、API 直调仍能塞进去」,或者两处判据漂移)。
 *
 *  这里只兜「该导出在替身里不存在」这一种情况:仓库里多条既有用例对
 *  `airplay/control.js` 用 `vi.mock` 工厂只返回少数几个导出,而 Vite 的模块替身
 *  对**未定义的导出做属性读取会直接抛错**(不是 undefined) —— 若不管,这些用例会
 *  在 import 阶段集体炸掉。生产路径永远是真实实现,永远走上面的真函数。 */
function resolveAirPlaySelectableGate(): (deviceId: string) => boolean {
  try {
    const fn = (airplayControlNs as { isAirPlayMemberSelectable?: unknown }).isAirPlayMemberSelectable;
    return typeof fn === "function" ? (fn as (deviceId: string) => boolean) : () => true;
  } catch {
    return () => true;
  }
}

const airplaySelectable: (deviceId: string) => boolean = resolveAirPlaySelectableGate();

/** 未配对 AP2 的准入文案(与 control.ts::getAirPlayCastGateError 同源语义)。 */
const AP2_PAIR_HINT = "需要先在播放器页完成 AirPlay 2 配对";

/** 新建组默认音量(用户定稿 2026-09-23):未手动改过前保持 20。 */
export const DEFAULT_GROUP_VOLUME = 20;

export interface PlayerGroup {
  id: string;
  ownerUserId: string; // 创建者;管理员可为空串(历史数据)或管理员 id
  name: string;
  memberIds: string[]; // 命名空间 id:airplay:<deviceId> / sendspin:<clientId>(裸 id 仅历史数据)
  /** 组级音量 0-100:与成员设备音量独立,空组/全离线也持久(重启恢复)。 */
  volume: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMemberInfo {
  deviceId: string;
  name: string;
  available: boolean;
  /** sendspin/airplay 成员专属:音量/静音回显(Groups 页成员迷你音量条)。
   *  离线时不缺席 —— 回退持久值,灰态仍可调,调完即持久、重连生效。
   *  dlna 成员不填,前端按存在性渲染。 */
  volume?: number;
  muted?: boolean;
}

export interface PlayerGroupWithMembers extends PlayerGroup {
  members: GroupMemberInfo[];
  /** 延迟补偿回显(ms):**正数 = 该侧更晚出声,负数 = 该侧更早出声**。
   *  只在「读视图」里带出(不写进 PlayerGroup/persist),避免与落库路径耦合。 */
  airplayDelayMs: number;
  sendspinDelayMs: number;
}

/** 读视图附加的延迟补偿字段(供前端回显;不存在即 0)。 */
function delayView(id: string): { airplayDelayMs: number; sendspinDelayMs: number } {
  const d = getGroupDelays(id);
  return { airplayDelayMs: d.airplayMs, sendspinDelayMs: d.sendspinMs };
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
    return g ? { ...g, members: this.resolveMembers(g.memberIds), ...delayView(g.id) } : undefined;
  }

  listWithMembers(): PlayerGroupWithMembers[] {
    return this.list().map(g => ({ ...g, members: this.resolveMembers(g.memberIds), ...delayView(g.id) }));
  }

  /** 某用户自己的组(含成员详情)。管理员传入空串返回全量。 */
  listWithMembersForOwner(ownerUserId: string): PlayerGroupWithMembers[] {
    return this.listForOwner(ownerUserId).map(g => ({
      ...g,
      members: this.resolveMembers(g.memberIds),
      ...delayView(g.id),
    }));
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

  /** 全量替换成员(前端勾选框提交完整列表)。设备可同时属于多个组,这里只改本组归属。
   *
   *  **只校验本次「相对现有成员新出现」的部分**(2026-10-26 修正):组里只要还剩一个历史
   *  DLNA 成员,校验全量列表就会让「加减任何成员」都 400,而有 2 个以上时逐个删也清不干净
   *  ⇒ 组被永久锁死、用户无法自救。历史成员是既有事实,不该拖累本次提交。
   *  结构与重复校验因此**显式**做在提交列表上 —— 改成只校验差集后,这两条原本由
   *  assertMembersAvailable 顺带完成的检查会漏(尤其是「已在组内的成员被重复提交」)。 */
  setMembers(id: string, memberIds: string[]): PlayerGroup | undefined {
    const g = this.groups.get(id);
    if (!g) return undefined;
    // 非数组入参(null / "abc"):不改成员、正常返回 —— 不得把字符串拆成字符塞进成员。
    if (!Array.isArray(memberIds)) return g;
    const seen = new Set<string>();
    for (const m of memberIds) {
      if (typeof m !== "string") throw new Error("成员必须是字符串 id");
      if (seen.has(m)) throw new Error("成员列表不能重复");
      seen.add(m);
    }
    const newOnes = memberIds.filter(m => !g.memberIds.includes(m));
    this.assertMembersAvailable(newOnes);
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
    // 只校验本次真正新加入的差集(added 已排除非法入参与重复项):组内历史 DLNA 成员
    // 不再让「删掉任意成员」被 400 —— 否则有 ≥2 个历史 DLNA 成员时逐个删也清不干净。
    this.assertMembersAvailable(added);
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
      if (split.kind === "airplay") {
        // airplay 成员:设备档案 + 会话态同源(与 /v1/airplay status 同一取值面)。
        const s = getAirPlayStatus(split.id);
        return { deviceId: memberId, name: s.name || split.id, available: !!s.available, volume: s.volume, muted: !!s.muted };
      }
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
      // split === null 的来源有三种:组套组/含本机(`group:`/`local:`)、未知命名空间(`foo:xxx`)、
      // 前缀后为空(`xxx:`)。文案必须中性:旧文案「不是 DLNA 设备」会把未知前缀误报成 DLNA。
      if (!split) throw new Error(`成员 ${m} 不是合法的群组成员(需 airplay:<id> 或 sendspin:<id>)`);
      if (split.kind === "sendspin") {
        // sendspin 成员只校验格式(在线状态动态解析):组可持久化,设备离线仍可建组。
        continue;
      }
      if (split.kind === "airplay") {
        // airplay 成员校验设备档案存在且未禁用(可用性动态解析,离线仍可建组)。
        if (!hasAirPlayDevice(split.id)) throw new Error(`设备 ${m} 不是已知的 AirPlay 设备`);
        if (isAirPlayDeviceDisabled(split.id)) throw new Error(`AirPlay 设备 ${m} 已被禁用`);
        // 未配对的 AP2 设备**严格禁止「新加入」**(用户规则 1)。
        // 只作用于新加入的差集:两个入口(setMembers 的 newOnes / applyMemberDelta 的 added)
        // 传进来的本来就只有差集,已在组内的成员凭据失效时不会走到这里 —— 那种情况
        // 按用户规则 2 处理:不摘组,播放回落 AP1,设备视图标「需重新配对」。
        // AP1-only 设备(supportsAp2=false)恒可用,不受此门影响(规则 3)。
        if (!airplaySelectable(split.id)) {
          throw new Error(`设备 ${m} ${AP2_PAIR_HINT}后才能加入群组`);
        }
        continue;
      }
      // dlna(含历史裸 id 写法):DLNA 设备自拉流、组内无共享时间线,2026-10-24 起禁止入组。
      throw new Error(`DLNA 设备不支持加入群组(请先从成员中移除 ${m})`);
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