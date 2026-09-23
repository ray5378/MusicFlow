// 队列管理 + 切歌决策。对照 MA player_queues/controller.py:
//   - on_player_update → _handle_playback_progress_report → play_index
//   - mark_ended(保留 items)
//
// 接管原 dlna/queue.ts 的决策职责。原 dlna/queue.ts 降级为纯数据层。
import { EventEmitter } from "events";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { albums, deviceQueues, groupQueues, songs } from "../../db/schema.js";
import { PlayMode, PlayerState, PlaybackState, QueueItem, QueueSnapshot } from "./types.js";
import { UniversalPlayer } from "./UniversalPlayer.js";
import { getPlayerController } from "./index.js";
import { createDlnaProtocolPlayer, getEffectiveBaseUrl, clearCurrentMedia, getDevice, alignDeviceToPosition } from "../dlna/control.js";
import { createAirPlayProtocolPlayer } from "../airplay/protocolPlayer.js";
import { createSendspinProtocolPlayer } from "../sendspin/protocolPlayer.js";
import { getCachedPlayability } from "../source/online/streamFallback.js";
import { getPreProbeScheduler } from "./preProbeScheduler.js";
import { createGroupProtocolPlayer, getGroupStatus, hasOnlineMember } from "../group/protocolPlayer.js";
import { getGroupManager } from "../group/index.js";
import { suffixToMime } from "../dlna/queue.js";
import type { TrackDecision } from "./PlaybackTracker.js";
import { createLogger } from "../../utils/logger.js";
import { markSeekIssued, withinSeekSettle, logSeekSettleSuppressed, clearSeekSettle } from "./seekSettle.js";

const log = createLogger("QueueController");

/** PlayerController 用 "dlna:<deviceId>" / "group:<groupId>" 作 playerId;
 *  QueueController 内部用裸 id。此函数在 handleDecision 入口剥前缀,
 *  保持 QueueController 全程用裸 id 作 key(设备队列存 device_queues,组队列存 group_queues)。 */
function stripPlayerPrefix(playerId: string): string {
  if (playerId.startsWith("dlna:")) return playerId.slice(5);
  if (playerId.startsWith("group:")) return playerId.slice(6);
  if (playerId.startsWith("airplay:")) return playerId.slice(8);
  if (playerId.startsWith("sendspin:")) return playerId.slice(9);
  return playerId;
}

interface QueueData {
  items: QueueItem[];
  currentIndex: number;
  playMode: PlayMode;
  isActive: boolean;
  ended: boolean;  // 对照 MA mark_ended
  /** 洗牌序(一轮内不重复的队列 index 序列)与位置;随队列重建,不持久化。
   *  与 web 端播放器(v1.7.43 洗牌序)语义对齐:随机播放 = 固定序列一轮不重复。 */
  shuffleOrder?: number[];
  shufflePos?: number;
  shuffleLen?: number;
}

interface PlayerControllerLike {
  beginOptimistic(playerId: string, mediaUri: string): void;
  /** cast 命令**送达后**起 5s「等设备确认 PLAYING」计时(乐观窗口阶段 2,见 PlayerController)。
   *  可选:纯内存操作,测试替身未实现时静默跳过(= 只保留阶段 1 的瞬态屏蔽),绝不影响起播。 */
  armOptimisticTimeout?(playerId: string): void;
  endOptimistic(playerId: string): void;
  reportState(state: any): void;
  /** 切歌后重置 tracker,避免上一首的 PLAYING→IDLE 迁移再次触发 advance。 */
  resetTracker(playerId: string): void;
  /** 起播前注入当前曲已知时长(秒),供结束判定使用。 */
  setExpectedDuration(playerId: string, seconds: number): void;
}

export class QueueController extends EventEmitter {
  private queues = new Map<string, QueueData>();
  private players = new Map<string, UniversalPlayer>();
  private ctrls = new Map<string, PlayerControllerLike>();
  private advancing = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  // 服务器端定时暂停（sleep timer），key = 裸 deviceId/groupId。到点立即暂停。
  private sleepTimers = new Map<string, { timer: NodeJS.Timeout; deadline: number }>();
  /** 同一首连续卡死计数(key=裸 id):stalled 重投只兜一次 transient,
   *  同一首连续卡死第 2 次即放行切歌,而不是 2-3 秒无限重播(见 handleDecision)。 */
  private stallCounters = new Map<string, { songId: string | undefined; count: number }>();
  /** 连续 cast **抛错**计数(key=裸 id),只在 cast 成功返回时清零。
   *  与 stallCounters 互补:后者按「同一首」计数,而 songId 一变就归 1 ——
   *  整队每首都投不出去时,它会在 all/shuffle 下随切歌不断重置 → 无界绕圈。
   *  这个计数跨曲累积,上限 = 一整圈(stallCounters 允许每首 2 次,故取 2×曲数),
   *  达到即判「整队都投不出去」,停止推进等负缓存过期(与 playCurrent 的 skipLimit 同口径)。 */
  private castFailStreak = new Map<string, number>();
  /** 各 player 最近一次**成功**读到的播放位置(秒)。两处用途:
   *  ① 链路丢失(frozen / 子进程僵死)后回归时,把播放位置拉回用户离开的地方,
   *     而不是从头播(= 用户眼里的"归零");
   *  ② frozen 判定后重投的落点。 */
  private lastPos = new Map<string, number>();
  /** 探测到「链路/子进程不可用」的 player(key=裸 id):记下当时的播放位置。
   *  期间**不接受任何决策**(不切歌、不计数、不重投),等恢复后一次性续播。
   *
   *  为什么必须这样:fork 模式 sendspin 子进程僵死的那 95s 里,主进程对它的每个 RPC
   *  都 25s 超时,而旧实现把"读不到"当成"设备报 IDLE"处理 → 凭空造出 PLAYING→IDLE
   *  迁移 → advance 切歌;stalled 通道还会把它计进"连续卡死",第 2 次直接放行切歌。
   *  用户观感 = 进度条归零 + 曲目乱跳(2026-09-21 真机实测 3 次)。 */
  private linkLost = new Map<string, { pos: number; at: number; reason: string }>();
  /** 正由 flow 会话(连续流,P3-1)驱动的设备:设备拉的是**一条多曲流**,
   *  它报的 position/duration 不再对应单曲 → 切歌决策由出流侧在曲目边界静默推进
   *  (见 flowAdvance / handleDecision 入口的拦截)。 */
  private flowOwned = new Set<string>();

  constructor() {
    super();
    this.setMaxListeners(50);
    // 预探测状态变化 → 用既有的 queue_changed 重发一次快照即可,
    // **不新增事件类型**(快照里带 preProbe,两个下发通道都是展开语法,自动透传)。
    // 多监听:PeerManager 也会注册一份(本机链路走 peer_queue_changed),互不顶替。
    //
    // ⚠️ 只为**本控制器持有的队列**重发(裸 deviceId / groupId)。
    // 预探测调度器是全局的,本机(local)链路也用它,而本机队列按**完整 peerId** 调度
    // (`local:<userId>:<clientId>`) —— 不设这道守卫的话,本机预探测状态一变就会从这里
    // 发出一条 `queue_changed`,把带明文 clientId 的完整 peerId 塞进 WS 的 `device_id`
    // (既违反「clientId 永不出服务端」,语义也是错的:本机队列的状态通道是 PeerManager 的
    // `peer_queue_changed`,Web/客户端据此镜像;`queue_changed` 是设备型事件)。
    // 2026-09-15 实测:客户端起播触发本机预探测 → WS 收到
    // `queue_changed device_id=local:<uid>:app-xxxxxxxx`。
    getPreProbeScheduler().addOnChange((id: string) => {
      if (!this.queues.has(id)) return;
      this.emit("queue_changed", id, this.snapshot(id));
    });
  }

  /** 触发一次预探测(fire-and-forget;调度器内部做防抖/冷却/合并)。 */
  private schedulePreProbe(playerId: string): void {
    getPreProbeScheduler().schedule(playerId, () => this.queues.get(playerId));
  }

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
    log.info(`[QueueController] registered DLNA device: ${deviceId} (${name})`);
  }

  /** 组创建后注册:创建 UniversalPlayer + 绑定 GroupProtocolPlayer(扇出到在线成员)。
   *  内部用裸 groupId 作 key;成员增删实时从 GroupManager 读取。 */
  registerGroupPlayer(groupId: string, name: string): void {
    if (this.players.has(groupId)) return;
    const up = new UniversalPlayer(`group:${groupId}`, name);
    up.attachProtocol(createGroupProtocolPlayer(groupId));
    this.registerPlayer(groupId, up, getPlayerController());
    log.info(`[QueueController] registered group player: ${groupId} (${name})`);
  }

  /** 孤儿清理:删除已不在设备表/组表中的注册播放器与队列(key=裸 deviceId/groupId,
   *  设备/组删除后残留)。由 memory/pruneOrphans 定期调用;合法集合为空时不动(防误删)。 */
  pruneOrphans(validDeviceIds: Set<string>, validGroupIds: Set<string>): void {
    if (validDeviceIds.size === 0 && validGroupIds.size === 0) return;
    const valid = new Set<string>([...validDeviceIds, ...validGroupIds]);
    for (const k of this.players.keys()) {
      if (valid.has(k)) continue;
      this.players.delete(k);
      this.ctrls.delete(k);
      this.queues.delete(k);
      this.stallCounters.delete(k);
      this.castFailStreak.delete(k);
      this.linkLost.delete(k);
      this.lastPos.delete(k);
      this.clearSleepTimer(k);
    }
  }

  /** AirPlay 设备发现后注册:创建 UniversalPlayer + 绑定 AirPlay ProtocolPlayer。
   *  与 registerDlnaDevice 完全同构 —— 队列/切歌/恢复全走同一套 QueueController。 */
  registerAirPlayDevice(deviceId: string, name: string): void {
    if (this.players.has(deviceId)) return;
    const up = new UniversalPlayer(`airplay:${deviceId}`, name);
    up.attachProtocol(createAirPlayProtocolPlayer(deviceId));
    this.registerPlayer(deviceId, up, getPlayerController());
    log.info(`[QueueController] registered AirPlay device: ${deviceId} (${name})`);
  }

  /** 注销全部 AirPlay player 与其队列(AirPlay 插件关闭时调用,零残留)。
   *  players 的 key 是裸 deviceId(registerAirPlayDevice 传入),按 player.playerId
   *  前缀判断是否为 AirPlay(UniversalPlayer.playerId = "airplay:<deviceId>")。 */
  unregisterAirPlayDevices(): void {
    for (const key of Array.from(this.players.keys())) {
      const up = this.players.get(key);
      if (!up || !up.playerId.startsWith("airplay:")) continue;
      this.players.delete(key);
      this.ctrls.delete(key);
      this.queues.delete(key);
      this.clearSleepTimer(key);
      log.info(`[QueueController] unregistered AirPlay device: ${key}`);
    }
  }

  /** Sendspin 客户端连接后注册:创建 UniversalPlayer + 绑定 Sendspin ProtocolPlayer。
   *  与 registerDlnaDevice/registerAirPlayDevice 完全同构 —— 队列/切歌/恢复全走同一套
   *  QueueController,满足服务端权威的所有播放模式/自动换源/跳过。 */
  registerSendspinDevice(clientId: string, name: string): void {
    if (this.players.has(clientId)) return;
    const up = new UniversalPlayer(`sendspin:${clientId}`, name);
    up.attachProtocol(createSendspinProtocolPlayer(clientId));
    this.registerPlayer(clientId, up, getPlayerController());
    log.info(`[QueueController] registered Sendspin client: ${clientId} (${name})`);
  }

  /** 注销全部 Sendspin player 与其队列(Sendspin 插件关闭时调用,零残留)。 */
  unregisterSendspinDevices(): void {
    for (const key of Array.from(this.players.keys())) {
      const up = this.players.get(key);
      if (!up || !up.playerId.startsWith("sendspin:")) continue;
      this.players.delete(key);
      this.ctrls.delete(key);
      this.queues.delete(key);
      this.clearSleepTimer(key);
      log.info(`[QueueController] unregistered Sendspin client: ${key}`);
    }
  }

  /** 对注册播放器下发传输控制(dlna=单设备,group=扇出)。 */
  async transport(playerId: string, op: "play" | "pause" | "stop" | "seek" | "volume", arg?: number): Promise<void> {
    playerId = stripPlayerPrefix(playerId);
    const player = this.players.get(playerId);
    if (!player) throw new Error(`未注册的播放器: ${playerId}`);
    // debug:传输命令入口留痕。拖动进度条时这里是"一次拖动实际发了几个 seek"的第一手证据
    // (前端有 250ms 防抖,但连拖/多点仍可能并发下发;tid 相同即为同一个请求链)。
    const t0 = Date.now();
    log.debug(`[QueueController][transport] ${playerId} op=${op} arg=${arg}`);
    // seek 冷静期打标必须在**下发之前**:请求在途/重定位进行中就可能有一拍状态上报
    // 落进"设备非 PLAYING"的真空里(见 services/player/seekSettle.ts 顶部注释)。
    if (op === "seek") markSeekIssued(playerId);
    // stop / play 会丢弃当前播放上下文(位置归零或重投),旧的 seek 时刻不再有意义 ——
    // 清掉,避免新上下文里的合法 idle_early 被一条陈旧记录压住。
    if (op === "stop" || op === "play") clearSeekSettle(playerId);
    try {
      if (op === "play") await player.resume();
      else if (op === "pause") await player.pause();
      else if (op === "stop") await player.stop();
      else if (op === "seek") await player.seek(arg!);
      else if (op === "volume") await player.setVolume(arg!);
    } catch (e: any) {
      // 失败按 warn 出(不吞):"拖动后没法播"的第一现场就在这里。
      log.warn(`[QueueController][transport] ${playerId} op=${op} arg=${arg} 失败 ${Date.now() - t0}ms`, { err: e?.message || e });
      throw e;
    }
    log.debug(`[QueueController][transport] ${playerId} op=${op} arg=${arg} 完成 ${Date.now() - t0}ms`);
  }

  /** 读取已注册播放器的实时状态(供 /status 路由;sendspin 等无 SOAP 的设备)。
   *  playerId 支持裸 id 或带前缀,返回 undefined 表示未注册。 */
  async getPlayerState(playerId: string): Promise<PlayerState | undefined> {
    playerId = stripPlayerPrefix(playerId);
    const player = this.players.get(playerId);
    if (!player) return undefined;
    return player.pollState();
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
        // 链路不可用(子进程僵死/重启窗口、RPC 超时)→ **绝不能**把这读数喂给 tracker:
        // 它带着 playbackState=IDLE 的占位值,会凭空造出 PLAYING→IDLE 迁移 → 误判自然
        // 结束 → 切歌 → 位置归零。这里只登记"链路丢了 + 当时的播放位置",等恢复后续播。
        if ((state as any).unavailable) {
          this.noteLinkLost(deviceId, "poll 不可用");
          log.debug(`[QueueController][poll] t=${Date.now()} ${deviceId}: 链路不可用,跳过上报`);
          continue;
        }
        // 链路从"丢"回到"通":先把这一轮的真实状态上报掉,再触发续播。
        // 注意这里只**查**不删 —— 位置快照留在 linkLost 里,由 resumeAfterLinkRecovery
        // 取用(它自己负责清)。先删就会把"离开时的播放位置"丢掉,续播只能从头播。
        const wasLost = this.linkLost.has(deviceId);
        if (typeof state.position === "number" && state.position > 0) this.lastPos.set(deviceId, state.position);
        // state.playerId 已是 "dlna:<deviceId>",直接上报 PlayerController。
        this.ctrls.get(deviceId)?.reportState(state);
        // 轮询快照:debug 级(5s × N 设备,info 下太吵)。排障"进度条回退/不动"时
        // 这条是设备侧的真相来源(与前端 UI 显示的位置对不上即为上报/外推问题)。
        log.debug(`[QueueController][poll] t=${Date.now()} ${deviceId}: state=${state.playbackState} pos=${state.position} dur=${state.duration}`);
        if (wasLost) void this.resumeAfterLinkRecovery(deviceId);
      } catch (e: any) {
        log.warn(`[QueueController][poll] ${deviceId}: ${e?.message || e}`);
      }
    }
  }

  /** 登记「链路不可用」并记住当时的播放位置(幂等:已有记录只刷新位置)。 */
  private noteLinkLost(deviceId: string, reason: string): void {
    const prev = this.linkLost.get(deviceId);
    const pos = this.lastPos.get(deviceId) ?? prev?.pos ?? 0;
    this.linkLost.set(deviceId, { pos, at: prev?.at ?? Date.now(), reason });
  }

  /** 链路恢复(子进程重启完成 / 设备重新可读)后就地续播当前首。
   *
   *  为什么需要它:上面那条"链路不可用期间不接受任何决策"的护栏把误切歌挡住了,
   *  代价是这段时间里没人推进队列 —— 必须有人负责把播放接回去,否则用户看到的是
   *  "卡住后彻底不动了"(比误切歌好,但仍然不对)。
   *  姿势复用组离线看门狗(group/watchdog.ts):先在播则不重复 cast,cast 后把位置
   *  拉回离开时的秒数。 */
  private async resumeAfterLinkRecovery(deviceId: string): Promise<void> {
    const lost = this.linkLost.get(deviceId);
    const q = this.queues.get(deviceId);
    const player = this.players.get(deviceId);
    if (!q || !player || !q.isActive || q.ended || q.currentIndex < 0) {
      this.linkLost.delete(deviceId);
      return;
    }
    if (this.advancing.has(deviceId)) return; // 保留 linkLost,下一拍再试
    // 链路恢复 ≠ 设备回来了:fork 模式 sendspin 子进程重启后要重新拨号、设备要重新入组,
    // 这中间 `poll` 会合法地回 IDLE。此刻盲目 cast 会投进一个不存在的连接(没声音,
    // 状态却显示在播)→ 30s 后又被冻结看门狗判死 → 第 2 次直接放行切歌(曲目乱跳)。
    // 所以先问一句设备在不在;不在就**保留** linkLost,等下一拍(5s 后)再试。
    try {
      const proto = (player as any).getProtocol?.();
      if (proto?.isAvailable && !(await proto.isAvailable())) {
        log.info(`[QueueController] ${deviceId}: 链路恢复但设备尚未回来,等待…`);
        return;
      }
    } catch { return; }
    this.linkLost.delete(deviceId);
    // 已在播(用户手动恢复 / 设备自己接上了)→ 不打断。
    try {
      const st = await player.pollState();
      if (!(st as any).unavailable && st.playbackState === PlaybackState.PLAYING) {
        log.info(`[QueueController] ${deviceId}: 链路恢复但已在播,跳过自动续播`);
        return;
      }
    } catch { return; }
    const pos = lost?.pos ?? this.lastPos.get(deviceId) ?? 0;
    log.warn(`[QueueController] ${deviceId}: 链路恢复(丢失原因:${lost?.reason ?? "-"}),续播当前首@${Math.round(pos)}s`);
    await this.recoverInPlace(deviceId, pos);
  }

  /** 重启后恢复:对照原 QueueManager.resumeActive。设备有活跃队列时续播当前首。 */
  async resumeActive(deviceId: string, baseUrl: string): Promise<void> {
    deviceId = stripPlayerPrefix(deviceId);
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
    this.schedulePreProbe(deviceId);
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

    // P3-1:flow 会话驱动的设备 —— 它拉的是一条多曲连续流,设备侧上报的 position/duration
    // 不再对应单曲,tracker 必然算出"该切歌",但那条流自己会接着播下一首。此时重投
    // SetAVTransportURI 会打断正在播的流(听感 = 每次切歌都断一次)。队列推进改由出流侧
    // 在曲目边界调 `flowAdvance()` 静默完成,切歌决策在这里一律吞掉。
    // `ended` 不吞:流自然结束(= 会话跑完)时仍要走 markEnded,否则 UI 永远停在"播放中"。
    // `idle_early` 也吞:同一原因 —— 这条流的位置/时长不对应单曲,按单曲时长的判据在这里无意义。
    if (this.flowOwned.has(id)
        && (decision === "advance" || decision === "track_changed" || decision === "idle_early")) return;

    if (decision === "idle_early") {
      // seek 冷静期:刚下发过 seek → 后端正在按新的 `-ss` 重起 ffmpeg,这段时间设备
      // **必然**有一小段非 PLAYING。若照常走下面的复查,几乎必然探到非 PLAYING →
      // 误判"设备确实停了" → 放行切歌 → 位置归零(用户观感:「拖动后进度条跳回去了」)。
      // 真机实证见 services/player/seekSettle.ts 顶部。冷静期内一律按真空撤销。
      if (withinSeekSettle(id)) {
        this.ctrls.get(id)?.resetTracker(playerId);
        logSeekSettleSuppressed(playerId, "idle_early");
        return;
      }
      // IDLE 但进度远未到已知时长 → 高度怀疑是误报(SOAP 抖动 / 链路瞬断)。
      // 不直接切歌:立刻复查一次设备真实状态 ——
      //   · 复查到 PLAYING → 确认误报,重置 tracker 后静默返回(这首歌继续播);
      //   · 复查仍非 PLAYING → 设备确实停了(用户按停 / 真的播不动),放行切歌。
      // 没有这道复查的话,真停了的场景要等 60s 的 stalled 兜底才推进。
      try {
        const st = await this.players.get(id)?.pollState();
        // 读不到真实状态(子进程僵死/重启窗口、链路 RPC 超时)→ **绝不能**按"设备确实
        // 停了"放行切歌 —— 那正是"进度条归零 / 曲目乱跳"的来源。登记链路丢失,等恢复续播。
        if ((st as any)?.unavailable) {
          this.noteLinkLost(id, "idle_early 复查不可用");
          this.ctrls.get(id)?.resetTracker(playerId);
          log.warn(`[QueueController][idle_early] ${playerId}: 链路不可用,复查不到真实状态 → 暂不放行`);
          return;
        }
        if (st?.playbackState === PlaybackState.PLAYING) {
          this.ctrls.get(id)?.resetTracker(playerId);
          log.warn(`[QueueController][idle_early] ${playerId}: IDLE 误报已撤销(pos=${Math.round(st.position)}/${Math.round(st.duration)}),继续播放`);
          return;
        }
      } catch (e: any) {
        log.warn(`[QueueController][idle_early] ${playerId}: 复查失败,按真结束处理`, { err: e?.message || e });
      }
      log.warn(`[QueueController][idle_early] ${playerId}: 复查确认已停,放行切歌`);
    }
    if (decision === "advance" || decision === "track_changed" || decision === "idle_early") {
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
        // 切歌后重算预探测窗口(滑动缓冲:头随播放消费,尾持续补探)。
        this.schedulePreProbe(id);
      } finally {
        this.advancing.delete(id);
      }
      return;
    }
    if (decision === "ended") {
      if (!this.shouldSuppressGroupEnd(id)) this.markEnded(id);
      return;
    }
    if (decision === "frozen") {
      // 设备报 PLAYING 但位置冻结(链路活着、音频不前进)。**就地重投当前首 + 拉回位置**,
      // 而不是切歌 —— 切歌正是用户抱怨的"进度条归零 / 曲目乱跳"。
      // 判据与真机依据见 PlaybackTracker.FREEZE_TIMEOUT_MS。
      if (!q.isActive || q.ended) return;
      if (this.advancing.has(id)) return;
      // 链路本身就丢了(子进程僵死)→ 交给恢复路径,别在这里叠一次重投。
      if (this.linkLost.has(id)) return;
      // seek 冷静期:刚下发过 seek 时位置本就不该动(ffmpeg 正按新的 -ss 重起),
      // 此刻判 frozen 是误报 → 撤销,并清掉已派发的信号让检测重新武装。
      if (withinSeekSettle(id)) {
        this.ctrls.get(id)?.resetTracker(playerId);
        logSeekSettleSuppressed(playerId, "frozen");
        return;
      }
      // 与 idle_early 对称的反证:复查一次,位置确实在推进 → 是误报(采样粒度),
      // 撤销并重新武装,不打扰正在播的这首。
      try {
        const st = await this.players.get(id)?.pollState();
        const base = this.lastPos.get(id) ?? 0;
        if (st && !(st as any).unavailable
            && st.playbackState === PlaybackState.PLAYING
            && st.position > base + 0.5) {
          this.lastPos.set(id, st.position);
          this.ctrls.get(id)?.resetTracker(playerId);
          log.info(`[QueueController][frozen] ${playerId}: 位置已恢复推进(pos=${Math.round(st.position)}),撤销`);
          return;
        }
      } catch (e: any) {
        log.warn(`[QueueController][frozen] ${playerId}: 复查失败`, { err: e?.message || e });
      }
      // 同一首连续计数(与 stalled 共用):重投 1 次兜瞬时僵死,第 2 次说明这首就是推不动
      // → 放行切歌。没有这个上限的话,一首死源会每 30s 重投一次,永远原地打转。
      const frozenSongId: string | undefined =
        q.currentIndex >= 0 ? q.items[q.currentIndex]?.songId : undefined;
      const prevFz = this.stallCounters.get(id);
      const frozenCount = prevFz && prevFz.songId === frozenSongId ? prevFz.count + 1 : 1;
      this.stallCounters.set(id, { songId: frozenSongId, count: frozenCount });
      if (frozenCount >= 2 && frozenSongId !== undefined) {
        const nextIdx = this.pickNext(q, false);
        if (nextIdx !== -1 && nextIdx !== q.currentIndex) {
          log.warn(`[QueueController] ${id}: ${frozenSongId} 冻结重投 ${frozenCount} 次仍不动,放行切歌`);
          this.stallCounters.delete(id);
          this.advancing.add(id);
          try {
            q.currentIndex = nextIdx;
            q.ended = false;
            await this.playCurrent(id, baseUrl);
            this.persist(id);
            this.emit("queue_changed", id, this.snapshot(id));
            this.schedulePreProbe(id);
          } finally {
            this.advancing.delete(id);
          }
          return;
        }
      }
      log.warn(`[QueueController][frozen] ${playerId}: PLAYING 但位置冻结@${Math.round(this.lastPos.get(id) ?? 0)}s,就地重投并拉回位置`);
      await this.recoverInPlace(id, this.lastPos.get(id) ?? 0);
      return;
    }
    if (decision === "stalled") {
      // 已结束 / 未激活的队列不重投(2026-09-21 新增护栏)。
      // 卡死阈值从(生产里不可达的)60s 降到 15s 后这条路径才**真正可达**,而它原先
      // 全程不看 q.isActive/q.ended —— 触发时会把一个「整队已播完」的队列重新 cast 起来。
      // 放在最前:先于任何 pollState / 计数 / 重投,零副作用。
      if (!q.isActive || q.ended) return;
      if (this.advancing.has(id)) return;
      // 回归修复:乐观窗口 5s 未确认 PLAYING 会触发 stalled,但 HiVi 等真实设备的
      // PLAYING 确认(GENA 或 5s 轮询,cast 期间 advancing 还会跳过轮询)常晚于 5s。
      // 此时盲目重投会把"已在播放"的设备打断 → 歌曲前几秒无限重复。
      // 先轮询设备真实状态:确在播放 → 静默关闭乐观窗口并重置 tracker,绝不重投。
      try {
        const state = await this.players.get(id)?.pollState();
        // 链路不可用(子进程僵死/重启窗口、RPC 25s 超时)→ 既不能重投也不能切歌:
        //  · 重投会把命令抛进一个已经堵死的 IPC,只会再造一次 25s 超时;
        //  · 切歌(下面的连续卡死计数)正是"曲目乱跳 + 位置归零"的来源。
        // 正确动作是**什么都不做**,登记链路丢失,等子进程回归后 resumeAfterLinkRecovery
        // 续播当前首。真机依据:心跳停摆的 95s 里正是这条路径放行了切歌(2026-09-21)。
        if ((state as any)?.unavailable) {
          this.noteLinkLost(id, "stalled 复查不可用");
          this.ctrls.get(id)?.resetTracker(playerId);
          log.warn(`[QueueController][stalled] ${playerId}: 链路不可用(子进程/链路丢失),不重投也不切歌,等恢复续播`);
          return;
        }
        if (state?.playbackState === PlaybackState.PLAYING) {
          this.ctrls.get(id)?.endOptimistic(playerId);
          this.ctrls.get(id)?.resetTracker(playerId);
          // 确认在播:清掉卡死计数(之前若有抖动攒的数作废)。
          this.stallCounters.delete(id);
          return;
        }
      } catch (e: any) {
        log.warn("切歌前状态检查失败,继续播放", { playerId, err: e?.message || e });
      }
      // 同一首连续卡死计数:第 1 次重投兜 transient,第 2 次起放行切歌。
      // 否则死源(404/解码失败)会 2-3 秒无限重播同一首,队列永远不推进。
      const q0 = this.queues.get(id);
      const curSongId: string | undefined =
        q0 && q0.currentIndex >= 0 ? q0.items[q0.currentIndex]?.songId : undefined;
      const prev = this.stallCounters.get(id);
      const stallCount = prev && prev.songId === curSongId ? prev.count + 1 : 1;
      this.stallCounters.set(id, { songId: curSongId, count: stallCount });
      if (stallCount >= 2 && curSongId !== undefined) {
        const q = this.queues.get(id);
        if (q) {
          const nextIdx = this.pickNext(q, false);
          if (nextIdx !== -1 && nextIdx !== q.currentIndex) {
            log.warn(`[QueueController] ${id}: ${curSongId} 连续卡死 ${stallCount} 次,放行切歌`);
            this.stallCounters.delete(id);
            this.advancing.add(id);
            try {
              q.currentIndex = nextIdx;
              q.ended = false;
              await this.playCurrent(id, baseUrl);
              this.persist(id);
              this.emit("queue_changed", id, this.snapshot(id));
              this.schedulePreProbe(id);
            } finally {
              this.advancing.delete(id);
            }
            return;
          }
        }
      }
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
  /** 设备所属的、**正在播放**的组（无则 undefined）。设备可同时属于多个组，取第一个
   *  队列处于激活态的。**对外公开**：HTTP 层的「显式操控成员 ⇒ 自动脱离」靠它定位
   *  该把设备从哪个组摘出来；`isMemberOfActiveGroup` 亦复用本方法，判定单源。 */
  activeGroupOfDevice(deviceId: string): string | undefined {
    const gids = getGroupManager().groupsOfDevice(deviceId);
    return gids.find(gid => !!this.queues.get(gid)?.isActive);
  }

  private isMemberOfActiveGroup(deviceId: string): boolean {
    return this.activeGroupOfDevice(deviceId) !== undefined;
  }

  /** 悬挂时清空组的 tracker 状态(lastPlaying):成员回归后 leader 报 NO_MEDIA_PRESENT→
   *  IDLE 时,若 lastPlaying 还在,tracker 会误判"曲目结束"而 deactivate 队列(此时成员已在线,
   *  shouldSuppressGroupEnd 拦不住),看门狗将无法续播。清空后单发 IDLE 不触发 ended。 */
  resetGroupTracker(groupId: string): void {
    groupId = stripPlayerPrefix(groupId);
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

  /** 整队无源:停止推进并上报。**不 markEnded、不删队列** —— 保留现场,
   *  等负缓存(45s TTL)过期后,下一次推进(用户操作 / 设备决策)自然重试。
   *  与「扫描枯竭」共用同一状态位 preProbe.exhausted,Web 端只需认一个布尔值。 */
  private reportAllUnplayable(playerId: string): void {
    getPreProbeScheduler().markAllUnplayable(playerId); // 内部经 onChange 广播 queue_changed
    this.persist(playerId);
  }

  /** 组队列的"结束"决策在成员全离线时应被抑制:那是 leader 离线导致的假 IDLE,
   *  队列要保留给看门狗做"悬挂 + 成员回归自动恢复"。在线判定跨 kind
   *  (dlna 可达或 sendspin 在线任一)。 */
  private shouldSuppressGroupEnd(id: string): boolean {
    if (!getGroupManager().get(id)) return false;
    return !hasOnlineMember(id);
  }

  private pickNext(q: QueueData, nativeGapless: boolean): number {
    const n = q.items.length;
    if (n === 0) return -1;
    if (q.playMode === "one") return q.currentIndex;
    if (q.playMode === "shuffle") return this.shuffleNextIndex(q);
    if (q.playMode === "all") {
      if (q.currentIndex + 1 < n) return q.currentIndex + 1;
      return 0;
    }
    // order
    if (q.currentIndex + 1 < n) return q.currentIndex + 1;
    return -1;
  }

  /** 重建洗牌序列:队列 index 打乱(一轮内不重复)。
   *  keepCurrent:当前曲保留在序列头部——随机起播/跳播/队列增删后"上一首"
   *  仍能沿序列回退(旧实现把当前曲排除出序列且 pos=-1,导致随机起播曲成为
   *  "序列外"孤曲,自动切歌后 prev 要求 pos>0 而切不回去)。 */
  private rebuildShuffle(q: QueueData, opts?: { keepCurrent?: boolean }): void {
    const n = q.items.length;
    const idxs: number[] = [];
    for (let i = 0; i < n; i++) {
      if (opts?.keepCurrent && i === q.currentIndex) {
        idxs.unshift(i); // 当前曲固定在序列头
      } else {
        idxs.push(i);
      }
    }
    // Fisher-Yates(不动头部当前曲)
    for (let i = 1; i < idxs.length; i++) {
      const j = 1 + Math.floor(Math.random() * i);
      [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
    }
    q.shuffleOrder = idxs;
    q.shufflePos = opts?.keepCurrent && q.currentIndex >= 0 ? 0 : -1; // 当前曲在新序列头
    q.shuffleLen = n;
  }

  /** 队列增删(长度变化)后序列失效 → 惰性重建(保留当前曲)。 */
  private ensureShuffleReady(q: QueueData): void {
    if (q.shuffleLen !== q.items.length) this.rebuildShuffle(q, { keepCurrent: true });
  }

  /**
   * 触发预探测前的洗牌序就绪(2026-09-11 修复)。
   *
   * `peekUpcomingPositions` 的 shuffle 分支依赖 `shuffleOrder`,而它此前**只在
   * 「真的推进」(shuffleNextIndex)时才惰性重建**。于是那些「改队列/改模式后立即
   * 触发预探测」的路径(enqueue / setPlayMode / removeAt)会拿着空或过期的序列去扫
   * → shuffle 模式下 lookahead 静默扫 0 个位置。
   *
   * 实测(同一台设备、同为 shuffle):`queue/play`(playFrom→setQueue 已物化序列)
   * 扫 4 个位置;`queue/enqueue`(从不物化)扫 0 个。修复即把既有的惰性重建提前到
   * 被预探测看见的时刻 —— 不引入新的洗牌语义,重建结果与 shuffleNextIndex 一致。
   */
  private ensureShuffleForLookahead(q: QueueData): void {
    if (q.playMode === "shuffle") this.ensureShuffleReady(q);
  }

  /** 洗牌序下一首:沿序列前进,播完一轮自动重洗;无可播返回 -1。 */
  private shuffleNextIndex(q: QueueData): number {
    this.ensureShuffleReady(q);
    const order = q.shuffleOrder || [];
    if ((q.shufflePos ?? -2) + 1 >= order.length) {
      this.rebuildShuffle(q, { keepCurrent: true });
      if (!q.shuffleOrder || q.shuffleOrder.length === 0) return -1;
      // 重建后当前曲在序列头(pos=0):下一首取第 2 位(避开当前曲);仅 1 首则重播当前。
      q.shufflePos = 0;
      if (q.shuffleOrder.length > 1) q.shufflePos++;
      return q.shuffleOrder![q.shufflePos!];
    }
    q.shufflePos = (q.shufflePos ?? -1) + 1;
    return q.shuffleOrder![q.shufflePos!];
  }

  /**
   * 判断某首是否应**跳过**。只有「明确的、未过期的不可播判定」才允许跳 ——
   * 无记录 / 已过期 / 网络异常一律视为未知 → 照常播放。
   *
   * **绝不把「不知道」当成「死的」** —— 这是 2026-09-11 拆除永久拉黑时定下的边界。
   */
  private async judgePlayable(item: QueueItem): Promise<"skip" | "play"> {
    // 1) 缓存判定(预探测的成果)→ 零成本。热路径上多数歌在这里就返回了。
    //    正缓存(1 小时 TTL)不盲信:扫描时活、播时死是常态(直链下架),在线直链
    //    做一次短超时复核 —— 与预探测扫描共用 recheckOnlineDirect(同一把尺子)。
    const cached = getCachedPlayability(item.songId);
    if (cached === "unplayable") return "skip";
    if (cached === "playable") {
      let songRow: any = null;
      try {
        songRow = db.select().from(songs).where(eq(songs.id, item.songId)).get();
      } catch { /* 读库异常按原判放行 */ }
      const { recheckOnlineDirect, evictStreamFallbackCache, ensurePlayableStream } =
        await import("../source/online/streamFallback.js");
      const rc = await recheckOnlineDirect(songRow, 2500);
      if (rc !== "gone") return "play";
      // 直链明确已死:逐出正缓存,找兄弟/远程替代;无替代 → skip。
      // 这是知识(404 照妖镜),不是"未知" —— 不违"不把不知道当成死的"边界。
      evictStreamFallbackCache(item.songId);
      try {
        if (await ensurePlayableStream(songRow ?? { id: item.songId }, 8000)) return "play";
      } catch { /* 落到跳过 */ }
      log.info(`[QueueController][judge] ${item.songId}: 直链已死且无替代,跳过`);
      return "skip";
    }

    let songRow: any;
    try {
      songRow = db.select().from(songs).where(eq(songs.id, item.songId)).get();
    } catch {
      return "play";
    }
    if (!songRow) return "play";

    // 2) 统一裁决(与 /rest/stream 同口径,见 source/resolveAudio):
    //    快缓存 → 优选换行(含验证) → 本行探测 → 本行复核。
    //    definitive(本地文件确死)直接判 skip;未知走宽容尾巴(旧语义不变)。
    const { resolvePlayableRow } = await import("../source/resolveAudio.js");
    const r = await resolvePlayableRow(item.songId);
    if (r.row) return "play";
    if (r.definitive) {
      log.info(`[QueueController][judge] ${item.songId}: 确定无源(${r.reason}),跳过`);
      return "skip";
    }
    log.info(`[QueueController][judge] ${item.songId}: 无可播行(${r.reason}),进宽容尾巴`);
    // 返回 null 时再确认是「没有源」还是「网络抖动」—— 抖动不跳,照常试播。
    return getCachedPlayability(item.songId) === "unplayable" ? "skip" : "play";
  }

  /** 就地恢复当前首:重投(cast)+ 把播放位置拉回 `pos` 秒。
   *
   *  两条自愈路径共用:
   *    ① tracker 判 `frozen` —— 设备报 PLAYING 但位置冻结(链路活着、音频不前进);
   *    ② 链路/子进程丢失后回归(linkLost 已登记)。
   *  共同点:**不该切歌,只该把当前这首重新推起来**。切歌正是用户抱怨的"进度条归零 /
   *  曲目乱跳",所以恢复一律围绕当前曲做。
   *
   *  位置校准复用组离线看门狗(group/watchdog.ts)的同款姿势:cast 会让设备从头播,
   *  所以 cast 之后再 seek 到目标位置。seek 失败不阻断 —— 至少已经重新出声了,
   *  比永远卡住强。seek 前必须 markSeekIssued:否则随后的重定位真空会被
   *  `idle_early` 判成"真结束"→ 又切歌(见 seekSettle.ts)。 */
  private async recoverInPlace(deviceId: string, pos: number): Promise<void> {
    const player = this.players.get(deviceId);
    const ctrl = this.ctrls.get(deviceId);
    if (!player || !ctrl) return;
    if (this.advancing.has(deviceId)) return;
    const playerId = player.playerId;
    this.advancing.add(deviceId);
    try {
      await this.playCurrent(deviceId, getEffectiveBaseUrl());
      // 减 1s 抵消 cast 的启动开销(设备真正出声常晚于 Play 命令),避免定位略超前。
      const target = Math.max(0, pos - 1);
      if (target > 1) {
        markSeekIssued(deviceId);
        try {
          await player.seek(target);
          // ⚠️ 不要在这里写 lastPos:那是「**设备告诉我们**的最后位置」,不是我们的意图。
          // 写了会把补偿 seek 的目标当成新的基线,下一次 frozen 复查就会把设备仍在报的
          // 旧读数(高于 seek 目标)误判成"位置恢复了"→ 撤销 → 冻结永远修不掉。
          // 真机依据:重投到 172.6s、设备仍报 173.6s → 复查判"已推进"→ 取消恢复。
          log.info(`[QueueController][recover] ${playerId}: 已重投并拉回位置@${Math.round(target)}s`);
        } catch (e: any) {
          log.warn(`[QueueController][recover] ${playerId}: 重投成功但位置拉回失败(从头播):${e?.message || e}`);
        }
      } else {
        log.info(`[QueueController][recover] ${playerId}: 已重投(位置 0,无需校准)`);
      }
    } finally {
      this.advancing.delete(deviceId);
    }
  }

  private async playCurrent(deviceId: string, baseUrl: string): Promise<void> {
    const q = this.queues.get(deviceId);
    const player = this.players.get(deviceId);
    const ctrl = this.ctrls.get(deviceId);
    if (!q || !player || !ctrl) return;

    // ==================== 不可播裁决 + 跳过循环 ====================
    //
    // **2026-09-11 拍板:留队列跳过,不再摘除。**
    //
    // 旧行为是「探不到就 removeAt 摘掉」,三个副作用:
    //   1. 队列在播放中自己变短,与客户端 / Web 上看到的队列视图对不上;
    //   2. 长度一变,下次 shuffleNextIndex 会 ensureShuffleReady → rebuildShuffle
    //      整段重排 —— 用户听感是「随机播放听着听着顺序全变了」;
    //   3. 不可逆:源恢复后该曲也回不来了(与「说不定以后就有有效源」冲突)。
    //
    // ⚠️ 旧实现的**隐式终止条件**是「摘除后队列越来越短,绕几圈自然收敛」。
    //    改成留队列之后这个条件消失了 —— 整队死源 + all/shuffle = 无限循环。
    //    所以必须有**绕过圈上限(= 队列长度)**。客户端早已有同款上限
    //    (dlna_manager.dart 的 probeSkips >= _queue.length),服务端此前缺失。
    const skipLimit = Math.max(1, q.items.length);
    let skips = 0;
    let item = q.currentIndex >= 0 ? q.items[q.currentIndex] : undefined;
    while (item) {
      const verdict = await this.judgePlayable(item);
      if (verdict === "play") break;

      if (skips >= skipLimit) {
        log.warn(`[QueueController][playCurrent] ${deviceId}: 整队无源(已跳过 ${skips} 首),停止推进`);
        this.reportAllUnplayable(deviceId);
        return;
      }
      const nextIdx = this.pickNext(q, false);
      if (nextIdx === -1 || nextIdx === q.currentIndex) {
        // order 播到末尾 / one 模式:无处可跳 → 停止推进。
        log.warn(`[QueueController][playCurrent] ${deviceId}: 无可跳位置(数列末尾/单曲循环),停止推进`);
        this.reportAllUnplayable(deviceId);
        return;
      }
      log.info(`[QueueController][playCurrent] ${deviceId}: song ${item.songId} 无可用音源,跳过(留在队列)`);
      q.currentIndex = nextIdx;
      skips++;
      item = q.items[q.currentIndex];
    }
    if (!item) return;
    if (skips > 0) {
      // 跳过改了游标 → 立即同步(客户端 / Web / HA 的界面要跟上)。
      this.persist(deviceId);
      this.emit("queue_changed", deviceId, this.snapshot(deviceId));
    }

    // 只带 songId 的 item(HA/脚本下发)补全元数据,否则 castToDevice 的
    // buildDidlLite/escapeXml 会因 title/mime 缺失抛错。
    const fullItem = await this.resolveItem(item);
    // PlayerController 的 key 取 player 自身完整 id(dlna:<id> 或 group:<gid>)。
    const playerId = player.playerId;
    log.info(`[QueueController][playCurrent] t=${Date.now()} ${playerId}: idx=${q.currentIndex} songId=${item.songId}`);
    try {
      // 注入本曲已知时长(供结束判定)。必须在 cast 之前:castToDevice 期间的
      // GENA 瞬态也会喂给 tracker,那时就要有正确的时长;且 resetTracker 不清此值。
      // flow 会话驱动的设备注入 0(= 未知):它拉的是一条多曲连续流,设备侧的
      // position/duration 不对应单曲,按单曲时长判定必然误判(见 flowOwned 注释)。
      // 用可选调用:这是纯内存注入,即便调用方(测试替身)未实现该方法,也绝不能
      // 影响起播 —— 静默跳过即退化为"时长未知"(= 改动前的行为)。
      ctrl.setExpectedDuration?.(playerId, this.flowOwned.has(deviceId) ? 0 : this.knownDuration(fullItem));
      // 乐观窗口必须在 cast 之前开启:castToDevice 内部 Stop→SetAVTransportURI→Play
      // 会触发 GENA STOPPED/TRANSITIONING/PLAYING 事件。若窗口在 cast 之后才开,
      // 设备在 cast 期间上报的 PLAYING 会先于窗口开启到达 → 窗口永远等不到 PLAYING
      // → 5s 超时 → stalled → 重播当前首 → 死循环。
      // 对照 MA:命令发出前先把 _attr_playback_state = PLAYING(乐观设态)。
      ctrl.beginOptimistic(playerId, "pending");
      // debug:cast 三连(Stop→SetAVTransportURI→Play)的起点 + 目标流地址。
      // 拖动"投不出去"时,配合下面完成行的耗时能看出是设备慢还是链路断了。
      const castT0 = Date.now();
      log.debug(`[QueueController][cast] ${playerId} 起点 idx=${q.currentIndex} song=${fullItem.songId} baseUrl=${baseUrl} dur=${this.knownDuration(fullItem)}`);
      const { mediaUri } = await player.playMedia(fullItem, baseUrl);
      log.debug(`[QueueController][cast] ${playerId} 完成 ${Date.now() - castT0}ms mediaUri=${mediaUri}`);
      // cast 命令已送达 → 断开连续失败链(下面的 catch 才计失败)。
      this.castFailStreak.delete(deviceId);
      // 乐观窗口阶段 2:命令已送达,现在才起 5s「等设备确认 PLAYING」计时。
      // 拆开的理由见 PlayerController 文件头 —— 合在一起时那 5s 会被 Stop→SetURI→Play
      // 三次 SOAP 往返吃掉,判出的 stalled 只是「命令还没发出去」。
      ctrl.armOptimisticTimeout?.(playerId);
      // cast 命令已发出,重置 tracker:清掉上一首的 prev 状态 + 残留去抖,
      // 避免上一首的 PLAYING→IDLE 迁移再次触发 advance(对照 MA play_index 后清 prev_state)。
      // 乐观窗口保持开启,等设备上报 PLAYING 确认成功(cast 期间已屏蔽瞬态 IDLE)。
      ctrl.resetTracker(playerId);
      void mediaUri;
    } catch (e: any) {
      console.warn(`[QueueController][playCurrent] ${playerId}: cast FAILED:`, e?.message || e);
      ctrl.endOptimistic(playerId);
      // cast 失败**不能静默**:endOptimistic 关掉了乐观窗口的兜底,若这里什么都不做,
      // 这首既不会重投也不会切歌 —— 队列就此停死(设备瞬时离线时表现为"再也不播了")。
      // 先按「一整圈」封顶:stallCounters 允许每首 2 次重投,故连续失败上限取 2×曲数,
      // 到顶说明整队都投不出去 → 停止推进,等负缓存(45s)过期后由用户操作自然重试。
      const streak = (this.castFailStreak.get(deviceId) ?? 0) + 1;
      this.castFailStreak.set(deviceId, streak);
      if (streak >= Math.max(2, 2 * q.items.length)) {
        log.warn(`[QueueController][playCurrent] ${deviceId}: 连续 ${streak} 次 cast 失败,整队投不出去,停止推进`);
        this.reportAllUnplayable(deviceId);
        return;
      }
      // 交给既有 stalled 通道:pollState 复查 → 每首最多重投 1 次 → 第 2 次放行切歌。
      // 必须延到下一个宏任务:此刻调用方的 `advancing` 尚未释放(playCurrent 是在
      // try/finally 里被 await 的),直接调会被 handleDecision 的 advancing 守卫吞掉。
      setTimeout(() => { void this.handleDecision("stalled", playerId); }, 0);
    }
  }

  /** 当前曲的已知时长(秒):队列项自带 → 曲库兜底 → 0(未知)。
   *  只用曲库/队列项的值,不采信设备自报 duration(有设备恒 0 或乱报)。 */
  private knownDuration(item: QueueItem): number {
    if (typeof item.duration === "number" && item.duration > 0) return item.duration;
    try {
      const row = db.select({ duration: songs.duration }).from(songs).where(eq(songs.id, item.songId)).get();
      if (typeof row?.duration === "number" && row.duration > 0) return row.duration;
    } catch { /* 库不可读 → 未知 */ }
    return 0;
  }

  /** 只带 songId 的 item(HA/脚本/持久化恢复)在 cast 前补全元数据。
   *  public:sendspin 的 ProtocolPlayer.resume() 冷起播要自行补全后再 playMedia
   *  (见 protocolPlayer.ts 注释),不能只依赖 playCurrent 内部调用。 */
  async resolveItem(item: QueueItem): Promise<QueueItem> {
    if (item.title && item.mime) return item;
    try {
      const s = db.select().from(songs).where(eq(songs.id, item.songId)).get();
      if (!s) return item;
      // 专辑艺术家/年份在 albums 表。单曲解析,一次点查即可。
      const al = s.albumId ? db.select().from(albums).where(eq(albums.id, s.albumId)).get() : undefined;
      return {
        songId: item.songId,
        title: item.title || s.title || "未知",
        artist: item.artist ?? s.artist ?? undefined,
        album: item.album ?? s.album ?? undefined,
        albumId: item.albumId ?? s.albumId ?? undefined,
        mime: item.mime || suffixToMime(s.suffix || ""),
        coverArt: item.coverArt ?? s.coverArt ?? undefined,
        duration: typeof item.duration === "number" ? item.duration : typeof s.duration === "number" ? s.duration : undefined,
        // 0 / 空串在库里代表"未知",归一成 undefined —— 否则 HA 会老老实实
        // 显示出「第 0 轨」「0 年」。
        track: item.track ?? (s.track || undefined),
        discNumber: item.discNumber ?? (s.discNumber || undefined),
        albumArtist: item.albumArtist ?? (al?.artist || s.artist || undefined),
        year: item.year ?? (al?.year || undefined),
        genre: item.genre ?? (s.genre || al?.genre || undefined),
      };
    } catch {
      return item;
    }
  }

  // ==================== 公共 API(供路由调用,保持原 QueueManager 形状)====================
  /** 仅设数据,不触发播放(供测试 + playFrom 复用)。 */
  setQueue(playerId: string, items: QueueItem[], startIndex: number, baseUrl: string): void {
    playerId = stripPlayerPrefix(playerId);
    // 整队替换 → 旧队列上的 flow 会话作废（它的曲目列表已经不是这条队列了）。
    this.flowOwned.delete(playerId);
    // 整队替换 → 上一轮队列攒的连续 cast 失败计数一起作废(新队列是一次全新的尝试)。
    this.castFailStreak.delete(playerId);
    let q = this.queues.get(playerId);
    if (!q) { q = { items: [], currentIndex: -1, playMode: "shuffle", isActive: false, ended: false }; this.queues.set(playerId, q); }
    q.items = items;
    q.currentIndex = Math.max(-1, Math.min(items.length - 1, startIndex));
    if (q.playMode === "shuffle" && items.length > 1) this.rebuildShuffle(q, { keepCurrent: true });
    q.isActive = true;
    q.ended = false;
    // 整队替换 → 旧队列的预探测状态(含枯竭告警)全部作废。
    getPreProbeScheduler().clear(playerId);
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
    this.schedulePreProbe(playerId);
  }

  /**
   * 用新队列替换当前队列并从 `startIndex` 开始播放。
   *
   * **起点归属（2026-09-14 拍板，对齐纯 web 前端）：随机洗牌的唯一权威在服务端，
   * 起播位置「整列表播放」时服务端随机挑首，「指定某首」时调用方说了算。**
   *
   * 分界线：起播是"整列表播放"还是"指定某首"，以 `startIndex` 是否**指向居中的
   * 具体一首**为准 ——
   * - `startIndex` 为 `null`/`undefined`/负数/`0`（未给起点，或默认从第 1 首开始）
   *   → 视为**整列表播放**：shuffle 且多于 1 首时，服务端随机挑首（随机只发生在
   *   服务端这一处，客户端不再自行洗牌；与纯 web 前端 `localPlayQueue`/`castPlayQueue`
   *   的"整列表 shuffle 无条件随机"一致）;
   * - `startIndex` 为**正整数**（如音流/HA 投"这首歌单的第 N 首"）与**恢复断点**
   *   （`snapshot().currentIndex` 续播）→ 调用方明确指定了居中某首，**必须尊重**，
   *   不随机化起播位置。
   *
   * 历史 bug（2026-09-10 曾反向修过一次，现已按上拆解重新收敛）：本方法曾在
   * shuffle 下无条件 `Math.random() * items.length` 自行挑首，把调用方指定的居中
   * 起点整个丢掉（客户端投歌单第 560/3117/3206 首却播了别的）。修正为只对
   * "整列表播放"随机，居中指定的仍尊重。
   *
   * 后续自动切歌一律走服务端 `shuffleOrder`（`pickNext`/`rebuildShuffle`），
   * 并通过 `snapshot().shuffleOrder` 下发，客户端镜像显示。
   */
  async playFrom(
    playerId: string,
    items: QueueItem[],
    startIndex: number | null | undefined,
    baseUrl: string,
  ): Promise<number> {
    playerId = stripPlayerPrefix(playerId);
    const mode = this.queues.get(playerId)?.playMode ?? "shuffle";
    // 整列表播放 = 未给起点 / startIndex<=0（默认从第 1 首开始）。指定居中某首(>0)则尊重。
    const listStart = !(typeof startIndex === "number" && Number.isInteger(startIndex) && startIndex > 0);
    // 整列表播放 + 随机模式 + 多于 1 首 → 服务端随机挑首（唯一的随机点）。
    const idx = !listStart
      ? (startIndex as number)
      : mode === "shuffle" && items.length > 1
        ? Math.floor(Math.random() * items.length)
        : 0;
    this.setQueue(playerId, items, idx, baseUrl);
    if (!this.advancing.has(playerId)) {
      this.advancing.add(playerId);
      try { await this.playCurrent(playerId, baseUrl); }
      finally { this.advancing.delete(playerId); }
      this.schedulePreProbe(playerId);
    }
    // 返回**实际起播下标**（可能是服务端随机的），供路由如实回执。
    return this.queues.get(playerId)?.currentIndex ?? idx;
  }

  /** 用户从媒体库点某首歌 → 加入队列后"跳播"到该曲。即使处于随机模式也严格尊重
   *  指定索引(随机只作用于后续自动续播,显式"播这首歌"不应被随机化)。
   *  与 playFrom 的区别:playFrom 是**整队替换**并定位到起点,本方法只移动游标。 */
  async jumpTo(playerId: string, index: number, baseUrl: string): Promise<void> {
    playerId = stripPlayerPrefix(playerId);
    const q = this.queues.get(playerId);
    if (!q) return;
    if (!Number.isInteger(index) || index < 0 || index >= q.items.length) return;
    if (this.advancing.has(playerId)) return;
    this.advancing.add(playerId);
    try {
      q.currentIndex = index;
      q.isActive = true;
      q.ended = false;
      // 随机模式下跳播后重建序列:当前曲固定到新序列头,避免 next/prev 沿用旧
      // shufflePos 错位(旧 pos 指向跳播前的位置,切歌会跳到无关的歌)。
      if (q.playMode === "shuffle") this.rebuildShuffle(q, { keepCurrent: true });
      await this.playCurrent(playerId, baseUrl);
      this.persist(playerId);
      this.emit("queue_changed", playerId, this.snapshot(playerId));
      this.schedulePreProbe(playerId);
    } finally {
      this.advancing.delete(playerId);
    }
  }

  setPlayMode(playerId: string, mode: PlayMode): void {
    playerId = stripPlayerPrefix(playerId);
    const q = this.queues.get(playerId); if (!q) return;
    q.playMode = mode;
    // 切到 shuffle 时旧序列可能为空/过期(此前只在推进时惰性重建)→ 先物化,
    // 否则紧随其后的预探测在 shuffle 分支拿空序列扫 0 个位置。
    this.ensureShuffleForLookahead(q);
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
    // 改播放模式 → 窗口位置整体重算。**重算 ≠ 重探**:已探过的曲直接复用缓存,
    // 只补缺口。同时清掉枯竭冷却 —— 队列构成/顺序变了,旧的"大面积无源"结论作废。
    getPreProbeScheduler().clearCooldown(playerId);
    this.schedulePreProbe(playerId);
  }

  async next(playerId: string, baseUrl: string): Promise<void> {
    playerId = stripPlayerPrefix(playerId);
    const q = this.queues.get(playerId); if (!q) return;
    const idx = this.pickNext(q, false);
    if (idx === -1) { this.markEnded(playerId); return; }
    if (this.advancing.has(playerId)) return;
    this.advancing.add(playerId);
    try { q.currentIndex = idx; q.ended = false; q.isActive = true; await this.playCurrent(playerId, baseUrl); this.persist(playerId); this.emit("queue_changed", playerId, this.snapshot(playerId)); this.schedulePreProbe(playerId); }
    finally { this.advancing.delete(playerId); }
  }

  async prev(playerId: string, baseUrl: string): Promise<void> {
    playerId = stripPlayerPrefix(playerId);
    const q = this.queues.get(playerId); if (!q) return;
    if (this.advancing.has(playerId)) return;
    this.advancing.add(playerId);
    try {
      q.isActive = true; q.ended = false;
      if (q.playMode === "one") { await this.playCurrent(playerId, baseUrl); }
      else if (q.playMode === "shuffle") {
        this.ensureShuffleReady(q);
        if ((q.shufflePos ?? 0) > 0) {
          q.shufflePos!--;
          q.currentIndex = q.shuffleOrder![q.shufflePos!];
        }
        // 已在序列头部:不绕回,保持当前曲
        await this.playCurrent(playerId, baseUrl);
      }
      else if (q.currentIndex > 0) { q.currentIndex--; await this.playCurrent(playerId, baseUrl); }
      else if (q.playMode === "all") { q.currentIndex = q.items.length - 1; await this.playCurrent(playerId, baseUrl); }
      this.persist(playerId); this.emit("queue_changed", playerId, this.snapshot(playerId));
      this.schedulePreProbe(playerId);
    } finally { this.advancing.delete(playerId); }
  }

  clear(playerId: string): void {
    playerId = stripPlayerPrefix(playerId);
    this.flowOwned.delete(playerId); // 队列清空 → 进行中的 flow 会话作废
    const q = this.queues.get(playerId); if (!q) return;
    // 清空队列同时停止实际播放(dlna=stopDevice,group=扇出各成员)。
    // 成员设备个人清空不打断归属的进行中群组播放。
    if (!this.isMemberOfActiveGroup(playerId)) {
      this.players.get(playerId)?.stop().catch(() => {});
    }
    q.items = []; q.currentIndex = -1; q.isActive = false; q.ended = false;
    q.shuffleOrder = []; q.shufflePos = -1; q.shuffleLen = 0;
    // 清队列同时清掉设备端的媒体缓存,避免 status 返回上一首残留(组场景清各成员)。
    const group = getGroupManager().get(playerId);
    if (group) {
      for (const d of group.memberIds) clearCurrentMedia(d);
    } else {
      clearCurrentMedia(playerId);
    }
    // 队列清空 → 预探测状态一并清掉。必须赶在发快照**之前**,
    // 否则下发的快照还带着已失效的 exhausted 提示。
    getPreProbeScheduler().clear(playerId);
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
    // 媒体已清空:显式推送,让所有客户端(HA 卡片/Web)立即清掉封面/歌词/进度,
    // 不必等下一轮 status 轮询自愈。
    this.emit("media_changed", playerId, undefined);
    // 清队列同时取消该目标的定时暂停(队列都没了,timer 失效)。
    this.clearSleepTimer(playerId);
  }

  snapshot(playerId: string): QueueSnapshot {
    playerId = stripPlayerPrefix(playerId);
    const q = this.queues.get(playerId);
    return {
      items: q?.items || [],
      currentIndex: q?.currentIndex ?? -1,
      playMode: q?.playMode || "shuffle",
      isActive: q?.isActive || false,
      ended: q?.ended || false,
      // 权威洗牌序列随快照下发,客户端只做镜像(见 QueueSnapshot 文档)。
      shuffleOrder: q?.shuffleOrder || [],
      shufflePos: q?.shufflePos ?? -1,
      // 预探测状态位(仅 Web 端消费;HA 卡片不读该字段 → 天然不显示)。
      preProbe: getPreProbeScheduler().status(playerId),
    };
  }

  // ==================== flow mode（P3-1：把队列连续曲目拼成一条不间断流） ====================
  // 出流侧（`/rest/dlna/stream/:token`、`/rest/stream?flow=1`）在起会话 / 结束时调用下面
  // 三个方法。它们只动队列状态,不发任何传输指令 —— 设备拉的就是同一条流。

  /** 标记/解除「该设备正由 flow 会话驱动」。会话结束（含客户端断开）必须传 false。 */
  setFlowOwned(playerId: string, owned: boolean): void {
    const id = stripPlayerPrefix(playerId);
    if (owned) this.flowOwned.add(id);
    else this.flowOwned.delete(id);
  }

  isFlowOwned(playerId: string): boolean {
    return this.flowOwned.has(stripPlayerPrefix(playerId));
  }

  /**
   * flow 会话走到第 `index` 首：静默把队列位置推过去。
   *
   * 为什么"静默"：设备拉的是同一条流，重投 `SetAVTransportURI` 会打断正在播的流
   * （听感就是每次切歌都断一次）。所以这里只改 `currentIndex` 并广播快照，
   * 让 Web / HA / ICY 元数据跟上真实播放位置。
   * 越界（播放途中队列被用户改短）直接忽略，避免把位置推到不存在的曲目上。
   */
  flowAdvance(playerId: string, index: number): void {
    const id = stripPlayerPrefix(playerId);
    const q = this.queues.get(id);
    if (!q || index < 0 || index >= q.items.length) return;
    if (q.currentIndex === index && !q.ended) return;
    q.currentIndex = index;
    q.ended = false;
    this.persist(id);
    this.emit("queue_changed", id, this.snapshot(id));
    this.schedulePreProbe(id);
  }

  /** Append items without switching playback. If the queue was empty, start
   *  playing from the first appended item. 对照原 QueueManager.enqueue。 */
  async enqueue(playerId: string, items: QueueItem[], baseUrl: string): Promise<void> {
    playerId = stripPlayerPrefix(playerId);
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
    // 长度变了 → 洗牌序失效;预探测前先物化,否则 shuffle 下 lookahead 扫 0 个位置。
    this.ensureShuffleForLookahead(q);
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
    this.schedulePreProbe(playerId);
  }

  /** Remove a single item by index and keep playback coherent. 对照原
   *  QueueManager.removeAt:删的是当前项则续播同 index 的下一首。
   *
   *  **2026-09-11 起它只服务「用户主动删歌」** —— 播放链路的坏源不再走摘除,
   *  改为留队列 + 短 TTL 跳过(见 playCurrent)。长度变化必须重算洗牌序,
   *  故一并触发预探测窗口重算。 */
  removeAt(playerId: string, index: number, baseUrl: string): void {
    playerId = stripPlayerPrefix(playerId);
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
    // 长度变了 → 洗牌序失效;预探测前先物化。
    this.ensureShuffleForLookahead(q);
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
    this.schedulePreProbe(playerId);
  }

  /** 拖拽排序:搬移一条,当前播放曲目下标跟随到新位置(不打断播放)。 */
  reorder(playerId: string, from: number, to: number): void {
    playerId = stripPlayerPrefix(playerId);
    const q = this.queues.get(playerId); if (!q) return;
    if (from < 0 || from >= q.items.length || to < 0 || to >= q.items.length || from === to) return;
    const moved = q.items[from];
    q.items.splice(from, 1);
    q.items.splice(to, 0, moved);
    // 当前播放曲目跟随移动(对象引用定位新下标)
    q.currentIndex = q.items.indexOf(moved);
    // 长度未变,但「下标 → 歌曲」的映射变了:旧序列现在指向别的歌。
    // 长度检查(ensureShuffleReady)看不出这种变化,故显式重建(保留当前曲在序列头)。
    if (q.playMode === "shuffle") this.rebuildShuffle(q, { keepCurrent: true });
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
    this.schedulePreProbe(playerId);
  }

  /** Mark a device inactive without clearing the queue. 对照原 QueueManager.deactivate。 */
  deactivate(playerId: string): void {
    playerId = stripPlayerPrefix(playerId);
    this.flowOwned.delete(playerId); // 停投 → flow 会话由出流侧 abort（这里先摘所有权）
    const q = this.queues.get(playerId); if (!q) return;
    q.isActive = false;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  /** 用户主动停止(HA 的 turn_off / media_stop,Web 的停止按钮)。
   *
   *  必须冻结队列自动推进,否则:设备收到 Stop 后进入 STOPPED,PlaybackTracker
   *  看到 PLAYING→IDLE 且队列还有下一首,会判定"这首自然放完了"从而 advance,
   *  于是用户刚停下就自动蹦出下一首。对照 announce 的处理(见 announce.ts 注释 2)。
   *
   *  与 markEnded 的区别:这里 ended 保持 false —— 队列是被用户按停的,不是播完的,
   *  items 与 currentIndex 原样保留,随后 resumePlayback() 可原地续上。
   *  resetTracker 清掉 prev 状态,避免冻结前后的残留迁移在下次播放时再触发 advance。 */
  stopPlayback(playerId: string): void {
    playerId = stripPlayerPrefix(playerId);
    this.flowOwned.delete(playerId); // 用户停止 → 会话由出流侧 abort
    const q = this.queues.get(playerId);
    this.ctrls.get(playerId)?.resetTracker(this.players.get(playerId)?.playerId ?? playerId);
    if (!q || !q.isActive) return;
    q.isActive = false;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  /** 停止后再次点播放:解冻自动推进,让这首播完还能续下一首。
   *  仅在队列"被按停"(有当前曲且未播完)时恢复;自然播完的队列不复活。 */
  resumePlayback(playerId: string): void {
    playerId = stripPlayerPrefix(playerId);
    const q = this.queues.get(playerId); if (!q) return;
    if (q.isActive || q.ended) return;
    if (q.currentIndex < 0 || q.items.length === 0) return;
    q.isActive = true;
    this.persist(playerId);
    this.emit("queue_changed", playerId, this.snapshot(playerId));
  }

  // ==================== 服务器端定时暂停（sleep timer） ====================
  /** 设置该播放目标的定时暂停。durationMs(ms) 后立即暂停;重复调用会重置为新时长。 */
  setSleepTimer(playerId: string, durationMs: number): void {
    playerId = stripPlayerPrefix(playerId);
    this.clearSleepTimer(playerId);
    const deadline = Date.now() + Math.max(0, durationMs);
    const timer = setTimeout(() => {
      this.sleepTimers.delete(playerId);
      this.transport(playerId, "pause").catch((e: any) => {
        log.warn(`[QueueController][sleepTimer] ${playerId}: pause failed: ${e?.message || e}`);
      });
    }, Math.max(0, durationMs));
    // Node 定时器在 duration 超长时自动转轮询;不 unref,确保服务器即使无其它
    // 引用也会到点触发(单测/短时任务不宜 unref)。
    this.sleepTimers.set(playerId, { timer, deadline });
  }

  /** 取当前剩余毫秒;未设置返回 null。 */
  sleepTimerRemaining(playerId: string): number | null {
    playerId = stripPlayerPrefix(playerId);
    const t = this.sleepTimers.get(playerId);
    return t ? Math.max(0, t.deadline - Date.now()) : null;
  }

  /** 取消该目标的定时暂停。 */
  clearSleepTimer(playerId: string): void {
    playerId = stripPlayerPrefix(playerId);
    const t = this.sleepTimers.get(playerId);
    if (t) {
      clearTimeout(t.timer);
      this.sleepTimers.delete(playerId);
    }
  }

  /** 组播放中新增成员:把当前曲目 cast 给新成员并 seek 到 leader 当前进度。
   *  对照 MA Universal Group 的加入语义:仅在加入时对齐一次,不做周期漂移校正。
   *  - 组队列未激活 / 无当前曲 → 不动作(静默)
   *  - 只处理在线新成员(离线成员回归由离线 watchdog 负责)
   *  - 组处于暂停 → 新成员对齐后同步暂停(镜像组播放态)
   *  - 新成员若有个人激活队列 → 标记不激活(组激活期间成员不可单独播放,保留 items) */
  async rejoinMembers(groupId: string, newMemberIds: string[]): Promise<void> {
    groupId = stripPlayerPrefix(groupId);
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
    } catch (e: any) {
      log.warn("组状态查询失败,回退 position=0", { groupId, err: e?.message || e });
    }
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
        log.info(`[group] ${groupId}: 新成员 ${deviceId} 已对齐(位置 ${Math.round(landed)}s, 状态 ${playState ?? "?"})`);
      } catch (e: any) {
        log.warn(`[group] ${groupId}: 新成员 ${deviceId} 加入对齐失败: ${e?.message || e}`);
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
    log.info(`[QueueController] loaded ${this.queues.size} persisted queue(s) (${groupRows.length} group) from DB`);
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
