// AirPlay (RAOP) ProtocolPlayer — adapter that plugs AirPlay receivers into the
// unified queue/transport machinery (UniversalPlayer + QueueController) exactly
// like DLNA devices do. Audio is driven by services/airplay/control.ts; this
// file only maps the ProtocolPlayer contract onto it.
//
// Channel independence (L4): AirPlay used to *reuse* DLNA's createCastSession() and
// pull /rest/dlna/stream/:token — one route serving three protocols, which forced
// DLNA-only headers onto the AirPlay decoder and pinned the filter channel to `dlna`.
// It now mints its own token (services/airplay/session.ts) and pulls
// /rest/airplay/stream/:token; the streaming core stays shared (serveCastStream).
import { randomBytes } from "node:crypto";
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../player/types.js";
import { createAirPlaySession } from "./session.js";
import { bridgeSocketPath } from "./bridgeChannel.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AirPlay");
import {
  castToAirPlayDevice,
  getAirPlayMediaUri,
  getAirPlayStatus,
  isAirplayBridgeEnabled,
  bridgePrepareDevice,
  bridgeStopDevice,
  bridgeManualDevice,
  selectAirPlayBridgeProtocol,
  pauseAirPlay,
  resumeAirPlay,
  seekAirPlay,
  setAirPlayVolume,
  stopAirPlay,
} from "./control.js";
import type { BridgeSocketSpec } from "../sendspin/bridgeAttach.js";

export function createAirPlayProtocolPlayer(deviceId: string): ProtocolPlayer {
  const playerId = `airplay:${deviceId}`;
  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string, startMs = 0) {
      const streamUrl = createAirPlaySession(item.songId, deviceId, baseUrl).streamUrl;
      // ★ 起播即落位(流转/带进度起播):起点交给**这一次** ANNOUNCE/SETUP/RECORD,
      //   绝不再「先起播、再 seek」—— AirPlay 的 seek 是完整重建会话,连续两次建会话
      //   会让 HiVi 这类单会话设备在第二次 RECORD 上永久等待(2026-10-21 真机:
      //   流转时第 3 次握手 RECORD 挂死 12s → 流转失败/无声)。
      const seekSec = startMs > 0 ? startMs / 1000 : undefined;
      await castToAirPlayDevice({
        deviceId,
        songId: item.songId,
        title: item.title,
        artist: item.artist,
        album: item.album,
        coverArt: item.coverArt,
        durationSec: item.duration,
        baseUrl,
        streamUrl,
        ...(seekSec !== undefined ? { seekSec } : {}),
      });
      // mediaUri identifies the current track for PlayerController's
      // track_changed detection — the token stream URL is per-cast.
      return { mediaUri: streamUrl };
    },
    async stop() { await stopAirPlay(deviceId); },
    async pause() { await pauseAirPlay(deviceId); },
    async resume() { await resumeAirPlay(deviceId); },
    async seek(seconds: number) {
      // 入口+结果留痕:AirPlay seek 是"原地 FLUSH 换 decoder"还是"带 seekSec 重投",
      // 成败只看这一行(内部分支见 control.ts seekAirPlay)。
      const t0 = Date.now();
      log.debug(`[AirPlay][seek] ${deviceId} 目标=${seconds.toFixed(2)}s → 下发`);
      try {
        await seekAirPlay(deviceId, seconds);
        log.debug(`[AirPlay][seek] ${deviceId} 完成 ${Date.now() - t0}ms`);
      } catch (e: any) {
        log.debug(`[AirPlay][seek] ${deviceId} 失败 ${Date.now() - t0}ms err=${e?.message || e}`);
        throw e;
      }
    },
    async setVolume(vol: number) { await setAirPlayVolume(deviceId, vol); },
    async pollState(): Promise<PlayerState> {
      const s = getAirPlayStatus(deviceId);
      return {
        playerId,
        playbackState: s.playbackState as PlaybackState,
        position: s.position,
        duration: s.duration,
        // 与 DLNA 对齐(dlna/control.ts 的 pollState 带 GetPositionInfo.TrackURI):
        // PLAYING 期间必须带 mediaUri,否则 tracker 的「同为 PLAYING 但 uri 变 = 换歌」
        // 判据对 AirPlay **恒不可达**(设备侧真换歌检测形同虚设)。
        // 取 lastCast 的 token 化地址 —— 同一 (songId, deviceId) 复用 token(见 session.ts),
        // 同曲 seek 重投地址不变,不会误判 track_changed;真换歌 token 必变。
        mediaUri: getAirPlayMediaUri(deviceId),
        updatedAt: s.updatedAt,
      };
    },
  };
}

// ==================== 单机桥播放器（D2/D7：单机 = 单成员伪组） ====================

/** 单机伪组 id：只用于 sendspin 泵命名空间，不写 GroupManager、不污染用户组。 */
export function soloBridgeGroupId(deviceId: string): string {
  return `__bridge_solo:${deviceId}`;
}

/** deviceId → 当前桥规格。同设备同协议热复用 token ⇒ 切歌不重建 RAOP 会话。 */
const soloBridgeRoutes = new Map<string, BridgeSocketSpec>();

/** 单机桥路由快照(供主进程桥路由对账):单机伪组的路由**不**登记在
 *  group/protocolPlayer 的 activeBridgeRoutes(那张表只覆盖用户组),若对账只看
 *  那张表,单机桥会被判成「孤儿」并在宽限后被摘句柄/摘会话 —— 实测每 ~60s
 *  稳定杀掉一次活会话(bridge link live→idle → session 断开 reason=closed)。
 *  对账必须把本表并入事实源。 */
export function listSoloBridgeRoutes(): BridgeSocketSpec[] {
  return [...soloBridgeRoutes.values()];
}

async function sendspinSoloGroup(deviceId: string): Promise<ProtocolPlayer> {
  // 动态导入：sendspin/protocolPlayer ← player/index ← QueueController 与本文件构成
  // 加载环，沿用 QueueController 的既有规避方式。
  const { createSendspinGroupPlayer } = await import("../sendspin/protocolPlayer.js");
  return createSendspinGroupPlayer(soloBridgeGroupId(deviceId));
}

/** 单机 AirPlay 的**唯一**音乐播放实现：桥建立成功后，PCM 只来自 sendspin 组泵。
 *  桥建立失败直接抛错（D7：重试后显式失败，绝不回落直连）。 */
export function createAirPlayBridgePlayer(deviceId: string): ProtocolPlayer {
  const playerId = `airplay:${deviceId}`;
  let lastMediaUri: string | undefined;
  return {
    playerId,
    async playMedia(
      item: QueueItem,
      baseUrl: string,
      startMs = 0,
      _bridge?: unknown,
      opts?: { manual?: boolean; nextSongId?: string },
    ) {
      const prev = soloBridgeRoutes.get(deviceId);
      // D6/P1:用户手动 next/prev ⇒ 给**已存在**的桥会话打 sticky 标记;
      // 真正的 1 次 FLUSH + ts 回拨由子进程在下一个 track boundary 执行。
      // 冷启(无 prev)没有旧轨道可换,标记无意义。
      if (opts?.manual === true && prev) await bridgeManualDevice(prev.token);
      const protocol = selectAirPlayBridgeProtocol(deviceId);
      const warm = !!prev && prev.protocol === protocol;
      const token = warm ? prev!.token : randomBytes(12).toString("hex");
      bridgeSocketPath(deviceId, token); // <100B 断言，与组路径同源
      const status = getAirPlayStatus(deviceId);
      await bridgePrepareDevice(deviceId, token, protocol, null, {
        initialVolume: status.volume,
        settleDlna: !warm,
      });
      const spec: BridgeSocketSpec = {
        deviceId,
        socketPath: bridgeSocketPath(deviceId, token),
        token,
        protocol,
      };
      soloBridgeRoutes.set(deviceId, spec);
      const gp = await sendspinSoloGroup(deviceId);
      // opts 必须透传：nextSongId 是 S1「下一首预解码」的唯一触发链
      // (QueueController 只对桥路径下传；漏传 ⇒ 组泵 nextSongId 恒空 ⇒ 预取永不启动)。
      const r = await gp.playMedia(item, baseUrl, startMs, { sockets: [spec] }, opts);
      lastMediaUri = r.mediaUri;
      log.info(`[bridge-solo] ${deviceId} 起播 protocol=${protocol} warm=${warm} start=${Math.round(startMs / 1000)}s`);
      return r;
    },
    async stop() {
      await (await sendspinSoloGroup(deviceId)).stop();
      const spec = soloBridgeRoutes.get(deviceId);
      if (spec) {
        await bridgeStopDevice(spec.token, deviceId).catch(() => { /* 子进程没跑 → 无会话 */ });
        soloBridgeRoutes.delete(deviceId);
      }
    },
    async pause() { await (await sendspinSoloGroup(deviceId)).pause(); },
    async resume() { await (await sendspinSoloGroup(deviceId)).resume(); },
    async seek(seconds: number) { await (await sendspinSoloGroup(deviceId)).seek(seconds); },
    // 音量走设备侧（与直连路径同一 volumeState/落库），泵侧不加增益。
    async setVolume(vol: number) { await setAirPlayVolume(deviceId, vol); },
    async isAvailable() { return getAirPlayStatus(deviceId).available; },
    async pollState(): Promise<PlayerState> {
      const st = await (await sendspinSoloGroup(deviceId)).pollState();
      // 泵侧的 BUFFERING 是**内部预填充**口径(组泵的 `audibleStarted` 未越过
      // 4.5s lead 前为 false),不是 AirPlay 设备状态。若原样透传,PlayerController
      // 的乐观窗口(5s 等 PLAYING)必然超时(lead 4.5s + 起播延迟 > 5s)⇒ 每首
      // 都被判 stalled ⇒ QueueController 重投/切歌(实测:同曲无限重播、连续 3 首
      // 卡死直接停流断会话)。RAOP 侧 RTP 已按锚点投递,设备就是在播 —— 对齐 MA
      // (推流一起来即 PLAYING;buffering 只用于客户端进度插值),这里把 BUFFERING
      // 归一为 PLAYING,位置/时长/mediaUri 原样保留。
      const playbackState = st.playbackState === PlaybackState.BUFFERING
        ? PlaybackState.PLAYING
        : st.playbackState;
      return {
        ...st,
        playerId,
        playbackState,
        ...(lastMediaUri ? { mediaUri: lastMediaUri } : {}),
      };
    },
  };
}

/** 统一入口：桥开关开 → 桥播放器；`MUSICFLOW_AIRPLAY_BRIDGE=0` 只作整体回滚。 */
export function createAirPlayPlayerForDevice(deviceId: string): ProtocolPlayer {
  return isAirplayBridgeEnabled() ? createAirPlayBridgePlayer(deviceId) : createAirPlayProtocolPlayer(deviceId);
}

/** 桥播放状态(供 `/v1/peers/airplay:<dev>/status` 派生),覆盖两种桥形态:
 *   ① **单机桥**:音频来自 sendspin 单机伪组泵(`ug:__bridge_solo:<dev>`);
 *   ② **群组桥成员**:该设备只是群组桥路由里的一员,音频来自群组泵(`ug:<gid>`)。
 *
 *  两种形态主进程的 AirPlay 会话表里都没有这台设备的会话,`lastCast` 也从未写入 ⇒
 *  只靠 `getAirPlayPeerStatus` 时对外恒为 IDLE/STOPPED、media 恒空(2026-11-10 240
 *  现场:流转成功却显示未播放)。改从对应泵派生 —— 与「组 leader 走桥」时
 *  getGroupStatus 的口径一致。
 *
 *  返回 `null` = 未走桥(调用方回落到设备会话视图,行为与改动前完全一致)。
 *  任何查询失败也返回 null:**状态查询绝不能反过来打断正在播放的会话**。 */
export async function getBridgePeerStatus(deviceId: string): Promise<{
  state: string;
  position: number;
  duration: number;
  media?: { songId: string; title?: string; artist?: string; album?: string; coverArt?: string };
} | null> {
  const { sendspinGroupName } = await import("../sendspin/playerCore.js");
  // 泵名 + 队列归属:单机桥用伪组泵、队列挂在成员自己;群组桥用组泵、队列在组上。
  let gname: string;
  let queuePeerId: string;
  if (soloBridgeRoutes.has(deviceId)) {
    gname = sendspinGroupName(soloBridgeGroupId(deviceId));
    queuePeerId = `airplay:${deviceId}`;
  } else {
    // 静态导入会与 group/protocolPlayer → airplay/protocolPlayer 构成加载环,动态取。
    const { groupIdOfBridgeMember } = await import("../group/protocolPlayer.js");
    const gid = groupIdOfBridgeMember(deviceId);
    if (!gid) return null;
    gname = sendspinGroupName(gid);
    queuePeerId = `group:${gid}`;
  }
  try {
    const { sendspinGroupPoll, getSendspinFront } = await import("../sendspin/index.js");
    const st = await sendspinGroupPoll(gname);
    const gv: any = getSendspinFront()?.groups.get(gname);
    const cur: any = gv?.current;
    let media: { songId: string; title?: string; artist?: string; album?: string; coverArt?: string } | undefined;
    if (cur && typeof cur.songId === "string") {
      media = { songId: cur.songId, title: cur.title, artist: cur.artist, album: cur.album, coverArt: cur.coverArt };
      // 换曲瞬间泵侧 current 可能只有 songId(拿不到队列)⇒ 按 songId 从队列回填展示字段
      // (与 group 的 enrichGroupCurrentMedia 同一手法)。
      if (!media.title || !media.coverArt) {
        try {
          const { getQueueController } = await import("../player/index.js");
          const snap = getQueueController().snapshot(queuePeerId);
          const item = (snap?.items ?? []).find((it: any) => it?.songId === cur.songId);
          if (item) {
            media.title = media.title ?? item.title;
            media.artist = media.artist ?? item.artist;
            media.album = media.album ?? item.album;
            media.coverArt = media.coverArt ?? item.coverArt;
          }
        } catch { /* 补字段失败不影响状态 */ }
      }
    }
    // 状态词表与内部一致(路由出口再做 PAUSED→PAUSED_PLAYBACK / IDLE→STOPPED 翻译)。
    // 泵侧 BUFFERING 归一到 PLAYING:与 pollState 同口径 —— 锚点 lead 期内设备其实
    // 已经在收包,报 BUFFERING 会让客户端把「正常起播」画成卡顿。
    const state = st.paused
      ? PlaybackState.PAUSED
      : (st.playing ? PlaybackState.PLAYING : PlaybackState.IDLE);
    return {
      state,
      position: Math.floor((st.positionMs || 0) / 1000),
      duration: Math.floor((st.durationMs || 0) / 1000),
      ...(media ? { media } : {}),
    };
  } catch {
    return null;
  }
}
