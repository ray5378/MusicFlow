// 队列管理 + 切歌决策。对照 MA player_queues/controller.py:
//   - on_player_update → _handle_playback_progress_report → play_index
//   - mark_ended(保留 items)
//
// 接管原 dlna/queue.ts 的决策职责。原 dlna/queue.ts 降级为纯数据层。
import { EventEmitter } from "events";
import { db } from "../../db/index.js";
import { deviceQueues } from "../../db/schema.js";
import { PlayMode, QueueItem, QueueSnapshot } from "./types.js";
import { UniversalPlayer } from "./UniversalPlayer.js";
import { getPlayerController } from "./index.js";
import { createDlnaProtocolPlayer } from "../dlna/control.js";
import type { TrackDecision } from "./PlaybackTracker.js";

/** PlayerController 用 "dlna:<deviceId>" 作 playerId;QueueController 内部用裸 deviceId。
 *  此函数在 handleDecision 入口剥前缀,保持 QueueController 全程用裸 deviceId 作 key。 */
function stripDlnaPrefix(playerId: string): string {
  return playerId.startsWith("dlna:") ? playerId.slice(5) : playerId;
}

interface QueueData {
  items: QueueItem[];
  currentIndex: number;
  playMode: PlayMode;
  isActive: boolean;
  ended: boolean;  // 对照 MA mark_ended
}

interface PlayerControllerLike {
  beginOptimistic(playerId: string, mediaUri: string): void;
  endOptimistic(playerId: string): void;
  reportState(state: any): void;
  /** 切歌后重置 tracker,避免上一首的 PLAYING→IDLE 迁移再次触发 advance。 */
  resetTracker(playerId: string): void;
}

export class QueueController extends EventEmitter {
  private queues = new Map<string, QueueData>();
  private players = new Map<string, UniversalPlayer>();
  private ctrls = new Map<string, PlayerControllerLike>();
  private advancing = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() { super(); this.setMaxListeners(50); }

  registerPlayer(playerId: string, player: UniversalPlayer, ctrl: PlayerControllerLike): void {
    this.players.set(playerId, player);
    this.ctrls.set(playerId, ctrl);
  }

  /** DLNA 设备发现后注册:创建 UniversalPlayer + 绑定 DLNA ProtocolPlayer。
   *  QueueController 内部用裸 deviceId 作 key(与路由/DB 一致);
   *  UniversalPlayer/ProtocolPlayer 内部用 "dlna:<deviceId>" 作 playerId(与 PlayerController 一致)。 */
  registerDlnaDevice(deviceId: string, name: string): void {
    if (this.players.has(deviceId)) return;
    const up = new UniversalPlayer(`dlna:${deviceId}`, name);
    up.attachProtocol(createDlnaProtocolPlayer(deviceId));
    this.registerPlayer(deviceId, up, getPlayerController());
    console.log(`[QueueController] registered DLNA device: ${deviceId} (${name})`);
  }

  /** Fallback poll:对照 MA force_poll,GENA 不可用时主动 poll 设备状态上报 PlayerController。
   *  间隔 5s(MA 是 30s,本地设备事件支持差,用 5s 平衡)。 */
  startPollLoop(baseUrl: () => string): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => { this.pollAllDevices(baseUrl).catch(() => {}); }, 5000);
  }

  private async pollAllDevices(_baseUrl: () => string): Promise<void> {
    for (const [deviceId, player] of this.players) {
      const q = this.queues.get(deviceId);
      if (!q || !q.isActive || q.currentIndex < 0) continue;
      if (this.advancing.has(deviceId)) continue;
      try {
        const state = await player.pollState();
        // state.playerId 已是 "dlna:<deviceId>",直接上报 PlayerController。
        this.ctrls.get(deviceId)?.reportState(state);
      } catch (e: any) {
        console.warn(`[QueueController][poll] ${deviceId}: ${e?.message || e}`);
      }
    }
  }

  /** 重启后恢复:对照原 QueueManager.resumeActive。设备有活跃队列时续播当前首。 */
  async resumeActive(deviceId: string, baseUrl: string): Promise<void> {
    const q = this.queues.get(deviceId);
    if (!q || !q.isActive || q.currentIndex < 0) return;
    if (!this.players.has(deviceId)) return; // 设备未注册(可能离线)
    if (this.advancing.has(deviceId)) return;
    this.advancing.add(deviceId);
    try {
      await this.playCurrent(deviceId, baseUrl);
    } finally {
      this.advancing.delete(deviceId);
    }
  }

  /** 由 PlayerController.onDecision 调用。playerId 形如 "dlna:<deviceId>"。 */
  async handleDecision(decision: TrackDecision, playerId: string): Promise<void> {
    const baseUrl = process.env.DLNA_BASE_URL || `http://0.0.0.0:${process.env.PORT || 3000}`;
    // PlayerController 用 "dlna:<deviceId>" 作 key;QueueController 用裸 deviceId。
    const deviceId = stripDlnaPrefix(playerId);
    const q = this.queues.get(deviceId);
    if (!q) return;

    if (decision === "advance" || decision === "track_changed") {
      if (this.advancing.has(deviceId)) return;
      this.advancing.add(deviceId);
      try {
        const nextIdx = this.pickNext(q, decision === "track_changed");
        if (nextIdx === -1) {
          this.markEnded(deviceId);
          return;
        }
        q.currentIndex = nextIdx;
        q.ended = false;
        await this.playCurrent(deviceId, baseUrl);
        this.persist(deviceId);
        this.emit("queue_changed", deviceId, this.snapshot(deviceId));
      } finally {
        this.advancing.delete(deviceId);
      }
      return;
    }
    if (decision === "ended") {
      this.markEnded(deviceId);
      return;
    }
    if (decision === "stalled") {
      // 卡死兜底:重试当前首一次
      if (this.advancing.has(deviceId)) return;
      this.advancing.add(deviceId);
      try {
        await this.playCurrent(deviceId, baseUrl);
      } finally {
        this.advancing.delete(deviceId);
      }
      return;
    }
  }

  private markEnded(playerId: string): void {
    const q = this.queues.get(playerId);
    if (!q) return;
    q.ended = true;
    q.isActive = false;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  private pickNext(q: QueueData, nativeGapless: boolean): number {
    const n = q.items.length;
    if (n === 0) return -1;
    if (q.playMode === "one") return q.currentIndex;
    if (q.playMode === "shuffle") return this.randomIndex(q);
    if (q.playMode === "all") {
      if (q.currentIndex + 1 < n) return q.currentIndex + 1;
      return 0;
    }
    // order
    if (q.currentIndex + 1 < n) return q.currentIndex + 1;
    return -1;
  }

  private randomIndex(q: QueueData): number {
    const n = q.items.length;
    if (n <= 1) return q.currentIndex;
    let idx = q.currentIndex;
    while (idx === q.currentIndex) idx = Math.floor(Math.random() * n);
    return idx;
  }

  private async playCurrent(deviceId: string, baseUrl: string): Promise<void> {
    const q = this.queues.get(deviceId);
    const player = this.players.get(deviceId);
    const ctrl = this.ctrls.get(deviceId);
    if (!q || !player || !ctrl) return;
    const item = q.currentIndex >= 0 ? q.items[q.currentIndex] : undefined;
    if (!item) return;
    // PlayerController 用 "dlna:<deviceId>" 作 key。
    const playerId = `dlna:${deviceId}`;
    console.log(`[QueueController][playCurrent] ${playerId}: idx=${q.currentIndex} songId=${item.songId}`);
    try {
      const { mediaUri } = await player.playMedia(item, baseUrl);
      // 切歌后重置 tracker:清掉上一首的 PLAYING 状态,避免切歌瞬态的
      // PLAYING→IDLE 迁移再次触发 advance(对照 MA play_index 后清 prev_state)。
      ctrl.resetTracker(playerId);
      // 乐观窗口:cast 命令已发出,屏蔽瞬态
      ctrl.beginOptimistic(playerId, mediaUri);
    } catch (e: any) {
      console.warn(`[QueueController][playCurrent] ${playerId}: cast FAILED:`, e?.message || e);
      ctrl.endOptimistic(playerId);
    }
  }

  // ==================== 公共 API(供路由调用,保持原 QueueManager 形状)====================
  /** 仅设数据,不触发播放(供测试 + playFrom 复用)。 */
  setQueue(playerId: string, items: QueueItem[], startIndex: number, baseUrl: string): void {
    let q = this.queues.get(playerId);
    if (!q) { q = { items: [], currentIndex: -1, playMode: "order", isActive: false, ended: false }; this.queues.set(playerId, q); }
    q.items = items;
    q.currentIndex = Math.max(-1, Math.min(items.length - 1, startIndex));
    q.isActive = true;
    q.ended = false;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  async playFrom(playerId: string, items: QueueItem[], startIndex: number, baseUrl: string): Promise<void> {
    this.setQueue(playerId, items, startIndex, baseUrl);
    if (this.advancing.has(playerId)) return;
    this.advancing.add(playerId);
    try { await this.playCurrent(playerId, baseUrl); }
    finally { this.advancing.delete(playerId); }
  }

  setPlayMode(playerId: string, mode: PlayMode): void {
    const q = this.queues.get(playerId); if (!q) return;
    q.playMode = mode;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  async next(playerId: string, baseUrl: string): Promise<void> {
    const q = this.queues.get(playerId); if (!q) return;
    const idx = this.pickNext(q, false);
    if (idx === -1) { this.markEnded(playerId); return; }
    if (this.advancing.has(playerId)) return;
    this.advancing.add(playerId);
    try { q.currentIndex = idx; q.ended = false; await this.playCurrent(playerId, baseUrl); this.persist(playerId); this.emit("queue_changed", playerId, this.snapshot(playerId)); }
    finally { this.advancing.delete(playerId); }
  }

  async prev(playerId: string, baseUrl: string): Promise<void> {
    const q = this.queues.get(playerId); if (!q) return;
    if (this.advancing.has(playerId)) return;
    this.advancing.add(playerId);
    try {
      if (q.playMode === "one") { await this.playCurrent(playerId, baseUrl); }
      else if (q.playMode === "shuffle") { q.currentIndex = this.randomIndex(q); await this.playCurrent(playerId, baseUrl); }
      else if (q.currentIndex > 0) { q.currentIndex--; await this.playCurrent(playerId, baseUrl); }
      else if (q.playMode === "all") { q.currentIndex = q.items.length - 1; await this.playCurrent(playerId, baseUrl); }
      this.persist(playerId); this.emit("queue_changed", playerId, this.snapshot(playerId));
    } finally { this.advancing.delete(playerId); }
  }

  clear(playerId: string): void {
    const q = this.queues.get(playerId); if (!q) return;
    q.items = []; q.currentIndex = -1; q.isActive = false; q.ended = false;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  snapshot(playerId: string): QueueSnapshot {
    const q = this.queues.get(playerId);
    return {
      items: q?.items || [],
      currentIndex: q?.currentIndex ?? -1,
      playMode: q?.playMode || "order",
      isActive: q?.isActive || false,
      ended: q?.ended || false,
    };
  }

  /** Append items without switching playback. If the queue was empty, start
   *  playing from the first appended item. 对照原 QueueManager.enqueue。 */
  async enqueue(playerId: string, items: QueueItem[], baseUrl: string): Promise<void> {
    let q = this.queues.get(playerId);
    if (!q) {
      q = { items: [], currentIndex: -1, playMode: "order", isActive: false, ended: false };
      this.queues.set(playerId, q);
    }
    q.items.push(...items);
    if (q.currentIndex < 0 && q.items.length > 0) {
      q.currentIndex = 0;
      q.isActive = true;
      q.ended = false;
      await this.playCurrent(playerId, baseUrl);
    }
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  /** Remove a single item by index and keep playback coherent. 对照原
   *  QueueManager.removeAt:删的是当前项则续播同 index 的下一首。 */
  removeAt(playerId: string, index: number, baseUrl: string): void {
    const q = this.queues.get(playerId); if (!q) return;
    if (index < 0 || index >= q.items.length) return;
    q.items.splice(index, 1);
    if (index < q.currentIndex) {
      q.currentIndex--;
    } else if (index === q.currentIndex) {
      if (q.items.length === 0) {
        q.currentIndex = -1;
        q.isActive = false;
        q.ended = true;
      } else if (q.currentIndex >= q.items.length) {
        q.currentIndex = q.items.length - 1;
      }
      this.playCurrent(playerId, baseUrl).catch(() => {});
    }
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  /** Mark a device inactive without clearing the queue. 对照原 QueueManager.deactivate。 */
  deactivate(playerId: string): void {
    const q = this.queues.get(playerId); if (!q) return;
    q.isActive = false;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  /** List all devices that have an active (non-empty) queue. 对照原
   *  QueueManager.activeDevices — 供 Web 客户端恢复 cast 状态。 */
  activeDevices(): Array<{ deviceId: string; snapshot: QueueSnapshot }> {
    const out: Array<{ deviceId: string; snapshot: QueueSnapshot }> = [];
    for (const [id, q] of this.queues) {
      if (q.isActive && q.items.length > 0) {
        out.push({ deviceId: id, snapshot: this.snapshot(id) });
      }
    }
    return out;
  }

  /** Load all persisted queues from DB on startup. 对照原 QueueManager.loadFromDb。
   *  ended 字段 DB 不存(旧表无此列),默认 false。 */
  loadFromDb(): void {
    const rows = db.select().from(deviceQueues).all();
    for (const r of rows) {
      try {
        const items = JSON.parse(r.itemsJson || "[]") as QueueItem[];
        this.queues.set(r.deviceId, {
          items,
          currentIndex: r.currentIndex,
          playMode: (r.playMode as PlayMode) || "order",
          isActive: !!r.isActive,
          ended: false,
        });
      } catch {}
    }
    console.log(`[QueueController] loaded ${this.queues.size} persisted device queue(s) from DB`);
  }

  private persist(playerId: string): void {
    const q = this.queues.get(playerId); if (!q) return;
    db.insert(deviceQueues).values({
      deviceId: playerId,
      itemsJson: JSON.stringify(q.items),
      currentIndex: q.currentIndex,
      playMode: q.playMode,
      isActive: q.isActive ? 1 : 0,
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: deviceQueues.deviceId,
      set: {
        itemsJson: JSON.stringify(q.items),
        currentIndex: q.currentIndex,
        playMode: q.playMode,
        isActive: q.isActive ? 1 : 0,
        updatedAt: new Date().toISOString(),
      },
    }).run();
  }
}
