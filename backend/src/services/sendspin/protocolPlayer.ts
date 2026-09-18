// Sendspin ProtocolPlayer — 把每个 Sendspin 客户端(或客户端组)接入统一队列/传输
// 机制(UniversalPlayer + QueueController),与 DLNA 设备完全同构。音频由
// services/sendspin/server.ts 的 SendspinGroup 一次性解码→逐客户端编码→同一时间线
// 推流驱动;本文件把 ProtocolPlayer 契约映射到推流核心上。
//
// 双模式(2026-09-18 起,sendspin 运行时 fork 到专属子进程):
//  - **in-proc**(单测/子进程自身):直接调 playerCore(操作 server 内存对象);
//  - **fork**(生产主进程):命令经 supervisor RPC 转发到子进程;推流侧状态
//    (positionMs/current/音量)全部在子进程,主进程只发指令 + 收轮询。
// 与 DLNA 一样,报给上游的 mediaUri 复用 createCastSession 的 token 流地址(供
// PlayerController 检测曲目切换),真正音频走内部推流,不依赖设备回连拉流。
// castSession / QueueController / PlayerController 都是**主进程状态**,两种模式都留在本侧。
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../player/types.js";
import { createCastSession, getEffectiveBaseUrl } from "../dlna/control.js";
import { getServer } from "./runtime.js";
import { isForkMode } from "./mode.js";
import {
  playCore,
  stopCore,
  pauseCore,
  resumePumpCore,
  seekCore,
  setVolumeCore,
  pollCore,
  pumpActiveCore,
  sendspinGroupName,
  ephemeralGroup,
  type SendspinGroupLike,
} from "./playerCore.js";
import { sendspinSupervisor } from "./supervisor.js";
import { getPlayerController, getQueueController } from "../player/index.js";
import { getGroupManager, splitMemberId } from "../group/index.js";

/** 单个 sendspin 客户端抽象成一个 ProtocolPlayer。 */
export function createSendspinProtocolPlayer(clientId: string): ProtocolPlayer {
  if (isForkMode()) return createSendspinProxyPlayer(clientId);
  return createSendspinInprocPlayer(clientId);
}

// ==================== 用户组 player(多房间共享 pump) ====================
//
// 组内 sendspin 成员共用一个推流管线(`ug:<groupId>` 组＋单 pump 同一时间线),
// 与"每成员一个 pump"的扇出有本质区别 —— 后者不同步。
// 双模式:命令经 index.ts fork-aware helper(内部已分流),本文件不直接碰 server,
// 因此 in-proc/proxy 无需两套实现(与单设备 player 的双实现不同)。
// ⚠️ ./index.js 只许动态导入(禁环见 runtime.ts 注释);playerCore/group 静态可。

/** 组内 sendspin 在线成员(裸 clientId)。命名空间写法与裸写法都认作 sendspin。 */
async function onlineSendspinMembers(userGroupId: string): Promise<string[]> {
  const g = getGroupManager().get(userGroupId);
  if (!g) return [];
  const ids = g.memberIds
    .map(m => splitMemberId(m))
    .filter(s => s !== null && s.kind === "sendspin")
    .map(s => (s as { id: string }).id);
  if (ids.length === 0) return [];
  const { getSendspinFront } = await import("./index.js");
  const front = getSendspinFront();
  if (!front) return [];
  return ids.filter(id => {
    const c = front.clients.get(id) as any;
    return !!c && c.ready !== false;
  });
}

/** 用户组抽象成一个 ProtocolPlayer(仅覆盖组内 sendspin 成员;dlna 成员由组 player 另行扇出)。 */
export function createSendspinGroupPlayer(userGroupId: string): ProtocolPlayer {
  const playerId = `group:${userGroupId}`;
  const groupName = sendspinGroupName(userGroupId);
  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string) {
      const members = await onlineSendspinMembers(userGroupId);
      if (members.length === 0) {
        throw new Error(`组 ${userGroupId} 无在线 sendspin 成员,无法播放`);
      }
      // castSession/token 是主进程状态(track_changed 检测用),必须本侧生成。
      const streamUrl = createCastSession(item.songId, playerId, baseUrl).streamUrl;
      const { sendspinGroupPlay } = await import("./index.js");
      await sendspinGroupPlay(groupName, members, item);
      schedulePlayingReport(playerId, item.duration ?? 0);
      return { mediaUri: streamUrl };
    },
    async stop() {
      const { sendspinGroupTransport } = await import("./index.js");
      await sendspinGroupTransport(groupName, "stop");
    },
    async pause() {
      const { sendspinGroupTransport } = await import("./index.js");
      await sendspinGroupTransport(groupName, "pause");
    },
    async resume() {
      const { sendspinGroupPumpActive, sendspinGroupTransport } = await import("./index.js");
      if (await sendspinGroupPumpActive(groupName).catch(() => false)) {
        await sendspinGroupTransport(groupName, "resume");
        return;
      }
      await coldStartResume(
        createSendspinGroupPlayer(userGroupId),
        userGroupId,
        (msg) => console.warn(`[Sendspin] ${msg}`),
      );
    },
    async seek(seconds: number) {
      const { sendspinGroupTransport } = await import("./index.js");
      await sendspinGroupTransport(groupName, "seek", seconds);
    },
    async setVolume(vol: number) {
      const { sendspinGroupTransport } = await import("./index.js");
      await sendspinGroupTransport(groupName, "volume", vol);
    },
    async pollState(): Promise<PlayerState> {
      const { sendspinGroupPoll } = await import("./index.js");
      const st = await sendspinGroupPoll(groupName).catch(() => ({ playing: false, positionMs: 0, durationMs: 0 }));
      return {
        playerId,
        playbackState: st.playing ? PlaybackState.PLAYING : PlaybackState.IDLE,
        position: st.positionMs / 1000,
        duration: st.durationMs / 1000,
        updatedAt: Date.now(),
      };
    },
  };
}

// ==================== 共用主进程侧动作 ====================

/** 起播即推 media_changed(HA 卡片歌词/封面即时跟随,不必等 2s 轮询;
 *  对齐 DLNA castToDevice 的 media_changed + player_refresh)。
 *  经 QueueController 事件总线 → ws 转发(device_id=裸 clientId)。
 *  player/index 动态导入:避免 sendspin/protocolPlayer 在模块初始化期被
 *  静态拉入 player/index → sendspin 的模块环。 */
function emitMediaChanged(clientId: string, item: QueueItem): void {
  void import("../player/index.js").then(({ getQueueController }) => {
    try {
      getQueueController().emit("media_changed", clientId, {
        songId: item.songId,
        title: item.title,
        artist: item.artist,
        album: item.album,
        coverArt: item.coverArt,
      });
    } catch { /* 控制器未就绪时忽略 */ }
  }).catch(() => {});
}

/** 服务端权威起播即上报 PLAYING:sendspin 没有 GENA/秒级上报,PlaybackTracker 只能靠
 *  QueueController 每 5s 的轮询喂 PLAYING。曲目短于轮询间隔(如 3s 测试曲)时,唯一那次
 *  轮询常在自然结束后才到 → lastPlaying 从没置位 → 自然结束(auto-advance)永不触发,
 *  队列卡死(见 streamEngine.ts 头部注)。这里在起播瞬间 push 一次 PLAYING,让
 *  tracker 立即记下 lastPlaying(并关闭乐观窗口),之后 poll 到 IDLE 即确定性 advance。
 *  ⚠️ 必须异步(setTimeout 0)上报:playCurrent 在 `await player.playMedia(...)` 之后
 *  同步调用 resetTracker(清掉"上一首"的 lastPlaying 防误 advance)。若这里同步上报,
 *  刚置上的 lastPlaying 会被 resetTracker 清掉 → 自然结束的 IDLE 又无 lastPlaying →
 *  卡死(见 QueueController.playCurrent 注释)。setTimeout 回调是宏任务,必然晚于
 *  resetTracker(该同步调用所在的微任务),从而保住本首的 PLAYING。 */
function schedulePlayingReport(playerId: string, durationSec: number): void {
  setTimeout(() => {
    try {
      getPlayerController().reportState({
        playerId,
        playbackState: PlaybackState.PLAYING,
        position: 0,
        duration: durationSec,
        updatedAt: Date.now(),
      });
    } catch { /* 控制器未就绪时忽略 */ }
  }, 0);
}

/** resume 的冷起播段(两种模式共用):无推流在跑 = 真正起播,从 QC 队列取当前曲
 *  → playMedia。原地恢复(暂停中)的判定与动作由各模式自己先做。 */
async function coldStartResume(self: ProtocolPlayer, clientId: string, warn: (msg: string) => void): Promise<void> {
  const qc = getQueueController();
  const snap = qc.snapshot(clientId);
  const item = snap.currentIndex >= 0 ? snap.items[snap.currentIndex] : undefined;
  if (!item) {
    warn(`sendspin resume: ${clientId} 无当前曲(队列空或未选曲),忽略`);
    return;
  }
  // 只带 songId 的 item 需补全元数据(coverArt/mime 等),否则组状态缺字段。
  const fullItem = await qc.resolveItem(item);
  await self.playMedia(fullItem, getEffectiveBaseUrl());
}

// ==================== in-proc 模式(单测/子进程自身) ====================

function createSendspinInprocPlayer(clientId: string): ProtocolPlayer {
  const playerId = `sendspin:${clientId}`;
  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string) {
      const srv = getServer();
      if (!srv) throw new Error(`sendspin server not running: ${clientId}`);
      // mediaUri:token 流地址,仅供 track_changed 检测;音频走内部推流。
      const streamUrl = createCastSession(item.songId, clientId, baseUrl).streamUrl;
      // 当前曲元数据已在 playCore 写入组状态(status.media / queue currentMedia 据此上报)。
      emitMediaChanged(clientId, item);
      playCore(srv, clientId, item, (cid, songId, message) => {
        srv.log("warn", `sendspin play ${songId} failed(client=${cid}): ${message}`);
      });
      schedulePlayingReport(playerId, item.duration ?? 0);
      return { mediaUri: streamUrl };
    },
    async stop() {
      stopCore(getServer(), clientId);
    },
    async pause() {
      pauseCore(getServer(), clientId);
    },
    async resume() {
      const srv = getServer();
      if (!srv) return;
      // 已在推流(暂停中) → 原地恢复即可,不动流(不会重发 stream/start)。
      if (pumpActiveCore(srv, clientId)) {
        resumePumpCore(srv, clientId);
        return;
      }
      // 无推流在跑(冷起播 / 上次 stop 之后)=**真正的起播**。
      //
      // ⚠️ 这里曾只调 pump.resume()(空操作),后果是「点播放没声音」:
      //   POST /peers/:id/play → transport("play") → player.resume();
      //   而 resumePlayback() 见 q.isActive=true 直接早退(currentIndex 有效但从未起播),
      //   于是没有 playMedia、没有 stream/start、没有 pump → 全链路静默
      //   (2026-09-17 ESPHome 真机实测:服务端无 pushFrame、设备端停在 IDLE)。
      //   对照 DLNA:它的 resume() = playDevice()(重发 SetAVTransportURI)= 真起播,
      //   所以 DLNA 从未暴露这个缺口 —— sendspin 必须自己补上「冷起播走 playMedia」。
      await coldStartResume(
        createSendspinInprocPlayer(clientId),
        clientId,
        (msg) => srv.log("warn", msg),
      );
    },
    async seek(seconds: number) {
      seekCore(getServer(), clientId, seconds);
    },
    async setVolume(vol: number) {
      // 只写**组音量**(Sendspin 单设备组的权威音量标度;详见 setVolumeCore 注释)。
      setVolumeCore(getServer(), clientId, vol);
    },
    async pollState(): Promise<PlayerState> {
      const st = pollCore(getServer(), clientId);
      return {
        playerId,
        playbackState: st.playing ? PlaybackState.PLAYING : PlaybackState.IDLE,
        position: st.positionMs / 1000,
        duration: st.durationMs / 1000,
        updatedAt: Date.now(),
      };
    },
  };
}

// ==================== fork 模式(生产主进程:命令 RPC → 子进程) ====================

function createSendspinProxyPlayer(clientId: string): ProtocolPlayer {
  const playerId = `sendspin:${clientId}`;
  const transport = (op: string, arg?: number) =>
    sendspinSupervisor.rpc("transport", { clientId, op, arg });
  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string) {
      // castSession/token 是主进程状态(track_changed 检测用),必须留在本侧生成。
      const streamUrl = createCastSession(item.songId, clientId, baseUrl).streamUrl;
      emitMediaChanged(clientId, item);
      // 子进程做推流侧全部动作(收尾旧流 → 元数据 → 入组宣告 → 后台 pump);
      // RPC 只等同步段返回,解码/推流异步进行(与 in-proc 时序一致)。
      await sendspinSupervisor.rpc("playMedia", { clientId, item, streamUrl });
      schedulePlayingReport(playerId, item.duration ?? 0);
      return { mediaUri: streamUrl };
    },
    async stop() {
      await transport("stop");
    },
    async pause() {
      await transport("pause");
    },
    async resume() {
      // 已在推流(暂停中)→ 原地恢复;否则冷起播(队列在主进程,必须本侧取当前曲)。
      const active = await sendspinSupervisor.rpc<boolean>("pumpActive", { clientId }).catch(() => false);
      if (active) {
        await transport("resume");
        return;
      }
      await coldStartResume(
        createSendspinProxyPlayer(clientId),
        clientId,
        (msg) => console.warn(`[Sendspin] ${msg}`),
      );
    },
    async seek(seconds: number) {
      await transport("seek", seconds);
    },
    async setVolume(vol: number) {
      await transport("volume", vol);
    },
    async pollState(): Promise<PlayerState> {
      // 子进程不在(崩溃重启窗口)→ 报 IDLE,让上层走恢复,不 throw 打断轮询循环。
      const st = await sendspinSupervisor
        .rpc<{ playing: boolean; positionMs: number; durationMs: number }>("poll", { clientId })
        .catch(() => ({ playing: false, positionMs: 0, durationMs: 0 }));
      return {
        playerId,
        playbackState: st.playing ? PlaybackState.PLAYING : PlaybackState.IDLE,
        position: st.positionMs / 1000,
        duration: st.durationMs / 1000,
        updatedAt: Date.now(),
      };
    },
  };
}
