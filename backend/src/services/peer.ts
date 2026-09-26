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
//   - Liveness (2-min idle by default, configurable via `peer_idle_minutes`): a
//     local peer with no heartbeat past the threshold is only marked unavailable
//     — its queue is NOT touched. Closing a tab is normally detected instantly
//     from the last WebSocket close (see markLocalOfflineByClient); this sweep is
//     the backstop for crashes / network drops where no FIN ever arrives.
//     (DLNA/AirPlay availability keeps coming from discovery.)
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
  buildLocalPeerId, clientIdOfLocalPeer, userIdOfLocalPeer, instanceKeyOfLocalPeer,
} from "../utils/peerId.js";
import { eq } from "drizzle-orm";
import { getQueueManager, type QueueItem, type PlayMode, type QueueSnapshot } from "./dlna/queue.js";
import { getCachedDevices } from "./dlna/control.js";
import { getEventManager } from "./dlna/eventing.js";
import { getGroupManager } from "./group/index.js";
import { createLogger } from "../utils/logger.js";
import { getAirPlayDevices, onAirPlayEvent } from "./airplay/discovery.js";
import { getPreProbeScheduler, type QueuePeekSource } from "./player/preProbeScheduler.js";
import { getSetting } from "./settings.js";

const log = createLogger("peer");
export type PeerKind = "local" | "dlna" | "group" | "airplay" | "sendspin";

export interface Peer {
  peerId: string;
  kind: PeerKind;
  name: string;
  available: boolean;
  lastActiveAt: number; // ms epoch
  userId?: string;      // local peers only
  deviceId?: string;    // dlna / airplay / sendspin peers only
  groupId?: string;     // group peers only
  /** 组成员 id 快照（group peers only）。三端据此判断「哪些设备正被组托管」；
   *  出口层的 `managedByGroup` 由它反推。裸 id ≡ DLNA（历史数据）。 */
  memberIds?: string[];
  /** 成员总数 / 在线数（group peers only）。空组（memberCount=0）与成员全离线组
   *  **仍然保留在列表里** —— 组是容器，剪掉就再也找不到、没法把设备拖进去；
   *  两者靠这两个数字在行上渲染状态，而不是靠 available 决定存亡。 */
  memberCount?: number;
  onlineCount?: number;
  unencrypted?: boolean; // sendspin legacy 明文客户端(无 Noise,配对不可用)
  /** sendspin 音量/静音快照(列表与 peer_snapshot 回显用;离线时为持久值)。
   *  其它 kind 暂不填,前端按存在性渲染。由 attachSendspinPeerVolumes 填充。 */
  volume?: number;
  muted?: boolean;
  /**
   * 设备名片(2026-09-15,本机 peer 才有):客户端注册时上报。
   *  - `platform`:android / windows / web / ios / macos ... —— 前端据此把本机实例
   *    分进「客户端」或「Web 播放器」模块;
   *  - `model`:安卓机型名 / Windows 电脑名;网页取不到(浏览器硬限制)时缺省。
   * 旧客户端不上报 → 两者皆 undefined,前端退回「本机播放」兜底,行为不变。
   */
  platform?: string;
  model?: string;
}

export interface PeerWithQueue extends Peer {
  queue?: QueueSnapshot;
}

/**
 * 本机实例的实时播放状态上报(内存,进程内;见 PeerManager.reportLocalStatus)。
 *
 * 状态/进度/音量的权威在客户端本地播放器,服务端只做「暂存 + 回吐」,供**别的**
 * 播放端轮询 /status 时镜像进度条与播放按钮。
 */
export interface LocalPlaybackReport {
  /** 对齐 DLNA/UPnP 的传输状态口径,前端 poll 直接照读。 */
  state: "PLAYING" | "PAUSED_PLAYBACK" | "STOPPED";
  /** 秒(浮点)。 */
  position: number;
  /** 秒(浮点);未知为 0。 */
  duration: number;
  /** 0-100(与前端 / DLNA 音量同量纲);未上报则缺省。 */
  volume?: number;
  /** 当前曲 id;供对端轮询到切歌时刷新歌词 / 封面。 */
  songId?: string;
  /** 本地接收时刻(ms epoch),用于 TTL 判定。 */
  reportedAt: number;
}

// 本机播放端「多久没心跳就算离线」的缺省值(分钟)。
// 关掉页面时后端本可以靠 WS close 秒级感知(见 markLocalOfflineByClient);这里只是
// **兜底** —— 兜住断网、崩溃、休眠唤醒等「没打招呼就消失」的情况(WS 半开时 TCP 不会
// 立刻报 FIN)。原值 10 分钟偏长,切歌器里会残留一条已关闭的 Web 播放器。
const DEFAULT_PEER_IDLE_MINUTES = 2;
const QUEUE_TTL_MS = 6 * 60 * 60 * 1000;          // 6 h  —— 队列静默回收门槛(队列 + 播放端双条件)
const CLEANUP_INTERVAL_MS = 60 * 1000;            // 1 min
const BOOT_SWEEP_DELAY_MS = 20 * 1000;            // 启动后 20s:等发现/重连落位,再清扫陈旧队列

/** 读「本机播放端心跳空闲门槛」(分钟 → ms)。可配:设置项 `peer_idle_minutes`,
 *  读不到/非法值回退缺省 2 分钟。与 reclaim.ts 的 idleMinutes() 同款读法。
 *  (导出以便测试直接锁定「可配 + 非法值回退」契约。) */
export function peerIdleTimeoutMs(): number {
  const v = parseInt(getSetting("peer_idle_minutes", String(DEFAULT_PEER_IDLE_MINUTES)), 10);
  const mins = Number.isFinite(v) && v > 0 ? v : DEFAULT_PEER_IDLE_MINUTES;
  return mins * 60 * 1000;
}

export class PeerManager extends EventEmitter {
  private peers = new Map<string, Peer>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 本机队列的「起播起始位置」(秒)—— **一次性**、只跟随**当次**广播带出。
   *
   * 为什么不是持久化列:它是「这一刻刚流转过来的起点」,不是队列属性;
   * 落库会让之后每次轮询/重启恢复都带着它,表现为每次回到同一位置。
   * 为什么不是服务端直接 seek:本机端的播放器(just_audio / Howl)活在客户端
   * 进程里,服务端只能下令,而「下令」在客户端还没起播时会落空 —— 起点随
   * 快照交出去,客户端起播后自行落位,因果才闭合(见 localPlayFrom)。
   */
  private pendingStartPosition = new Map<string, number>();

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
   *  不传(旧客户端)→ 退回 `local:<userId>`。
   *  platform/model 是**设备名片**(可选):前端据此把本机实例分进「客户端」/
   *  「Web 播放器」模块并按视角显示名字。旧客户端不传 → 保持 undefined。 */
  registerLocal(
    userId: string,
    name: string,
    clientId?: string | null,
    platform?: string | null,
    model?: string | null,
  ): Peer {
    const peerId = buildLocalPeerId(userId, clientId);
    const now = Date.now();
    let p = this.peers.get(peerId);
    if (!p) {
      p = {
        peerId, kind: "local", name, available: true, lastActiveAt: now, userId,
        platform: platform || undefined,
        model: model || undefined,
      };
      this.peers.set(peerId, p);
      this.emit("peer_registered", p);
    } else {
      const wasAvailable = p.available;
      p.name = name;
      // 名片可空上报:只在有新值时覆盖,避免旧客户端把已登记的名片抹掉。
      if (platform) p.platform = platform;
      if (model) p.model = model;
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

  /** 把一台本机播放端标成离线,并顺手清掉**只跟「有人在听」相关**的内存态。
   *
   *  清理范围严格限定为「页面关掉后还在空转的东西」——目前是预探测状态:
   *  没人听了还继续探测下一首纯属白烧 CPU/网络,回来时会重新调度。
   *
   *  **队列一律不动**:`local_queues` 是服务端权威数据,它的生命周期与页面开不开
   *  无关(关掉页面只是「没人听了」,不等于这个端的播放列表作废)。重开标签页靠
   *  稳定的 clientId 认领回同一条队列。
   */
  private markLocalOffline(p: Peer): void {
    if (!p.available) return;
    p.available = false;
    try { getPreProbeScheduler().clear(p.peerId); } catch { /* 预探测清理失败不阻断下线 */ }
    this.emit("peer_unavailable", p);
  }

  /** WS 断开即离线:该 (userId, clientId) 的**最后一条** WS 连接关闭时,立即把
   *  对应本机实例标成「不在线」并广播 peer_unavailable —— 不等心跳空闲扫描,
   *  否则客户端切换器里会残留一条已关闭的 Web 播放器/客户端(用户实测:
   *  关掉网页后最长 10 分钟内仍显示在线)。队列不动,重开标签页照常恢复。 */
  markLocalOfflineByClient(userId: string, clientId: string): void {
    if (!userId || !clientId) return;
    const peerId = `local:${userId}:${clientId}`;
    const p = this.peers.get(peerId);
    if (!p || p.kind !== "local" || !p.available) return;
    log.info(`[peer] local peer ${peerId} marked offline (last ws connection closed)`);
    this.markLocalOffline(p);
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

  // ==================== Sendspin peers ====================

  /** Register or refresh a Sendspin peer when a client activates. Same shape as
   *  registerDlna — the peer registry is kind-agnostic from here on. A Sendspin
   *  client is a server-role playback target: once paired/activated it is a
   *  controllable player exactly like a DLNA/AirPlay renderer. */
  registerSendspin(clientId: string, name: string, available: boolean, unencrypted = false): Peer {
    const peerId = `sendspin:${clientId}`;
    const now = Date.now();
    let p = this.peers.get(peerId);
    if (!p) {
      p = { peerId, kind: "sendspin", name, available, lastActiveAt: now, deviceId: clientId, unencrypted: unencrypted || undefined };
      this.peers.set(peerId, p);
      this.emit("peer_registered", p);
    } else {
      const wasAvailable = p.available;
      p.name = name;
      p.available = available;
      p.unencrypted = unencrypted || undefined;
      if (available) p.lastActiveAt = now;
      if (available && !wasAvailable) this.emit("peer_available", p);
      else if (!available && wasAvailable) this.emit("peer_unavailable", p);
    }
    return p;
  }

  /** Remove a Sendspin peer entirely (client disconnected / plugin stopped). */
  removeSendspinPeer(clientId: string): void {
    const peerId = `sendspin:${clientId}`;
    const p = this.peers.get(peerId);
    if (!p) return;
    if (p.available) this.emit("peer_unavailable", p);
    this.peers.delete(peerId);
  }

  /** Remove ALL Sendspin peers (Sendspin 插件关闭时调用,播放器列表不再出现)。 */
  removeSendspinPeers(): void {
    for (const [peerId, p] of Array.from(this.peers.entries())) {
      if (p.kind === "sendspin") {
        if (p.available) this.emit("peer_unavailable", p);
        this.peers.delete(peerId);
      }
    }
  }

  /** 广播某 sendspin 设备(或用户组)的音量/静音变化 —— 写成功后由路由调用。
   *  本方法只 emit,不做可见性过滤:WS 层按 peerVisibleTo 逐连接转发
   *  (与 peer_queue_changed / peer_registered 等同款),避免把变化泄漏给无权用户。 */
  notifyPeerVolume(peerId: string, volume: number, muted: boolean): void {
    if (!peerId) return;
    this.emit("peer_volume_changed", peerId, volume, muted);
  }

  // ==================== Reconciliation ====================

  /** Sync the DLNA peer set from the device cache. New devices are registered,
   *  missing ones are marked unavailable. Display name = alias || SSDP name.
   *  禁用设备(disabled)不注册为 peer,也不保留已有 peer —— 它们不出现在任何
   *  流转播放的入口(web 切换器 / Flows / HA 卡片 REST+WS)。 */
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

  /** Register or refresh a group peer. availability = 任一成员在线。
   *  `memberIds` / `onlineCount` 一并落进行里：出口层靠它反推「哪些设备被组托管」，
   *  三端靠 `memberCount`/`onlineCount` 渲染「空组 / 成员全离线」——
   *  组恒可见的前提是「状态能从行本身读出来」，而不是靠 available 定生死。 */
  registerGroup(groupId: string, name: string, available: boolean, memberIds: string[] = [], onlineCount = 0): Peer {
    const peerId = `group:${groupId}`;
    const now = Date.now();
    let p = this.peers.get(peerId);
    if (!p) {
      p = { peerId, kind: "group", name, available, lastActiveAt: now, groupId, memberIds: [...memberIds], memberCount: memberIds.length, onlineCount };
      this.peers.set(peerId, p);
      this.emit("peer_registered", p);
    } else {
      const wasAvailable = p.available;
      p.name = name;
      p.available = available;
      p.memberIds = [...memberIds];
      p.memberCount = memberIds.length;
      p.onlineCount = onlineCount;
      if (available) p.lastActiveAt = now;
      if (available && !wasAvailable) this.emit("peer_available", p);
      else if (!available && wasAvailable) this.emit("peer_unavailable", p);
    }
    return p;
  }

  /** Sync the group peer set from GroupManager (names + availability + member stats). */
  reconcileGroupPeers(): void {
    const gm = getGroupManager();
    const groups = gm.list();
    const seen = new Set<string>();
    for (const g of groups) {
      seen.add(g.id);
      // 组是「容器」不是设备:**可用性恒为在线**,不随成员上下线波动 ——
      // 空组、成员全离线的组也显示在线(用户定稿 2026-09-23:组恒在线)。
      // 成员各自的在线状态由 resolveMemberStates(命名空间分派的唯一真相源)
      // 汇总为 onlineCount,供前端展示「x/y 在线」,但不影响组行可用性。
      // 历史:①曾只查 DLNA 缓存 ⇒ 非 DLNA 组恒离线、无法接入播放;
      // ②后改「至少一个成员在线」⇒ 空组/成员离线时组显示离线 ——
      // 两版都把「容器在线」误当成「内容物在线」。
      const states = gm.resolveMemberStates(g.memberIds);
      const onlineCount = states.filter(m => m.available).length;
      this.registerGroup(g.id, g.name, true, g.memberIds, onlineCount);
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
    const KIND_RANK: Record<PeerKind, number> = { local: 0, dlna: 1, sendspin: 1, airplay: 1, group: 2 };
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

  /** 实例键 → 该用户那条本机 peer 的真实 peerId(对外打码形式的逆查)。
   *  入口解码用:客户端持 `local:<userId>:<instanceKey>`,服务端据此找回真实行,
   *  从而可以对**同账号的任意实例**发指令,而不只是自己那条。找不到 → null。 */
  resolveMaskedLocalPeerId(userId: string, instanceKey: string): string | null {
    if (!userId || !instanceKey) return null;
    for (const p of this.peers.values()) {
      if (p.kind !== "local" || p.userId !== userId) continue;
      if (instanceKeyOfLocalPeer(p.peerId) === instanceKey) return p.peerId;
    }
    return null;
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
    if (peerId.startsWith("sendspin:")) return { kind: "sendspin", id: peerId.slice(9) };
    return null;
  }

  // ==================== Queue access (unified) ====================

  /** 本机队列的**内存态**洗牌序列(对齐 QueueController 的投屏同款语义)。
   *  SPEC(2026-09-10,player/types.ts):洗牌序列唯一权威在服务端,客户端只做
   *  镜像 —— 此前只有投屏队列实现了,本机队列漏掉。现在补齐:
   *  惰性物化(缺/长度变了自动重建 keepCurrent),epoch 每次重建 +1 供客户端
   *  检测序列换版。服务端重启 → 内存丢失 → 下次访问重建(新 epoch,客户端
   *  据此重新定位当前曲在序列中的位置)。 */
  private localShuffle = new Map<string, { order: number[]; pos: number; len: number; epoch: number }>();

  /** Fisher-Yates(与 QueueController.rebuildShuffle 同款):keepCurrent 时
   *  当前曲固定在序列头、pos=0(上一首可沿序列回退);否则 pos=-1。 */
  private rebuildLocalShuffle(peerId: string, currentIndex: number, len: number, keepCurrent: boolean): { order: number[]; pos: number; len: number; epoch: number } {
    const idxs: number[] = [];
    for (let i = 0; i < len; i++) {
      if (keepCurrent && i === currentIndex) idxs.unshift(i);
      else idxs.push(i);
    }
    for (let i = 1; i < idxs.length; i++) {
      const j = 1 + Math.floor(Math.random() * i);
      [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
    }
    const prev = this.localShuffle.get(peerId);
    const entry = {
      order: idxs,
      pos: keepCurrent && currentIndex >= 0 ? 0 : -1,
      len,
      epoch: (prev?.epoch ?? 0) + 1,
    };
    this.localShuffle.set(peerId, entry);
    return entry;
  }

  private ensureLocalShuffle(peerId: string, currentIndex: number, len: number): { order: number[]; pos: number; len: number; epoch: number } {
    const entry = this.localShuffle.get(peerId);
    if (entry && entry.len === len) return entry;
    return this.rebuildLocalShuffle(peerId, currentIndex, len, true);
  }

  /** 显式重洗(客户端在序列尾回绕时调用):全新序列,keepCurrent=false。 */
  reshuffleLocal(peerId: string): QueueSnapshot | undefined {
    const row = db.select().from(localQueues).where(eq(localQueues.peerId, peerId)).get();
    if (!row) return undefined;
    let items: QueueItem[] = [];
    try { items = JSON.parse(row.itemsJson || "[]") as QueueItem[]; } catch { /* keep empty */ }
    if (items.length > 0) this.rebuildLocalShuffle(peerId, row.currentIndex, items.length, false);
    this.scheduleLocalPreProbe(peerId);
    const snap = this.getQueueSnapshot(peerId);
    if (snap) this.emit("peer_queue_changed", peerId, snap);
    return snap;
  }

  /** Get the queue snapshot for a peer (local / dlna / group). */
  getQueueSnapshot(peerId: string): QueueSnapshot | undefined {
    const parsed = PeerManager.parse(peerId);
    if (!parsed) return undefined;
    if (parsed.kind === "dlna" || parsed.kind === "group" || parsed.kind === "airplay" || parsed.kind === "sendspin") {
      // dlna / group / airplay / sendspin 队列都归 QueueController 管,内部按裸 id 作 key。
      return getQueueManager().snapshot(parsed.id);
    }
    // local
    // 预探测状态位随快照下发(与投屏链路同款):本机 Web/Flutter 据此显示
    // 「大面积无源」提示,并可在推进前查判定结果(客户端仍保留失败兜底)。
    const pp = getPreProbeScheduler().status(peerId);
    const row = db.select().from(localQueues).where(eq(localQueues.peerId, peerId)).get();
    if (!row) return { items: [], currentIndex: -1, playMode: "order", isActive: false, ended: false, updatedAt: 0, preProbe: pp };
    try {
      const items = JSON.parse(row.itemsJson || "[]") as QueueItem[];
      const playMode = (row.playMode as PlayMode) || "order";
      // updatedAt:供客户端启动恢复做「本地会话 vs 服务端队列」新鲜度竞速
      // (本地会话文件可能因历史 bug 整体陈旧,无脑信任本地会反杀服务端新队列)。
      const updatedAt = Date.parse(row.updatedAt || "") || 0;
      // shuffle 模式下发服务端权威洗牌序列(对齐 SPEC;单曲/更少无需序列)。
      if (playMode === "shuffle" && items.length > 1) {
        const sh = this.ensureLocalShuffle(peerId, row.currentIndex, items.length);
        const sp1 = this.pendingStartPosition.get(peerId);
        return {
          items, currentIndex: row.currentIndex, playMode,
          isActive: !!row.isActive, ended: false, updatedAt, preProbe: pp,
          shuffleOrder: sh.order, shufflePos: sh.pos, shuffleEpoch: sh.epoch,
          ...(sp1 !== undefined ? { startPosition: sp1 } : {}),
        };
      }
      const sp2 = this.pendingStartPosition.get(peerId);
      return {
        items, currentIndex: row.currentIndex, playMode,
        isActive: !!row.isActive, ended: false, updatedAt, preProbe: pp,
        ...(sp2 !== undefined ? { startPosition: sp2 } : {}),
      };
    } catch {
      return { items: [], currentIndex: -1, playMode: "order", isActive: false, ended: false, updatedAt: 0, preProbe: pp };
    }
  }

  // ==================== 本机实例播放状态上报(内存账本)====================
  //
  // 本机播放的「是否在播 / 播到第几秒 / 音量」权威在客户端(Web 的 Howl、Flutter 的
  // just_audio),服务端只持有队列元数据(见 getQueueSnapshot)—— 光靠队列快照答不出
  // 传输状态。当**另一个**播放端(Web / HA / 另一台客户端)遥控这台本机实例时,它靠
  // 轮询 `GET /v1/peers/:peerId/status` 镜像进度条与播放按钮;没有这份上报,轮询只能
  // 读到队列快照,进度条恒为 0、按钮恒显示未播放 —— 遥控就变成了盲操。
  //
  // 所以本端按「事件(播放/暂停/切歌)+ 播放中周期」上报,服务端进程内存着,读
  // /status 时回吐。**只存内存**:它是瞬时状态,重启后由下一次上报自然补齐;TTL 兜底
  // 掉线端,避免僵尸端永远显示「播放中」。
  private localReports = new Map<string, LocalPlaybackReport>();

  /** 上报有效期:超过此窗口没再上报,视为该端已离线/不再播放(读时忽略)。 */
  private static readonly LOCAL_REPORT_TTL_MS = 30_000;

  /** 记录一次本机实例的状态上报(字段级合并:未给的字段沿用上次)。 */
  reportLocalStatus(
    peerId: string,
    patch: Partial<Omit<LocalPlaybackReport, "reportedAt">>,
  ): LocalPlaybackReport | undefined {
    const parsed = PeerManager.parse(peerId);
    if (!parsed || parsed.kind !== "local") return undefined;
    const prev = this.localReports.get(peerId);
    const state = patch.state ?? prev?.state ?? "STOPPED";
    const report: LocalPlaybackReport = {
      state,
      position: typeof patch.position === "number" && patch.position >= 0
        ? patch.position : (prev?.position ?? 0),
      duration: typeof patch.duration === "number" && patch.duration >= 0
        ? patch.duration : (prev?.duration ?? 0),
      volume: typeof patch.volume === "number"
        ? Math.max(0, Math.min(100, patch.volume)) : prev?.volume,
      // STOPPED = 没有当前曲,一律清空 songId。
      //
      // 这里是**字段级合并**(省略的字段沿用上次),而客户端停止时根本不发 songId
      // 字段(Flutter: `if (songId != null && songId.isNotEmpty) 'songId': songId`)。
      // 沿用旧值 = 已停止的端在 GET /status 里永远挂着上一首 —— 对端据此刷新
      // 封面/歌词,表现为「这台还在播」,且客户端每 4s 续报、TTL 永不失效。
      songId: state === "STOPPED" ? undefined : (patch.songId ?? prev?.songId),
      reportedAt: Date.now(),
    };
    this.localReports.set(peerId, report);
    return report;
  }

  /** 读取本机实例最近一次上报;无 / 已过期 → undefined。 */
  getLocalStatusReport(peerId: string): LocalPlaybackReport | undefined {
    const r = this.localReports.get(peerId);
    if (!r) return undefined;
    if (Date.now() - r.reportedAt > PeerManager.LOCAL_REPORT_TTL_MS) return undefined;
    return r;
  }

  /**
   * 丢弃某端的本机状态上报(流转「搬走」/ 回收站「销毁」的源端收尾)。
   *
   * 清掉后 GET /status 只回队列快照(已空),不再叠加 state / position / songId
   * —— 否则队列虽然空了,该端仍被报成「在播某一首」。仅靠 30s TTL 是不够的:
   * 客户端每 4s 续报一次,TTL 永远不会到期。
   */
  clearLocalStatusReport(peerId: string): void {
    this.localReports.delete(peerId);
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
    const playMode = (row.playMode as PlayMode) || "order";
    const src: QueuePeekSource = {
      items: items.map(i => ({ songId: i.songId, duration: i.duration })),
      currentIndex: row.currentIndex,
      playMode,
    };
    // shuffle:惰性物化并带上序列 → peekUpcomingPositions 的 shuffle 分支
    // 从此对本机队列生效(此前缺序列只能扫 0 个位置)。
    if (playMode === "shuffle" && items.length > 1) {
      const sh = this.ensureLocalShuffle(peerId, row.currentIndex, items.length);
      src.shuffleOrder = sh.order;
      src.shufflePos = sh.pos;
    }
    return src;
  }

  /** 本机队列变动后触发一次预探测(fire-and-forget;调度器内部做防抖/冷却/合并)。 */
  private scheduleLocalPreProbe(peerId: string): void {
    getPreProbeScheduler().schedule(peerId, () => this.localPeekSource(peerId));
  }

  // ----- Local queue CRUD (dlna queues are owned by queue.ts) -----

  /** Replace the local queue and mark it active. */
  localPlayFrom(peerId: string, userId: string, items: QueueItem[], startIndex: number, startPosition?: number): void {
    const now = new Date().toISOString();
    // 整队替换 → 旧洗牌序列失效(惰性重建,按新 currentIndex keepCurrent)。
    this.localShuffle.delete(peerId);
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
    // 起始位置只随**这一次**广播带出:先落 pending → 取快照(快照里带上它)
    // → 广播 → 立刻清掉。顺序不能颠倒,否则后续轮询会反复把它交给客户端,
    // 表现为「每次轮询都被拉回同一个位置」。
    if (typeof startPosition === "number" && Number.isFinite(startPosition) && startPosition > 0) {
      this.pendingStartPosition.set(peerId, startPosition);
    } else {
      this.pendingStartPosition.delete(peerId);
    }
    const snap = this.getQueueSnapshot(peerId);
    this.emit("peer_queue_changed", peerId, snap);
    this.pendingStartPosition.delete(peerId);
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
    this.localShuffle.delete(peerId);
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
    if (mode !== "shuffle") this.localShuffle.delete(peerId);
    db.update(localQueues).set({ playMode: mode, updatedAt: now }).where(eq(localQueues.peerId, peerId)).run();
    // 播放模式变化 → 预探测窗口位置整体重算(已探过的曲复用缓存,只补缺口)。
    this.scheduleLocalPreProbe(peerId);
    this.emit("peer_queue_changed", peerId, this.getQueueSnapshot(peerId));
  }

  /** Update currentIndex for a local peer (Web client reports track change).
   *  游标一动 = 预探测窗口整体前移 → 重新扫描(滑动缓冲的「头随播放消费」)。
   *  shuffle:同步序列位置(客户端沿序列推进,服务端据此保持预探测窗口对齐)。 */
  localSetIndex(peerId: string, index: number): void {
    const now = new Date().toISOString();
    db.update(localQueues).set({ currentIndex: index, lastActiveAt: now, updatedAt: now })
      .where(eq(localQueues.peerId, peerId)).run();
    const sh = this.localShuffle.get(peerId);
    if (sh) {
      const pos = sh.order.indexOf(index);
      if (pos >= 0) sh.pos = pos;
    }
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
    // 1) liveness:一台静默超过门槛(缺省 2 分钟,可配 peer_idle_minutes)的本机播放器
    //    只标「不在线」(切歌器显示离线态),队列不动 —— 队列生命周期由下面的
    //    6h 双条件清扫决定,与页面开不开无关。
    //    DLNA/AirPlay 的可用性来自发现流程(reconcile*),不在这里改。
    const idleMs = peerIdleTimeoutMs();
    for (const p of this.peers.values()) {
      if (p.kind !== "local") continue;
      if (p.available && now - p.lastActiveAt >= idleMs) this.markLocalOffline(p);
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
