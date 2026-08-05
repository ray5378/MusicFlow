// 播放器群组(SyncGroup)管理服务。仿 MA sync_group provider:
//   - 组 = 多台 DLNA 设备的集合,组持有自己的队列(在 QueueController 接 group:<id> 后生效)
//   - 成员只能是 DLNA 设备(裸 deviceId);组不能套组
//   - 一台设备可同时加入多个组(如"客厅组"+ "所有设备组"),设备同一时刻只能渲染一路流,
//     多个组同时向同一设备投递时以最后一次命令为准(物理限制,非漂移校正范畴)
//   - 组名必填、非空、限长;成员用全量替换(前端勾选框提交完整列表)
//   - 成员变更通过 EventEmitter 广播(WS 推送在 ws/index.ts 订阅,前端据此刷新)
import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { playerGroups } from "../../db/schema.js";
import { getCachedDevices } from "../dlna/control.js";

export interface PlayerGroup {
  id: string;
  name: string;
  memberIds: string[]; // dlna deviceIds
  createdAt: string;
  updatedAt: string;
}

export interface GroupMemberInfo {
  deviceId: string;
  name: string;
  available: boolean;
}

export interface PlayerGroupWithMembers extends PlayerGroup {
  members: GroupMemberInfo[];
}

const GROUP_NAME_MAX = 50;

export class GroupManager extends EventEmitter {
  private groups = new Map<string, PlayerGroup>();
  // deviceId → 所属组 id 集合。多组约束:一台设备可同时加入多个组。
  private memberIndex = new Map<string, Set<string>>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** 启动时从 DB 加载全部组。 */
  loadFromDb(): void {
    this.groups.clear();
    this.memberIndex.clear();
    const rows = db.select().from(playerGroups).all();
    for (const r of rows) {
      let memberIds: string[] = [];
      try { memberIds = JSON.parse(r.memberIds || "[]"); } catch {}
      this.groups.set(r.id, {
        id: r.id,
        name: r.name,
        memberIds,
        createdAt: r.createdAt || "",
        updatedAt: r.updatedAt || "",
      });
      for (const m of memberIds) this.addToIndex(m, r.id);
    }
    console.log(`[group] loaded ${this.groups.size} player group(s) from DB`);
  }

  list(): PlayerGroup[] {
    return Array.from(this.groups.values());
  }

  get(id: string): PlayerGroup | undefined {
    return this.groups.get(id);
  }

  getWithMembers(id: string): PlayerGroupWithMembers | undefined {
    const g = this.groups.get(id);
    return g ? { ...g, members: this.resolveMembers(g.memberIds) } : undefined;
  }

  listWithMembers(): PlayerGroupWithMembers[] {
    return this.list().map(g => ({ ...g, members: this.resolveMembers(g.memberIds) }));
  }

  createGroup(name: string, memberIds: string[] = []): PlayerGroup {
    const id = uuidv4();
    this.assertMembersAvailable(memberIds);
    const now = new Date().toISOString();
    const g: PlayerGroup = { id, name: this.normalizeName(name), memberIds: [...memberIds], createdAt: now, updatedAt: now };
    this.persist(g);
    this.groups.set(id, g);
    for (const m of g.memberIds) this.addToIndex(m, id);
    this.emit("group_created", g);
    return g;
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
    // 先把本组从原成员的归属集合中移除,再校验并写回新集合(设备仍可能在别的组)。
    for (const m of g.memberIds) this.removeFromIndex(m, id);
    this.assertMembersAvailable(memberIds);
    g.memberIds = [...memberIds];
    g.updatedAt = new Date().toISOString();
    for (const m of g.memberIds) this.addToIndex(m, id);
    this.persist(g);
    this.emit("group_updated", g);
    return g;
  }

  deleteGroup(id: string): boolean {
    const g = this.groups.get(id);
    if (!g) return false;
    this.groups.delete(id);
    for (const m of g.memberIds) this.removeFromIndex(m, id);
    db.delete(playerGroups).where(eq(playerGroups.id, id)).run();
    this.emit("group_deleted", id);
    return true;
  }

  /** 设备当前属于哪些组(可多个)。 */
  groupsOfDevice(deviceId: string): string[] {
    return Array.from(this.memberIndex.get(deviceId) ?? []);
  }

  // ==================== 内部 ====================

  private addToIndex(deviceId: string, groupId: string): void {
    let s = this.memberIndex.get(deviceId);
    if (!s) { s = new Set(); this.memberIndex.set(deviceId, s); }
    s.add(groupId);
  }

  private removeFromIndex(deviceId: string, groupId: string): void {
    const s = this.memberIndex.get(deviceId);
    if (!s) return;
    s.delete(groupId);
    if (s.size === 0) this.memberIndex.delete(deviceId);
  }

  private resolveMembers(memberIds: string[]): GroupMemberInfo[] {
    const cache = new Map(getCachedDevices().map(d => [d.id, d]));
    return memberIds.map(deviceId => {
      const d = cache.get(deviceId);
      return { deviceId, name: d?.name || deviceId, available: !!d?.available };
    });
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
      if (m.startsWith("group:") || m.startsWith("local:")) {
        throw new Error(`成员 ${m} 不是 DLNA 设备`);
      }
      const known = getCachedDevices().some(d => d.id === m);
      if (!known) throw new Error(`设备 ${m} 不是已知的 DLNA 设备`);
    }
  }

  private persist(g: PlayerGroup): void {
    db.insert(playerGroups)
      .values({
        id: g.id,
        name: g.name,
        memberIds: JSON.stringify(g.memberIds),
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      })
      .onConflictDoUpdate({
        target: playerGroups.id,
        set: { name: g.name, memberIds: JSON.stringify(g.memberIds), updatedAt: g.updatedAt },
      })
      .run();
  }
}

let instance: GroupManager | null = null;
export function getGroupManager(): GroupManager {
  if (!instance) instance = new GroupManager();
  return instance;
}