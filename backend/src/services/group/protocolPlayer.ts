// ==================== 组协议 player(统一 pump 时间线)====================
//
// ★ 2026-10-23 起:群组成员只允许两种 kind,**DLNA 禁止入组**。
//   理由:DLNA 是"各设备自拉流"的扇出模型,没有共享时间线,组内只能 roughly 同时起播,
//   无法做采样级同步;把它留在组里会拉低整组观感,也掩盖真实漂移(用户定稿)。
//
// 新模型(对齐 MA 的 SyncGroup + bridge):
//   - sendspin 成员:pump 的原生客户端,吃 pushFrame 下发的时间戳;
//   - airplay 成员:同一 pump 的**旁路 sink**(`AirPlayBridgeSink`),PCM 经本地 TCP
//     送到 airplay 子进程,由那边的 `BridgeRing` 按墙钟 + 设备延迟取内容 → RAOP 推流;
//   - 两者共享**同一条时间线**(pump 的 tsUs),所以"在同一时刻听到同一段内容"是
//     结构保证,而不是靠各自 seek 校准。
//
// 组成员不再各自 cast:pump 只起一份(ug:<groupId>),airplay 设备的 RAOP 会话由
// airplay 子进程在组起播时建立(桥接会话,无解码器)。
import { getGroupManager, splitMemberId } from "./index.js";
import { getAirPlayDevice } from "../airplay/discovery.js";
import { getSendspinFront } from "../sendspin/index.js";
import { sendspinGroupName } from "../sendspin/playerCore.js";
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../player/types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("group");

/** 组内成员按 kind 拆分(裸 id)。 */
export function splitGroupMembers(groupId: string): { spin: string[]; airplay: string[] } {
  const g = getGroupManager().get(groupId);
  const spin: string[] = [];
  const airplay: string[] = [];
  if (!g) return { spin, airplay };
  for (const m of g.memberIds) {
    const s = splitMemberId(m);
    if (!s) continue;
    if (s.kind === "sendspin") spin.push(s.id);
    else airplay.push(s.id);
  }
  return { spin, airplay };
}

/** 组内在线 sendspin 成员(裸 clientId):front clients ready 判定,不在线即跳过。 */
export function getOnlineSendspinIds(groupId: string): string[] {
  const { spin } = splitGroupMembers(groupId);
  if (spin.length === 0) return [];
  const front = getSendspinFront();
  if (!front) return [];
  return spin.filter(id => {
    const c = front.clients.get(id) as any;
    return !!c && c.ready !== false;
  });
}

/** 组内在线 airplay 成员(裸 deviceId):设备档案存在且 mDNS 可用。 */
export function getOnlineAirPlayIds(groupId: string): string[] {
  const { airplay } = splitGroupMembers(groupId);
  if (airplay.length === 0) return [];
  return airplay.filter(id => {
    try {
      return !!getAirPlayDevice(id)?.available;
    } catch {
      return false;
    }
  });
}

/** 组是否有任一在线成员(sendspin 在线 或 airplay 在线)。
 *  QC 结束抑制 / 看门狗悬挂判定 / playTarget 可播判据共用。 */
export function hasOnlineMember(groupId: string): boolean {
  return getOnlineSendspinIds(groupId).length > 0 || getOnlineAirPlayIds(groupId).length > 0;
}

/** 组 leader:固定顺序首个在线成员(跨 kind;对照 MA _select_sync_leader)。
 *  组成员共享同一条 pump,leader 只用于状态派生与"是否还能播"的判定。 */
export function getGroupLeader(groupId: string): { kind: "sendspin" | "airplay"; id: string } | undefined {
  const g = getGroupManager().get(groupId);
  if (!g) return undefined;
  const spinOnline = new Set(getOnlineSendspinIds(groupId));
  const apOnline = new Set(getOnlineAirPlayIds(groupId));
  for (const m of g.memberIds) {
    const s = splitMemberId(m);
    if (!s) continue;
    if (s.kind === "sendspin") {
      if (spinOnline.has(s.id)) return { kind: "sendspin", id: s.id };
    } else if (apOnline.has(s.id)) {
      return { kind: "airplay", id: s.id };
    }
  }
  return undefined;
}

/** 组 leader 的裸 id(事件叠加层等只需"一台代表设备"的调用方用)。 */
export function getGroupLeaderDeviceId(groupId: string): string | undefined {
  return getGroupLeader(groupId)?.id;
}

export function createGroupProtocolPlayer(groupId: string): ProtocolPlayer {
  const playerId = `group:${groupId}`;

  /** 桥接会话生命周期(airplay 成员;无 airplay 成员时是 no-op)。 */
  async function bridge() {
    return import("./airplayBridge.js");
  }

  /** sendspin 组指令(pump 共享时间线;airplay 成员也挂在这条 pump 上)。 */
  async function spinOp(op: (p: ProtocolPlayer) => Promise<unknown>): Promise<void> {
    const { createSendspinGroupPlayer } = await import("../sendspin/protocolPlayer.js");
    await op(createSendspinGroupPlayer(groupId));
  }

  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string, startMs = 0) {
      const spinOnline = getOnlineSendspinIds(groupId);
      const apOnline = getOnlineAirPlayIds(groupId);
      if (spinOnline.length === 0 && apOnline.length === 0) {
        throw new Error(`组 ${groupId} 无在线成员,无法播放`);
      }
      // 1) 先建 airplay 桥接会话(RAOP 握手 + 环形缓冲注册),拿到桥接端口;
      //    握手放在 pump 起播之前:producer 按**绝对墙钟**取内容,所以握手早晚
      //    不影响对齐(起播前 producer 输出静音),但失败要尽早暴露。
      const b = await bridge();
      const bridgeInfo = await b.startGroupAirPlayBridge(groupId);
      try {
        // 2) 起 pump(可能零 sendspin 成员 —— 纯 airplay 组由 sink 推进时间线)。
        const { createSendspinGroupPlayer } = await import("../sendspin/protocolPlayer.js");
        return await createSendspinGroupPlayer(groupId).playMedia(item, baseUrl, startMs, bridgeInfo ?? undefined);
      } catch (e) {
        // 起播失败:桥接会话不能留在设备上(会一直收静音),立刻收掉。
        await b.stopGroupAirPlayBridge(groupId, "起播失败回滚").catch(() => {});
        throw e;
      }
    },
    async stop() {
      // 先停 pump(sink 随之关闭)→ 再拆 airplay 会话,避免设备继续收到半截音频。
      await spinOp(p => p.stop()).catch(() => {});
      await (await bridge()).stopGroupAirPlayBridge(groupId, "组停止");
    },
    async pause() {
      // 暂停只停 pump:airplay 侧 producer 取不到内容会输出静音(RAOP 会话保留),
      // 恢复时 pump 重新锚定,sink 按墙钟自动追平 —— 不需要动 RAOP 会话。
      await spinOp(p => p.pause());
    },
    async resume() {
      await spinOp(p => p.resume());
    },
    async seek(seconds: number) {
      const t0 = Date.now();
      // pump 侧:重建时间线 + 给 sink 发 reset(airplay 环清空)。
      await spinOp(p => p.seek(seconds));
      // RAOP 侧:FLUSH 旧缓冲,避免设备把 seek 前的音频播完才跟上。
      await (await bridge()).seekGroupAirPlayBridge(groupId, seconds).catch(e => {
        log.warn(`[group][seek] ${groupId}: airplay 桥接 seek 失败: ${(e as Error)?.message ?? e}`);
      });
      log.debug(`[group][seek] ${groupId} 目标=${seconds.toFixed(2)}s 耗时 ${Date.now() - t0}ms`);
    },
    async setVolume(vol: number) {
      // 组音量先落库(无成员也持久);再下发 pump 组音量 + airplay 设备音量。
      try { getGroupManager().setVolume(groupId, vol); } catch { /* 库失败不挡下发 */ }
      await spinOp(p => p.setVolume(vol)).catch(() => {});
      await (await bridge()).setGroupAirPlayVolume(groupId, vol).catch(() => {});
    },
    async isAvailable() {
      return hasOnlineMember(groupId);
    },
    async pollState(): Promise<PlayerState> {
      if (!hasOnlineMember(groupId)) {
        // 全部成员离线:不要报 IDLE —— 那会被 PlaybackTracker 当作"曲目自然结束"
        // (lastPlaying→IDLE→ended)从而 deactivate 队列,看门狗就无法悬挂/恢复。
        // 报 BUFFERING 瞬态:tracker 视为瞬态屏蔽,lastPlaying 保留,等成员回归由
        // 看门狗 resumeActive(cast 成功会进乐观窗口 → PLAYING)。
        return { playerId, playbackState: PlaybackState.BUFFERING, position: 0, duration: 0, updatedAt: Date.now() };
      }
      // 音频来自共享组 pump(airplay 成员也在同一条 pump 上),状态一律从 pump 派生。
      const { sendspinGroupPoll } = await import("../sendspin/index.js");
      let unavailable = false;
      const st = await sendspinGroupPoll(sendspinGroupName(groupId)).catch(() => {
        unavailable = true;
        return { playing: false, paused: false, positionMs: 0, durationMs: 0 };
      });
      return {
        playerId,
        playbackState: st.paused ? PlaybackState.PAUSED
          : st.playing ? PlaybackState.PLAYING
          : PlaybackState.IDLE,
        position: st.positionMs / 1000,
        duration: st.durationMs / 1000,
        updatedAt: Date.now(),
        unavailable,
      };
    },
  };
}

/** 组状态(路由层 /v1/peers/group:<id>/status 用):leader 派生;无在线成员 STOPPED 默认值。
 *  组成员共享同一条 pump,位置/时长一律走 pump 时间线。 */
export async function getGroupStatus(groupId: string): Promise<{
  state: string; position: number; duration: number; volume: number; muted: boolean; media?: unknown;
  updatedAt: number;
}> {
  // 音量权威 = GroupManager 持久库值(空组/全离线也回显用户上次调节)。
  const persistedVolume = getGroupManager().getVolume(groupId);
  if (!getGroupLeader(groupId)) {
    return { state: "STOPPED", position: 0, duration: 0, volume: persistedVolume, muted: false, updatedAt: Date.now() };
  }
  const { sendspinGroupPoll } = await import("../sendspin/index.js");
  const gname = sendspinGroupName(groupId);
  const st = await sendspinGroupPoll(gname).catch(() => ({ playing: false, paused: false, positionMs: 0, durationMs: 0 }));
  const front = getSendspinFront();
  const gv = front?.groups.get(gname) as any;
  return {
    state: st.paused ? "PAUSED" : st.playing ? "PLAYING" : "STOPPED",
    position: Math.floor(st.positionMs / 1000),
    duration: Math.floor(st.durationMs / 1000),
    // 实时组在则回实时(刚调过),否则回持久库值(重启后 / ug 组尚未创建)。
    volume: typeof gv?.volume === "number" ? gv.volume : persistedVolume,
    muted: !!gv?.muted,
    media: gv?.current ?? undefined,
    updatedAt: Date.now(),
  };
}
