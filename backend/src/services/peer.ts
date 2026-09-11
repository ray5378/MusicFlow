// Unified player peer manager.
//
// A "peer" is any playback target the UI/HA can switch between and control:
//   - local:<userId>[:<clientId>] → a client's local playback. Audio runs on
//                       the client (Howl / Flutter); the backend only stores
//                       the queue metadata so the client can close/reopen and
//                       find its queue again. The optional clientId is a
//                       client-generated *temporary* id (one per browser tab /
//                       per app install) that keeps each client instance's
//                       queue apart — several Web tabs / Flutter clients can
//                       be logged in at once without overwriting each other.
//                       The isolation is a server-side ledger only: every
//                       client still sees just its own local peer.
//   - dlna:<deviceId> → a DLNA renderer. Audio runs on the device; the backend
//                       owns the queue + auto-advance (see dlna/queue.ts).
//   - group:<groupId> → a player group (SyncGroup) that aggregates DLNA devices.
//                       It holds its own queue and fans playback out to members.
//
// The peer registry is in-memory and reconciled from three sources:
//   - Web clients register + heartbeat via /peers/:peerId/heartbeat
//   - DLNA discovery (control.ts refreshDevices) registers/refreshes dlna peers
//   - player groups (group/index.ts) register/refresh group peers
//
// Liveness vs. queue lifetime (both run every 60s):
//   - Liveness (10-min idle): a local peer with no heartbeat for 10 min is only
//     marked unavailable — its queue is NOT touched. (DLNA/AirPlay availability
//     keeps coming from discovery.)
//   - Queue reclaim (6-h idle): a queue row is reclaimed only when BOTH the
//     queue itself has not changed for 6 h AND its peer has been offline for
//     6 h. So a client that is still connected (heartbeat / discovery) keeps
//     its queue no matter how quiet it is — e.g. one song on repeat for hours
//     no longer gets wiped. The same sweep runs once right after boot, so rows
//     left behind by a container restart are reclaimed too (a peer that
//     reconnects within the grace window keeps its queue).
// Applies to local_queues, device_queues (dlna + airplay) and group_queues.
// A peer entry itself is never auto-removed (UI shows "last seen" state).
import { EventEmitter } from "events";
import { db } from "../db/index.js";
import { localQueues, users, deviceQueues, groupQueues } from "../db/schema.js";
import {
  buildLocalPeerId, clientIdOfLocalPeer, userIdOfLocalPeer,
} from "../utils/peerId.js";
import { eq } from "drizzle-orm";
import { getQueueManager, type QueueItem, type PlayMode, type QueueSnapshot } from "./dlna/queue.js";
import { getCachedDevices } from "./dlna/control.js";
import { getEventManager } from "./dlna/eventing.js";
import { getGroupManager } from "./group/index.js";
import { createLogger } from "../utils/logger.js";
import { getAirPlayDevices, onAirPlayEvent } from "./airplay/discovery.js";
import { getPreProbeScheduler, type QueuePeekSource } from "./player/preProbeScheduler.js";

const log = createLogger("peer");
export type PeerKind = "local" | "dlna" | "group" | "airplay";

export interface Peer {
  peerId: string;
  kind: PeerKind;
  name: string;
  available: boolean;
  lastActiveAt: number; // ms epoch
  userId?: string;      // local peers only
  deviceId?: string;    // dlna / airplay peers only
  groupId?: string;     // group peers only
}

export interface PeerWithQueue extends Peer {
  queue?: QueueSnapshot;
}

const PEER_IDLE_TIMEOUT_MS = 10 * 60 * 1000;      // 10 min —— 仅把 local peer 标成「不在线」
const QUEUE_TTL_MS = 6 * 60 * 60 * 1000;          // 6 h  —— 队列静默回收门槛(队列 + 播放端双条件)
const CLEANUP_INTERVAL_MS = 60 * 1000;            // 1 min
const BOOT_SWEEP_DELAY_MS = 20 * 1000;            // 启动后 20s:等发现/重连落位,再清扫陈旧队列

class PeerManager extends EventEmitter {
  private peers = new Map<string, Peer>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.setMaxListeners(50);
    // 预探测状态变化 → 本机链路用 peer_queue_changed 重发快照(快照里带 preProbe),
    // 与 QueueController 的 queue_changed 通道互不干扰(调度器已支持多监听)。
    // 只处理 local: 键 —— 投屏/组的键由 QueueController 自己广播。
    getPreProbeScheduler().addOnChange((id: string) => {
      if (!id.startsWith("local:")) return;
      this.emit("peer_queue_changed", id, this.getQueueSnapshot(id));
    });
  }

  /** Start the periodic inactivity cleanup. Call once at boot. */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    // Reconcile DLNA peers from the device cache on each tick so newly
    // discovered devices show up without waiting for a refreshDevices call.
    // Group peers are reconciled from GroupManager (availability = any member
    // online; names follow group renames).
    this.cleanupTimer = setInterval(() => {
      this.reconcileDlnaPeers();
      this.reconcileGroupPeers();
      this.reconcileAirPlayPeers();
      this.runCleanup();
    }, CLEANUP_INTERVAL_MS);
    // Run once shortly after boot so the peer list is populated immediately.
    setTimeout(() => { this.reconcileDlnaPeers(); this.reconcileGroupPeers(); this.reconcileAirPlayPeers(); }, 5000);
    // 重启清扫:容器重启后 DLNA/群组 peer 要等发现落位、本机 peer 要等客户端重连,
    // 故推迟到 20s 再跑第一轮 —— 队列「6h 未变动 + 播放端离线 6h」才回收,刚播过
    // 或刚好重连上来的队列不会被动。
    setTimeout(() => {
      try {
        this.reconcileDlnaPeers();
        this.reconcileGroupPeers();
        this.reconcileAirPlayPeers();
        this.runCleanup();
      } catch (e: any) {
        log.error(`[peer] boot queue sweep failed: ${e?.message || e}`);
      }
    }, BOOT_SWEEP_DELAY_MS);
    // Bridge DLNA discovery → peer availability. Whenever the device list
    // changes (refreshDevices / SSDP sweep), re-sync the dlna peer set so the
    // switcher popup and cleanup timer see fresh availability without waiting
    // for the next 60s tick.
    getEventManager().on("device_list_changed", () => this.reconcileDlnaPeers());
    // Bridge AirPlay discovery → peer availability in real time (mDNS
    // alive/byebye events map directly to peer registered/available/unavailable).
    onAirPlayEvent((e) => {
      if (e.type === "alive") {
        // Disabled devices stay hidden even while online (deferred to reconcile
        // so alias/disabled from persistence always win).
        this.reconcileAirPlayPeers();
      } else {
        this.markAirPlayUnavailable(e.id);
      }
    });
  }

  // ==================== Registration ====================

  /** Register or refresh a local (Web / Flutter client) peer. Returns the peer.
   *  clientId 是客户端自己生成并存在本地的临时端 ID:同一账号的多个客户端实例
   *  (多个网页标签页 / 多个 Flutter 客户端)因此各占一条独立队列,互不覆盖。
   *  不传(旧客户端)→ 退回 `local:<userId>`。 */
  registerLocal(userId: string, name: string, clientId?: string | null): Peer {
    const peerId = buildLocalPeerId(userId, clientId);
    const now = Date.now();
    let p = this.peers.get(peerId);
    if (!p) {
      p = { peerId, kind: "local", name, available: true, lastActiveAt: now, userId };
      this.peers.set(peerId, p);
      this.emit("peer_registered", p);
    } else {
      const wasAvailable = p.available;
      p.name = name;
      p.available = true;
      p.lastActiveAt = now;
      if (!wasAvailable) this.emit("peer_available", p);
    }
    return p;
  }

  /** Heartbeat: mark the peer as alive right now.
   *  服务端重启后 peer 表是空的,而客户端未必会立刻重新 register —— 这里对
   *  本机 peerId 做「就地复活」:解析出 userId/clientId 后重新登记,心跳不断则
   *  队列永远不会因静默被回收。非本机 peerId 仍返回 false(由发现流程管理)。 */
  heartbeat(peerId: string): boolean {
    let p = this.peers.get(peerId);
    if (!p) {
      const uid = userIdOfLocalPeer(peerId);
      if (!uid) return false;
      const u = db.select().from(users).where(eq(users.id, uid)).get();
      if (!u) return false;
      const revived = this.registerLocal(uid, u.username || uid, clientIdOfLocalPeer(peerId));
      if (revived.peerId !== peerId) return false;
      log.info(`[peer] revived local peer ${peerId} from heartbeat`);
      return true;
    }
    const wasAvailable = p.available;
    p.available = true;
    p.lastActiveAt = Date.now();
    if (!wasAvailable) this.emit("peer_available", p);
    return true;
  }

  /** Register or refresh a DLNA peer from discovery. */
  registerDlna(deviceId: string, name: string, available: boolean): Peer {
    const peerId = `dlna:${deviceId}`;
    const now = Date.now();
    let p = this.peers.get(peerId);
    if (!p) {
      p = { peerId, kind: "dlna", name, available, lastActiveAt: now, deviceId };
      this.peers.set(peerId, p);
      this.emit("peer_registered", p);
    } else {
      const wasAvailable = p.available;
      p.name = name;
      // Discovery is the source of truth for DLNA availability.
      p.available = available;
      if (available) p.lastActiveAt = now;
      if (available && !wasAvailable) this.emit("peer_available", p);
      else if (!available && wasAvailable) this.emit("peer_unavailable", p);
    }
    return p;
  }

  /** Mark a DLNA peer unavailable (device went offline). lastActiveAt is kept
   *  so the cleanup timer can measure the offline duration. */
  markDlnaUnavailable(deviceId: string): void {
    const peerId = `dlna:${deviceId}`;
    const p = this.peers.get(peerId);
    if (!p) return;
    if (p.available) {
      p.available = false;
      this.emit("peer_unavailable", p);
    }
  }

  // ==================== AirPlay peers ====================

  /** Register or refresh an AirPlay peer from mDNS discovery. Same shape as
   *  registerDlna — the peer registry is kind-agnostic from here on. */
  registerAirPlay(deviceId: string, name: string, available: boolean): Peer {
    const peerId = `airplay:${deviceId}`;
    const now = Date.now();
    let p = this.peers.get(peerId);
    if (!p) {
      p = { peerId, kind: "airplay", name, available, lastActiveAt: now, deviceId };
      this.peers.set(peerId, p);
      this.emit("peer_registered", p);
    } else {
      const wasAvailable = p.available;
      p.name = name;
      p.available = available;
      if (available) p.lastActiveAt = now;
      if (available && !wasAvailable) this.emit("peer_available", p);
      else if (!available && wasAvailable) this.emit("peer_unavailable", p);
    }
    return p;
  }

  /** Mark an AirPlay peer unavailable (device sent byebye / mDNS stale). */
  markAirPlayUnavailable(deviceId: string): void {
    const peerId = `airplay:${deviceId}`;
    const p = this.peers.get(peerId);
    if (!p) return;
    if (p.available) {
      p.available = false;
      this.emit("peer_unavailable", p);
    }
  }

  /** Sync the AirPlay peer set from the mDNS device map. Disabled devices are
   *  removed (hidden from switcher / HA card); display name = alias || name.
   *  Devices that fell out of the map are marked unavailable (kept, like DLNA). */
  reconcileAirPlayPeers(): void {
    const devices = getAirPlayDevices();
    const seen = new Set<string>();
    for (const d of devices) {
      seen.add(d.id);
      if (d.disabled) {
        this.removeAirPlayPeer(d.id);
        continue;
      }
      this.registerAirPlay(d.id, (d.alias || d.name).trim(), !!d.available);
    }
    for (const p of this.peers.values()) {
      if (p.kind !== "airplay" || !p.deviceId) continue;
      if (!seen.has(p.deviceId) && p.available) {
        p.available = false;
        this.emit("peer_unavailable", p);
      }
    }
  }

  /** Remove an AirPlay peer entirely (device deleted / disabled → hidden). */
  removeAirPlayPeer(deviceId: string): void {
    const peerId = `airplay:${deviceId}`;
    const p = this.peers.get(peerId);
    if (!p) return;
    if (p.available) this.emit("peer_unavailable", p);
    this.peers.delete(peerId);
  }

  /** Remove ALL AirPlay peers (AirPlay 插件关闭时调用,播放器列表不再出现)。 */
  removeAirPlayPeers(): void {
    for (const [peerId, p] of Array.from(this.peers.entries())) {
      if (p.kind === "airplay") {
        if (p.available) this.emit("peer_unavailable", p);
        this.peers.delete(peerId);
      }
    }
  }

  // ==================== Reconciliation ====================

  /** Sync the DLNA peer set from the device cache. New devices are registered,
   *  missing ones are marked unavailable. Display name = alias || SSDP name.
   *  禁用设备(disabled)不注册为 peer,也不保留已有 peer —— 它们不出现在任何
   *  选择播放器的地方(web 切换器 / Flows / HA 卡片 REST+WS)。 */
  reconcileDlnaPeers(): void {
    const devices = getCachedDevices();
    const seen = new Set<string>();
    for (const d of devices) {
      seen.add(d.id);
      if (d.disabled) {
        // 禁用:从 peer 列表移除(若之前在列表中,emit peer_unavailable → 卡片实时消失)。
        this.removeDlnaPeer(d.id);
        continue;
      }
      this.registerDlna(d.id, d.alias || d.name, !!d.available);
    }
    // Devices that vanished from the cache → mark unavailable.
    for (const p of this.peers.values()) {
      if (p.kind !== "dlna" || !p.deviceId) continue;
      if (!seen.has(p.deviceId) && p.available) {
        p.available = false;
        this.emit("peer_unavailable", p);
      }
    }
  }

  /** Remove a DLNA peer entirely (device deleted by the user in 播放器页). */
  removeDlnaPeer(deviceId: string): void {
    const peerId = `dlna:${deviceId}`;
    const p = this.peers.get(peerId);
    if (!p) return;
    if (p.available) this.emit("peer_unavailable", p);
    this.peers.delete(peerId);
  }

  /** Register or refresh a group peer. availability = 任一成员在线。 */
  registerGroup(groupId: string, name: string, available: boolean): Peer {
    const peerId = `group:${groupId}`;
    const now = Date.now();
    let p = this.peers.get(peerId);
    if (!p) {
      p = { peerId, kind: "group", name, available, lastActiveAt: now, groupId };
      this.peers.set(peerId, p);
      this.emit("peer_registered", p);
    } else {
      const wasAvailable = p.available;
      p.name = name;
      p.available = available;
      if (available) p.lastActiveAt = now;
      if (available && !wasAvailable) this.emit("peer_available", p);
      else if (!available && wasAvailable) this.emit("peer_unavailable", p);
    }
    return p;
  }

  /** Sync the group peer set from GroupManager (names + availability). */
  reconcileGroupPeers(): void {
    const groups = getGroupManager().list();
    const seen = new Set<string>();
    for (const g of groups) {
      seen.add(g.id);
      const available = g.memberIds.some(
        d => getCachedDevices().find(x => x.id === d)?.available,
      );
      this.registerGroup(g.id, g.name, available);
    }
    // Groups that vanished → remove their peer entry entirely (permanent peers,
    // no offline grace needed).
    for (const p of this.peers.values()) {
      if (p.kind !== "group" || !p.groupId) continue;
      if (!seen.has(p.groupId)) this.removeGroup(p.groupId);
    }
  }

  /** Remove a group peer (group deleted). */
  removeGroup(groupId: string): void {
    const peerId = `group:${groupId}`;
    const p = this.peers.get(peerId);
    if (!p) return;
    if (p.available) this.emit("peer_unavailable", p);
    this.peers.delete(peerId);
  }

  // ==================== Queries ====================

  list(): Peer[] {
    return Array.from(this.peers.values());
  }

  /** Peers sorted: local first, then dlna, then group by name. Includes queue snapshot. */
  listWithQueues(): PeerWithQueue[] {
    const KIND_RANK: Record<PeerKind, number> = { local: 0, dlna: 1, airplay: 1, group: 2 };
    return this.list()
      .sort((a, b) => {
        if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
        return a.name.localeCompare(b.name, "zh");
      })
      .map(p => ({ ...p, queue: this.getQueueSnapshot(p.peerId) }));
  }

  get(peerId: string): Peer | undefined {
    return this.peers.get(peerId);
  }

  /** 「对外视角」peerId → 真实 peerId。
   *  本机播放器对外只有 `local:<userId>`(临时端 ID 不出服务端),而真实行带着
   *  临时端 ID —— 这里在该用户已注册的实例里挑最近活跃的那一个;一个都没有
   *  (客户端还没连上)则原样返回,等下一轮再解析。其余 kind 原样返回。 */
  resolveVisiblePeerId(peerId: string): string {
    if (!peerId.startsWith("local:")) return peerId;
    if (this.peers.has(peerId)) return peerId;
    const uid = userIdOfLocalPeer(peerId);
    if (!uid) return peerId;
    let best: Peer | null = null;
    for (const p of this.peers.values()) {
      if (p.kind !== "local" || p.userId !== uid) continue;
      if (!best || p.lastActiveAt > best.lastActiveAt) best = p;
    }
    return best ? best.peerId : peerId;
  }

  /** Parse a peerId into its kind + raw id. Returns null if malformed. */
  static parse(peerId: string): { kind: PeerKind; id: string } | null {
    if (peerId.startsWith("local:")) return { kind: "local", id: peerId.slice(6) };
    if (peerId.startsWith("dlna:")) return { kind: "dlna", id: peerId.slice(5) };
    if (peerId.startsWith("group:")) return { kind: "group", id: peerId.slice(6) };
    if (peerId.startsWith("airplay:")) return { kind: "airplay", id: peerId.slice(8) };
    return null;
  }

  // ==================== Queue access (unified) ====================

  /** Get the queue snapshot for a peer (local / dlna / group). */
  getQueueSnapshot(peerId: string): QueueSnapshot | undefined {
    const parsed = PeerManager.parse(peerId);
    if (!parsed) return undefined;
    if (parsed.kind === "dlna" || parsed.kind === "group" || parsed.kind === "airplay") {
      // dlna / group / airplay 队列都归 QueueController 管,内部按裸 id 作 key。
      return getQueueManager().snapshot(parsed.id);
    }
    // local
    // 预探测状态位随快照下发(与投屏链路同款):本机 Web/Flutter 据此显示
    // 「大面积无源」提示,并可在推进前查判定结果(客户端仍保留失败兜底)。
    const pp = getPreProbeScheduler().status(peerId);
    const row = db.select().from(localQueues).where(eq(localQueues.peerId, peerId)).get();
    if (!row) return { items: [], currentIndex: -1, playMode: "order", isActive: false, ended: false, preProbe: pp };
    try {
      return {
        items: JSON.parse(row.itemsJson || "[]") as QueueItem[],
        currentIndex: row.currentIndex,
        playMode: (row.playMode as PlayMode) || "order",
        isActive: !!row.isActive,
        ended: false,
        preProbe: pp,
      };
    } catch {
      return { items: [], currentIndex: -1, playMode: "order", isActive: false, ended: false, preProbe: pp };
    }
  }

  // ==================== Local pre-probe (本机链路的服务端预探测)====================
  //
  // 让本机(Web / Flutter)队列也驱动服务端预探测调度器,和投屏链路共用同一颗大脑:
  // 队列一变就向前扫描,把「已确认可播 / 明确不可播」的判定写进共享缓存,客户端
  // 切歌时(经 /v1/stream/probe)零成本命中,坏源直接跳过。
  //
  // 本机队列**没有服务端洗牌序**(随机播放的顺序由客户端持有,见 SPEC:纯离线队列
  // 由客户端洗牌),故 shuffle 模式下 peekUpcomingPositions 取不到位置流 —— 这是
  // 有意为之:随机模式由客户端上报候选歌 id 走 /v1/stream/probe 取判定。order/all
  // 模式下服务端按下标预扫,效果与投屏链路一致。

  /** 从 local_queues 行构造只读 peek 源;无行/解析失败 → undefined(不扫)。 */
  private localPeekSource(peerId: string): QueuePeekSource | undefined {
    const row = db.select().from(localQueues).where(eq(localQueues.peerId, peerId)).get();
    if (!row) return undefined;
    let items: QueueItem[];
    try {
      items = JSON.parse(row.itemsJson || "[]") as QueueItem[];
    } catch {
      return undefined;
    }
    return {
      items: items.map(i => ({ songId: i.songId, duration: i.duration })),
      currentIndex: row.currentIndex,
      playMode: (row.playMode as PlayMode) || "order",
    };
  }

  /** 本机队列变动后触发一次预探测(fire-and-forget;调度器内部做防抖/冷却/合并)。 */
  private scheduleLocalPreProbe(peerId: string): void {
    getPreProbeScheduler().schedule(peerId, () => this.localPeekSource(peerId));
  }

  // ----- Local queue CRUD (dlna queues are owned by queue.ts) -----

  /** Replace the local queue and mark it active. */
  localPlayFrom(peerId: string, userId: string, items: QueueItem[], startIndex: number): void {
    const now = new Date().toISOString();
    db.insert(localQueues)
      .values({
        peerId,
        userId,
        itemsJson: JSON.stringify(items),
        currentIndex: Math.max(-1, Math.min(items.length - 1, startIndex)),
        playMode: "order",
        isActive: items.length > 0 ? 1 : 0,
        lastActiveAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: localQueues.peerId,
        set: {
          itemsJson: JSON.stringify(items),
          currentIndex: Math.max(-1, Math.min(items.length - 1, startIndex)),
          isActive: items.length > 0 ? 1 : 0,
          lastActiveAt: now,
          updatedAt: now,
        },
      })
      .run();
    this.scheduleLocalPreProbe(peerId);
    this.emit("peer_queue_changed", peerId, this.getQueueSnapshot(peerId));
  }

  /** Append items to a local queue. */
  localEnqueue(peerId: string, userId: string, items: QueueItem[]): void {
    const existing = this.getQueueSnapshot(peerId) || { items: [], currentIndex: -1, playMode: "order" as PlayMode, isActive: false };
    const merged = [...existing.items, ...items];
    let newIndex = existing.currentIndex;
    let active = existing.isActive;
    if (newIndex < 0 && merged.length > 0) { newIndex = 0; active = true; }
    const now = new Date().toISOString();
    db.insert(localQueues)
      .values({
        peerId, userId,
        itemsJson: JSON.stringify(merged),
        currentIndex: newIndex,
        playMode: existing.playMode,
        isActive: active ? 1 : 0,
        lastActiveAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: localQueues.peerId,
        set: {
          itemsJson: JSON.stringify(merged),
          currentIndex: newIndex,
          isActive: active ? 1 : 0,
          lastActiveAt: now,
          updatedAt: now,
        },
      })
      .run();
    this.scheduleLocalPreProbe(peerId);
    this.emit("peer_queue_changed", peerId, this.getQueueSnapshot(peerId));
  }

  /** Remove a single item from a local queue by index. */
  localRemoveAt(peerId: string, index: number): void {
    const snap = this.getQueueSnapshot(peerId);
    if (!snap) return;
    if (index < 0 || index >= snap.items.length) return;
    const items = [...snap.items];
    items.splice(index, 1);
    let currentIndex = snap.currentIndex;
    if (index < currentIndex) currentIndex--;
    else if (index === currentIndex) currentIndex = Math.min(currentIndex, items.length - 1);
    if (items.length === 0) { currentIndex = -1; }
    const now = new Date().toISOString();
    db.update(localQueues).set({
      itemsJson: JSON.stringify(items),
      currentIndex,
      isActive: items.length > 0 ? 1 : 0,
      lastActiveAt: now,
      updatedAt: now,
    }).where(eq(localQueues.peerId, peerId)).run();
    this.scheduleLocalPreProbe(peerId);
    this.emit("peer_queue_changed", peerId, this.getQueueSnapshot(peerId));
  }

  /** 拖拽排序:搬移一条本地队列曲目,当前曲目下标跟随到新位置。 */
  localReorder(peerId: string, from: number, to: number): void {
    const snap = this.getQueueSnapshot(peerId);
    if (!snap) return;
    if (from < 0 || from >= snap.items.length || to < 0 || to >= snap.items.length || from === to) return;
    const items = [...snap.items];
    const moved = items[from];
    items.splice(from, 1);
    items.splice(to, 0, moved);
    // 当前播放曲目跟随移动(对象引用定位新下标)
    let currentIndex = items.indexOf(snap.items[snap.currentIndex]);
    if (currentIndex < 0) currentIndex = Math.max(0, Math.min(to, items.length - 1));
    const now = new Date().toISOString();
    db.update(localQueues).set({
      itemsJson: JSON.stringify(items),
      currentIndex,
      lastActiveAt: now,
      updatedAt: now,
    }).where(eq(localQueues.peerId, peerId)).run();
    this.scheduleLocalPreProbe(peerId);
    this.emit("peer_queue_changed", peerId, this.getQueueSnapshot(peerId));
  }

  /** Clear a local queue. */
  localClear(peerId: string): void {
    const now = new Date().toISOString();
    db.update(localQueues).set({
      itemsJson: "[]",
      currentIndex: -1,
      isActive: 0,
      lastActiveAt: now,
      updatedAt: now,
    }).where(eq(localQueues.peerId, peerId)).run();
    // 队列清空 → 预探测状态一并清掉(否则快照还带着已失效的 exhausted 提示)。
    getPreProbeScheduler().clear(peerId);
    this.emit("peer_queue_changed", peerId, this.getQueueSnapshot(peerId));
  }

  /** Set play mode for a local queue. */
  localSetPlayMode(peerId: string, mode: PlayMode): void {
    const now = new Date().toISOString();
    // Ensure the row exists so the mode isn't lost.
    const existing = db.select().from(localQueues).where(eq(localQueues.peerId, peerId)).get();
    if (!existing) return;
    db.update(localQueues).set({ playMode: mode, updatedAt: now }).where(eq(localQueues.peerId, peerId)).run();
    // 播放模式变化 → 预探测窗口位置整体重算(已探过的曲复用缓存,只补缺口)。
    this.scheduleLocalPreProbe(peerId);
    this.emit("peer_queue_changed", peerId, this.getQueueSnapshot(peerId));
  }

  /** Update currentIndex for a local peer (Web client reports track change).
   *  游标一动 = 预探测窗口整体前移 → 重新扫描(滑动缓冲的「头随播放消费」)。 */
  localSetIndex(peerId: string, index: number): void {
    const now = new Date().toISOString();
    db.update(localQueues).set({ currentIndex: index, lastActiveAt: now, updatedAt: now })
      .where(eq(localQueues.peerId, peerId)).run();
    this.scheduleLocalPreProbe(peerId);
    this.emit("peer_queue_changed", peerId, this.getQueueSnapshot(peerId));
  }

  /** Persist the current media songId for a local peer (used for HA status). */
  localTouch(peerId: string): void {
    const now = new Date().toISOString();
    db.update(localQueues).set({ lastActiveAt: now, updatedAt: now })
      .where(eq(localQueues.peerId, peerId)).run();
  }

  // ==================== Cleanup ====================

  private runCleanup(): void {
    const now = Date.now();
    // 1) liveness:一台静默 10 分钟的本机播放器只标「不在线」(切歌器显示离线态),
    //    队列不动 —— 队列生命周期由下面的 6h 双条件清扫决定。
    //    DLNA/AirPlay 的可用性来自发现流程(reconcile*),不在这里改。
    for (const p of this.peers.values()) {
      if (p.kind !== "local") continue;
      if (p.available && now - p.lastActiveAt >= PEER_IDLE_TIMEOUT_MS) {
        p.available = false;
        this.emit("peer_unavailable", p);
      }
    }
    // 2) queue reclaim.
    this.sweepStaleQueues(now);
  }

  /** 队列回收:队列「6 小时未变动」且「对应播放端离线 6 小时」两个条件同时满足
   *  才清。客户端只要还连着(本机心跳 / DLNA-AirPlay 发现在线),队列无论多安静
   *  都保留 —— 单曲循环、长时间暂停都不会被误清。
   *  覆盖 local_queues / device_queues(dlna+airplay)/ group_queues;启动后也会跑
   *  一轮(重启也要清理陈旧行)。 */
  private sweepStaleQueues(now: number): void {
    // ---- 本机队列 ----
    for (const r of db.select().from(localQueues).all()) {
      if (!hasQueueItems(r.itemsJson)) continue;
      const touched = latestTs(r.updatedAt, r.lastActiveAt);
      if (now - touched < QUEUE_TTL_MS) continue;
      if (this.peerActiveWithin(r.peerId, QUEUE_TTL_MS)) continue;
      this.localClear(r.peerId);
      this.emit("peer_queue_cleared", r.peerId);
      log.info(`[peer] reclaim local queue ${r.peerId} (idle ${hours(now - touched)}h)`);
    }
    // ---- 投屏(dlna/airplay)与群组队列 ----
    const castRows: Array<{ id: string; itemsJson: string | null; updatedAt: string | null }> = [
      ...db.select().from(deviceQueues).all().map(r => ({ id: r.deviceId, itemsJson: r.itemsJson, updatedAt: r.updatedAt })),
      ...db.select().from(groupQueues).all().map(r => ({ id: r.groupId, itemsJson: r.itemsJson, updatedAt: r.updatedAt })),
    ];
    for (const r of castRows) {
      if (!hasQueueItems(r.itemsJson)) continue;
      const touched = latestTs(r.updatedAt, "");
      if (now - touched < QUEUE_TTL_MS) continue;
      const peerId = this.findPeerIdForBareId(r.id);
      // 找不到 peer 条目(设备/组已删除,或重启后尚未被重新发现)→ 视为离线。
      if (peerId && this.peerActiveWithin(peerId, QUEUE_TTL_MS)) continue;
      // clear() 停播 + 清内存队列 + 写一条空行;设备/组已被删除时(pruneOrphans 只清
      // 内存、留着 DB 行)内存里取不到 → clear() 直接 return,这里再补删 DB 行,
      // 避免陈旧行永久残留。
      getQueueManager().clear(r.id);
      deletePersistedQueue(r.id);
      if (peerId) this.emit("peer_queue_cleared", peerId);
      log.info(`[peer] reclaim ${peerId || r.id} queue (idle ${hours(now - touched)}h)`);
    }
  }

  /** 该 peer 在 windowMs 内是否「活着」:存在、可用,且最后活跃时间够新。
   *  local 的 lastActiveAt 由心跳刷新;dlna/airplay/group 由发现轮询刷新。 */
  private peerActiveWithin(peerId: string, windowMs: number): boolean {
    const p = this.peers.get(peerId);
    if (!p) return false;
    return p.available && Date.now() - p.lastActiveAt < windowMs;
  }

  /** 裸 id(deviceId / groupId)→ 它当前的 peerId(优先 dlna,其次 airplay/group)。 */
  private findPeerIdForBareId(bareId: string): string | null {
    let fallback: string | null = null;
    for (const p of this.peers.values()) {
      if (p.groupId === bareId) return p.peerId;
      if (p.deviceId === bareId) {
        if (p.kind === "dlna") return p.peerId;
        fallback = fallback || p.peerId;
      }
    }
    return fallback;
  }
}

/** 删掉设备/组队列的持久化行(group_queues 优先,其次 device_queues)。
 *  设备/组已从内存/设备表删除时 clear() 够不着,靠这一步兜底清干净。 */
function deletePersistedQueue(bareId: string): void {
  try {
    db.delete(groupQueues).where(eq(groupQueues.groupId, bareId)).run();
    db.delete(deviceQueues).where(eq(deviceQueues.deviceId, bareId)).run();
  } catch (e: any) {
    log.error(`[peer] delete persisted queue ${bareId} failed: ${e?.message || e}`);
  }
}

/** 队列 JSON 里是否真的还有条目(空队列/脏数据不参与回收)。 */
function hasQueueItems(itemsJson: string | null): boolean {
  if (!itemsJson) return false;
  const s = itemsJson.trim();
  return s !== "" && s !== "[]";
}

/** 取两个 ISO 时间戳里更晚的一个(ms);都无效 → 0。 */
function latestTs(a: string | null | undefined, b: string | null | undefined): number {
  let t = 0;
  for (const v of [a, b]) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > t) t = ms;
  }
  return t;
}

function hours(ms: number): number {
  return Math.round(ms / 3600_000);
}

let instance: PeerManager | null = null;
export function getPeerManager(): PeerManager {
  if (!instance) instance = new PeerManager();
  return instance;
}

/** Parse a peerId into its kind + raw id. Returns null if malformed. */
export function parsePeerId(peerId: string): { kind: PeerKind; id: string } | null {
  return PeerManager.parse(peerId);
}
