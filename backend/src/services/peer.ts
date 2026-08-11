// Unified player peer manager.
//
// A "peer" is any playback target the UI/HA can switch between and control:
//   - local:<userId>  → a Web client's local playback (one per user). Audio
//                       runs on the Web client (Howl); the backend only stores
//                       the queue metadata so the user can close/reopen the
//                       tab and find their queue again.
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
// Inactivity cleanup (10-min timeout, runs every 60s):
//   - local peer:  no heartbeat for 10 min → mark unavailable + clear its
//                  local_queues row (so a stale tab doesn't keep a phantom
//                  peer alive forever).
//   - dlna peer:   device went offline (markDlnaUnavailable) for 10 min →
//                  clear its device_queues row.
//   - group peer:  permanent — never cleaned up (groups exist independent of
//                  playback).
// A peer that still has an active queue is kept (just marked unavailable) so
// the UI can show "last seen" state; only the queue is cleared on timeout.
import { EventEmitter } from "events";
import { db, sqlite } from "../db/index.js";
import { localQueues } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getQueueManager, type QueueItem, type PlayMode, type QueueSnapshot } from "./dlna/queue.js";
import { getCachedDevices } from "./dlna/control.js";
import { getEventManager } from "./dlna/eventing.js";
import { getGroupManager } from "./group/index.js";

export type PeerKind = "local" | "dlna" | "group";

export interface Peer {
  peerId: string;
  kind: PeerKind;
  name: string;
  available: boolean;
  lastActiveAt: number; // ms epoch
  userId?: string;      // local peers only
  deviceId?: string;    // dlna peers only
  groupId?: string;     // group peers only
}

export interface PeerWithQueue extends Peer {
  queue?: QueueSnapshot;
}

const INACTIVE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const CLEANUP_INTERVAL_MS = 60 * 1000;       // 1 min
// DLNA peer 保留期:设备离线超过 30 天自动移除(下次上线重新注册),防止
// 长时间运行后 peers 表里堆满「曾经在线但早已消失」的设备条目。
const DLNA_PEER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

class PeerManager extends EventEmitter {
  private peers = new Map<string, Peer>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.setMaxListeners(50);
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
      this.runCleanup();
    }, CLEANUP_INTERVAL_MS);
    // Run once shortly after boot so the peer list is populated immediately.
    setTimeout(() => { this.reconcileDlnaPeers(); this.reconcileGroupPeers(); }, 5000);
    // Bridge DLNA discovery → peer availability. Whenever the device list
    // changes (refreshDevices / SSDP sweep), re-sync the dlna peer set so the
    // switcher popup and cleanup timer see fresh availability without waiting
    // for the next 60s tick.
    getEventManager().on("device_list_changed", () => this.reconcileDlnaPeers());
  }

  // ==================== Registration ====================

  /** Register or refresh a local (Web client) peer. Returns the peer. */
  registerLocal(userId: string, name: string): Peer {
    const peerId = `local:${userId}`;
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

  /** Heartbeat: mark the peer as alive right now. */
  heartbeat(peerId: string): boolean {
    const p = this.peers.get(peerId);
    if (!p) return false;
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

  // ==================== Reconciliation ====================

  /** Sync the DLNA peer set from the device cache. New devices are registered,
   *  missing ones are marked unavailable (cleanup will clear them later). */
  reconcileDlnaPeers(): void {
    const devices = getCachedDevices();
    const seen = new Set<string>();
    for (const d of devices) {
      seen.add(d.id);
      this.registerDlna(d.id, d.name, !!d.available);
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
    const KIND_RANK: Record<PeerKind, number> = { local: 0, dlna: 1, group: 2 };
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

  /** Parse a peerId into its kind + raw id. Returns null if malformed. */
  static parse(peerId: string): { kind: PeerKind; id: string } | null {
    if (peerId.startsWith("local:")) return { kind: "local", id: peerId.slice(6) };
    if (peerId.startsWith("dlna:")) return { kind: "dlna", id: peerId.slice(5) };
    if (peerId.startsWith("group:")) return { kind: "group", id: peerId.slice(6) };
    return null;
  }

  // ==================== Queue access (unified) ====================

  /** Get the queue snapshot for a peer (local / dlna / group). */
  getQueueSnapshot(peerId: string): QueueSnapshot | undefined {
    const parsed = PeerManager.parse(peerId);
    if (!parsed) return undefined;
    if (parsed.kind === "dlna" || parsed.kind === "group") {
      // dlna 与 group 队列都归 QueueController 管,内部按裸 id 作 key。
      return getQueueManager().snapshot(parsed.id);
    }
    // local
    const row = db.select().from(localQueues).where(eq(localQueues.peerId, peerId)).get();
    if (!row) return { items: [], currentIndex: -1, playMode: "order", isActive: false, ended: false };
    try {
      return {
        items: JSON.parse(row.itemsJson || "[]") as QueueItem[],
        currentIndex: row.currentIndex,
        playMode: (row.playMode as PlayMode) || "order",
        isActive: !!row.isActive,
        ended: false,
      };
    } catch {
      return { items: [], currentIndex: -1, playMode: "order", isActive: false, ended: false };
    }
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
    this.emit("peer_queue_changed", peerId, this.getQueueSnapshot(peerId));
  }

  /** Set play mode for a local queue. */
  localSetPlayMode(peerId: string, mode: PlayMode): void {
    const now = new Date().toISOString();
    // Ensure the row exists so the mode isn't lost.
    const existing = db.select().from(localQueues).where(eq(localQueues.peerId, peerId)).get();
    if (!existing) return;
    db.update(localQueues).set({ playMode: mode, updatedAt: now }).where(eq(localQueues.peerId, peerId)).run();
    this.emit("peer_queue_changed", peerId, this.getQueueSnapshot(peerId));
  }

  /** Update currentIndex for a local peer (Web client reports track change). */
  localSetIndex(peerId: string, index: number): void {
    const now = new Date().toISOString();
    db.update(localQueues).set({ currentIndex: index, lastActiveAt: now, updatedAt: now })
      .where(eq(localQueues.peerId, peerId)).run();
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
    for (const p of this.peers.values()) {
      // group peers are permanent (groups exist independent of playback)
      if (p.kind === "group") continue;
      const idleMs = now - p.lastActiveAt;
      if (idleMs < INACTIVE_TIMEOUT_MS) continue;
      // Peer has been inactive past the threshold.
      if (p.kind === "local") {
        // Clear the local queue and mark unavailable. Keep the peer entry so
        // a returning client can re-register; just drop its stale queue.
        if (p.available || this.localQueueIsActive(p.peerId)) {
          this.localClear(p.peerId);
          p.available = false;
          this.emit("peer_unavailable", p);
          this.emit("peer_queue_cleared", p.peerId);
          console.log(`[peer] local peer ${p.peerId} inactive ${Math.round(idleMs / 1000)}s, queue cleared`);
        }
      } else {
        // dlna: only clear the device queue if the device is offline.
        if (!p.available) {
          const snap = getQueueManager().snapshot(p.deviceId!);
          if (snap && (snap.isActive || snap.items.length > 0)) {
            getQueueManager().clear(p.deviceId!);
            this.emit("peer_queue_cleared", p.peerId);
            console.log(`[peer] dlna peer ${p.peerId} offline ${Math.round(idleMs / 1000)}s, queue cleared`);
          }
          // 离线超过保留期(30 天)→ 彻底移除条目,下次上线重新注册。
          if (idleMs > DLNA_PEER_RETENTION_MS) {
            this.peers.delete(p.peerId);
            console.log(`[peer] dlna peer ${p.peerId} offline >30d, entry removed`);
          }
        }
      }
    }
  }

  private localQueueIsActive(peerId: string): boolean {
    const row = sqlite.prepare("SELECT is_active FROM local_queues WHERE peer_id = ?").get(peerId) as any;
    return !!row?.is_active;
  }
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
