// 队列管理 + 切歌决策。对照 MA player_queues/controller.py:
//   - on_player_update → _handle_playback_progress_report → play_index
//   - mark_ended(保留 items)
//
// 接管原 dlna/queue.ts 的决策职责。原 dlna/queue.ts 降级为纯数据层。
import { EventEmitter } from "events";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { deviceQueues, groupQueues, songs } from "../../db/schema.js";
import { PlayMode, PlaybackState, QueueItem, QueueSnapshot } from "./types.js";
import { UniversalPlayer } from "./UniversalPlayer.js";
import { getPlayerController } from "./index.js";
import { createDlnaProtocolPlayer, getEffectiveBaseUrl, clearCurrentMedia, getDevice, alignDeviceToPosition } from "../dlna/control.js";
import { createGroupProtocolPlayer, getGroupStatus, getOnlineMemberIds } from "../group/protocolPlayer.js";
import { getGroupManager } from "../group/index.js";
import { suffixToMime } from "../dlna/queue.js";
import type { TrackDecision } from "./PlaybackTracker.js";

/** PlayerController 用 "dlna:<deviceId>" / "group:<groupId>" 作 playerId;
 *  QueueController 内部用裸 id。此函数在 handleDecision 入口剥前缀,
 *  保持 QueueController 全程用裸 id 作 key(设备队列存 device_queues,组队列存 group_queues)。 */
function stripPlayerPrefix(playerId: string): string {
  if (playerId.startsWith("dlna:")) return playerId.slice(5);
  if (playerId.startsWith("group:")) return playerId.slice(6);
  return playerId;
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

  /** 组创建后注册:创建 UniversalPlayer + 绑定 GroupProtocolPlayer(扇出到在线成员)。
   *  内部用裸 groupId 作 key;成员增删实时从 GroupManager 读取。 */
  registerGroupPlayer(groupId: string, name: string): void {
    if (this.players.has(groupId)) return;
    const up = new UniversalPlayer(`group:${groupId}`, name);
    up.attachProtocol(createGroupProtocolPlayer(groupId));
    this.registerPlayer(groupId, up, getPlayerController());
    console.log(`[QueueController] registered group player: ${groupId} (${name})`);
  }

  /** 对注册播放器下发传输控制(dlna=单设备,group=扇出)。 */
  async transport(playerId: string, op: "play" | "pause" | "stop" | "seek" | "volume", arg?: number): Promise<void> {
    const player = this.players.get(playerId);
    if (!player) throw new Error(`未注册的播放器: ${playerId}`);
    if (op === "play") await player.resume();
    else if (op === "pause") await player.pause();
    else if (op === "stop") await player.stop();
    else if (op === "seek") await player.seek(arg!);
    else if (op === "volume") await player.setVolume(arg!);
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

  /** 由 PlayerController.onDecision 调用。playerId 形如 "dlna:<deviceId>" / "group:<groupId>"。 */
  async handleDecision(decision: TrackDecision, playerId: string): Promise<void> {
    // 内部触发路径没有 HTTP 请求上下文,用统一解析函数取 LAN 可达的 base URL
    // (避免落入 0.0.0.0 导致设备拉不到流,见 control.ts 顶部注释)。
    const baseUrl = getEffectiveBaseUrl();
    // PlayerController 用 "dlna:<deviceId>" / "group:<groupId>" 作 key;QueueController 用裸 id。
    const id = stripPlayerPrefix(playerId);
    // 组模式接管:成员设备在组播放期间不再响应个人队列决策(组的决策由组 tracker
    // 经 "group:<gid>" 前缀发出,在此正常处理)。对照 MA:组激活后成员不可单独播放。
    if (this.isMemberOfActiveGroup(id)) return;
    const q = this.queues.get(id);
    if (!q) return;

    if (decision === "advance" || decision === "track_changed") {
      if (this.advancing.has(id)) return;
      this.advancing.add(id);
      try {
        const nextIdx = this.pickNext(q, decision === "track_changed");
        if (nextIdx === -1) {
          if (!this.shouldSuppressGroupEnd(id)) this.markEnded(id);
          return;
        }
        q.currentIndex = nextIdx;
        q.ended = false;
        await this.playCurrent(id, baseUrl);
        this.persist(id);
        this.emit("queue_changed", id, this.snapshot(id));
      } finally {
        this.advancing.delete(id);
      }
      return;
    }
    if (decision === "ended") {
      if (!this.shouldSuppressGroupEnd(id)) this.markEnded(id);
      return;
    }
    if (decision === "stalled") {
      // 卡死兜底:重试当前首一次
      if (this.advancing.has(id)) return;
      // 回归修复:乐观窗口 5s 未确认 PLAYING 会触发 stalled,但 HiVi 等真实设备的
      // PLAYING 确认(GENA 或 5s 轮询,cast 期间 advancing 还会跳过轮询)常晚于 5s。
      // 此时盲目重投会把"已在播放"的设备打断 → 歌曲前几秒无限重复。
      // 先轮询设备真实状态:确在播放 → 静默关闭乐观窗口并重置 tracker,绝不重投。
      try {
        const state = await this.players.get(id)?.pollState();
        if (state?.playbackState === PlaybackState.PLAYING) {
          this.ctrls.get(id)?.endOptimistic(playerId);
          this.ctrls.get(id)?.resetTracker(playerId);
          return;
        }
      } catch {}
      this.advancing.add(id);
      try {
        await this.playCurrent(id, baseUrl);
      } finally {
        this.advancing.delete(id);
      }
      return;
    }
  }

  /** 设备是否属于某个"正在播放"的组。组播放期间其个人队列决策一律忽略。
   *  设备可同时属于多个组,只要任一所属组的队列激活即视为受组控制。 */
  private isMemberOfActiveGroup(deviceId: string): boolean {
    const gids = getGroupManager().groupsOfDevice(deviceId);
    if (gids.length === 0) return false;
    return gids.some(gid => !!this.queues.get(gid)?.isActive);
  }

  /** 悬挂时清空组的 tracker 状态(lastPlaying):成员回归后 leader 报 NO_MEDIA_PRESENT→
   *  IDLE 时,若 lastPlaying 还在,tracker 会误判"曲目结束"而 deactivate 队列(此时成员已在线,
   *  shouldSuppressGroupEnd 拦不住),看门狗将无法续播。清空后单发 IDLE 不触发 ended。 */
  resetGroupTracker(groupId: string): void {
    this.ctrls.get(groupId)?.resetTracker(`group:${groupId}`);
  }

  private markEnded(playerId: string): void {
    const q = this.queues.get(playerId);
    if (!q) return;
    q.ended = true;
    q.isActive = false;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  /** 组队列的"结束"决策在成员全离线时应被抑制:那是 leader 离线导致的假 IDLE,
   *  队列要保留给看门狗做"悬挂 + 成员回归自动恢复"。在线时正常结束(自然播完/用户停止)。 */
  private shouldSuppressGroupEnd(id: string): boolean {
    if (!getGroupManager().get(id)) return false;
    return getOnlineMemberIds(id).length === 0;
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
    // 只带 songId 的 item(HA/脚本下发)补全元数据,否则 castToDevice 的
    // buildDidlLite/escapeXml 会因 title/mime 缺失抛错。
    const fullItem = await this.resolveItem(item);
    // PlayerController 的 key 取 player 自身完整 id(dlna:<id> 或 group:<gid>)。
    const playerId = player.playerId;
    console.log(`[QueueController][playCurrent] ${playerId}: idx=${q.currentIndex} songId=${item.songId}`);
    try {
      // 乐观窗口必须在 cast 之前开启:castToDevice 内部 Stop→SetAVTransportURI→Play
      // 会触发 GENA STOPPED/TRANSITIONING/PLAYING 事件。若窗口在 cast 之后才开,
      // 设备在 cast 期间上报的 PLAYING 会先于窗口开启到达 → 窗口永远等不到 PLAYING
      // → 5s 超时 → stalled → 重播当前首 → 死循环。
      // 对照 MA:命令发出前先把 _attr_playback_state = PLAYING(乐观设态)。
      ctrl.beginOptimistic(playerId, "pending");
      const { mediaUri } = await player.playMedia(fullItem, baseUrl);
      // cast 命令已发出,重置 tracker:清掉上一首的 prev 状态 + 残留去抖,
      // 避免上一首的 PLAYING→IDLE 迁移再次触发 advance(对照 MA play_index 后清 prev_state)。
      // 乐观窗口保持开启,等设备上报 PLAYING 确认成功(cast 期间已屏蔽瞬态 IDLE)。
      ctrl.resetTracker(playerId);
      void mediaUri;
    } catch (e: any) {
      console.warn(`[QueueController][playCurrent] ${playerId}: cast FAILED:`, e?.message || e);
      ctrl.endOptimistic(playerId);
    }
  }

  /** 只带 songId 的 item(HA/脚本/持久化恢复)在 cast 前补全元数据。 */
  private async resolveItem(item: QueueItem): Promise<QueueItem> {
    if (item.title && item.mime) return item;
    try {
      const s = db.select().from(songs).where(eq(songs.id, item.songId)).get();
      if (!s) return item;
      return {
        songId: item.songId,
        title: item.title || s.title || "未知",
        artist: item.artist ?? s.artist ?? undefined,
        album: item.album ?? s.album ?? undefined,
        mime: item.mime || suffixToMime(s.suffix || ""),
        coverArt: item.coverArt ?? s.coverArt ?? undefined,
        duration: typeof item.duration === "number" ? item.duration : typeof s.duration === "number" ? s.duration : undefined,
      };
    } catch {
      return item;
    }
  }

  // ==================== 公共 API(供路由调用,保持原 QueueManager 形状)====================
  /** 仅设数据,不触发播放(供测试 + playFrom 复用)。 */
  setQueue(playerId: string, items: QueueItem[], startIndex: number, baseUrl: string): void {
    let q = this.queues.get(playerId);
    if (!q) { q = { items: [], currentIndex: -1, playMode: "shuffle", isActive: false, ended: false }; this.queues.set(playerId, q); }
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
    // 清队列同时清掉设备端的媒体缓存,避免 status 返回上一首残留(组场景清各成员)。
    const group = getGroupManager().get(playerId);
    if (group) {
      for (const d of group.memberIds) clearCurrentMedia(d);
    } else {
      clearCurrentMedia(playerId);
    }
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  snapshot(playerId: string): QueueSnapshot {
    const q = this.queues.get(playerId);
    return {
      items: q?.items || [],
      currentIndex: q?.currentIndex ?? -1,
      playMode: q?.playMode || "shuffle",
      isActive: q?.isActive || false,
      ended: q?.ended || false,
    };
  }

  /** Append items without switching playback. If the queue was empty, start
   *  playing from the first appended item. 对照原 QueueManager.enqueue。 */
  async enqueue(playerId: string, items: QueueItem[], baseUrl: string): Promise<void> {
    let q = this.queues.get(playerId);
    if (!q) {
      q = { items: [], currentIndex: -1, playMode: "shuffle", isActive: false, ended: false };
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

  /** 组播放中新增成员:把当前曲目 cast 给新成员并 seek 到 leader 当前进度。
   *  对照 MA Universal Group 的加入语义:仅在加入时对齐一次,不做周期漂移校正。
   *  - 组队列未激活 / 无当前曲 → 不动作(静默)
   *  - 只处理在线新成员(离线成员回归由离线 watchdog 负责)
   *  - 组处于暂停 → 新成员对齐后同步暂停(镜像组播放态)
   *  - 新成员若有个人激活队列 → 标记不激活(组激活期间成员不可单独播放,保留 items) */
  async rejoinMembers(groupId: string, newMemberIds: string[]): Promise<void> {
    const q = this.queues.get(groupId);
    if (!q || !q.isActive || q.currentIndex < 0) return;
    const item = q.items[q.currentIndex];
    if (!item) return;
    const fullItem = await this.resolveItem(item);
    const baseUrl = getEffectiveBaseUrl();
    const online = newMemberIds.filter(d => !!getDevice(d)?.available);
    if (online.length === 0) return;
    // leader 当前进度与播放态(组状态派生自 leader)。
    let position = 0;
    let playState: string | undefined;
    try {
      const st = await getGroupStatus(groupId);
      if (typeof st.position === "number" && st.position > 0) position = st.position;
      playState = st.state;
    } catch {}
    for (const deviceId of online) {
      try {
        const p = createDlnaProtocolPlayer(deviceId);
        await p.playMedia(fullItem, baseUrl);
        // cast 后立刻 seek 在部分渲染器(实测 HiVi)会静默失效,用校准 seek:
        // 先等设备稳定 PLAYING,再以 leader 的"实时"位置为目标收敛。
        let landed = position;
        if (position > 0) {
          landed = await alignDeviceToPosition(deviceId, position, {
            getTargetSec: async () => {
              const st = await getGroupStatus(groupId);
              return typeof st.position === "number" && st.position > 0 ? st.position : position;
            },
          });
        }
        if (playState === "PAUSED_PLAYBACK") await p.pause();
        const pq = this.queues.get(deviceId);
        if (pq?.isActive) {
          pq.isActive = false;
          this.persist(deviceId);
          this.emit("queue_changed", deviceId, this.snapshot(deviceId));
        }
        console.log(`[group] ${groupId}: 新成员 ${deviceId} 已对齐(位置 ${Math.round(landed)}s, 状态 ${playState ?? "?"})`);
      } catch (e: any) {
        console.warn(`[group] ${groupId}: 新成员 ${deviceId} 加入对齐失败: ${e?.message || e}`);
      }
    }
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
   *  设备队列存 device_queues,组队列存 group_queues,都按裸 id 装入。
   *  ended 字段 DB 不存(旧表无此列),默认 false。 */
  loadFromDb(): void {
    const rows = db.select().from(deviceQueues).all();
    for (const r of rows) {
      try {
        const items = JSON.parse(r.itemsJson || "[]") as QueueItem[];
        this.queues.set(r.deviceId, {
          items,
          currentIndex: r.currentIndex,
          playMode: (r.playMode as PlayMode) || "shuffle",
          isActive: !!r.isActive,
          ended: false,
        });
      } catch {}
    }
    const groupRows = db.select().from(groupQueues).all();
    for (const r of groupRows) {
      try {
        const items = JSON.parse(r.itemsJson || "[]") as QueueItem[];
        this.queues.set(r.groupId, {
          items,
          currentIndex: r.currentIndex,
          playMode: (r.playMode as PlayMode) || "shuffle",
          isActive: !!r.isActive,
          ended: false,
        });
      } catch {}
    }
    console.log(`[QueueController] loaded ${this.queues.size} persisted queue(s) (${groupRows.length} group) from DB`);
  }

  private persist(playerId: string): void {
    const q = this.queues.get(playerId); if (!q) return;
    const now = new Date().toISOString();
    const isGroup = !!getGroupManager().get(playerId);
    if (isGroup) {
      db.insert(groupQueues).values({
        groupId: playerId,
        itemsJson: JSON.stringify(q.items),
        currentIndex: q.currentIndex,
        playMode: q.playMode,
        isActive: q.isActive ? 1 : 0,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: groupQueues.groupId,
        set: {
          itemsJson: JSON.stringify(q.items),
          currentIndex: q.currentIndex,
          playMode: q.playMode,
          isActive: q.isActive ? 1 : 0,
          updatedAt: now,
        },
      }).run();
      return;
    }
    db.insert(deviceQueues).values({
      deviceId: playerId,
      itemsJson: JSON.stringify(q.items),
      currentIndex: q.currentIndex,
      playMode: q.playMode,
      isActive: q.isActive ? 1 : 0,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: deviceQueues.deviceId,
      set: {
        itemsJson: JSON.stringify(q.items),
        currentIndex: q.currentIndex,
        playMode: q.playMode,
        isActive: q.isActive ? 1 : 0,
        updatedAt: now,
      },
    }).run();
  }
}
