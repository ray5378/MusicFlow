// 组协议 player:实现 ProtocolPlayer 接口,对组内在线成员扇出命令。
// 仿 MA Universal Group(全部成员并发播同一 URL,无漂移校正):
//   - playMedia/stop/pause/resume/seek/setVolume → 扇出到全部在线成员
//   - pollState → 从 leader(= 固定顺序第一个在线成员)派生状态(对照 MA 状态从 sync_leader 派生)
//   - 成员离线自动跳过;成员增删实时读取 GroupManager,无需重新注册
import { getGroupManager } from "./index.js";
import { createDlnaProtocolPlayer, getDevice, getDeviceStatus, isDeviceAvailable } from "../dlna/control.js";
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../player/types.js";
import { createLogger } from "../../utils/logger.js";

/** 组当前在线的成员 deviceId 列表(按成员顺序)。
 *  用"实时可达性"(isDeviceAvailable,由最近一次 SOAP 成败决定)而非发现缓存里的
 *  available(10 分钟无 SSDP 才翻转)——否则断电/断网一分钟内看门狗完全无法感知成员离线。 */
const log = createLogger("group");
export function getOnlineMemberIds(groupId: string): string[] {
  const g = getGroupManager().get(groupId);
  if (!g) return [];
  return g.memberIds.filter(d => isDeviceAvailable(d));
}

/** 组的状态派生 leader = 固定顺序第一个在线成员(对照 MA _select_sync_leader)。 */
export function getGroupLeaderDeviceId(groupId: string): string | undefined {
  return getOnlineMemberIds(groupId)[0];
}

export function createGroupProtocolPlayer(groupId: string): ProtocolPlayer {
  const playerId = `group:${groupId}`;

  async function fanOut(
    op: (p: ProtocolPlayer) => Promise<unknown>,
  ): Promise<{ fulfilled: number; rejected: number }> {
    const members = getOnlineMemberIds(groupId);
    if (members.length === 0) return { fulfilled: 0, rejected: 0 };
    const results = await Promise.allSettled(members.map(d => op(createDlnaProtocolPlayer(d))));
    const rejected = results.filter(r => r.status === "rejected");
    if (rejected.length > 0) {
      log.warn(`[group] ${groupId}: ${rejected.length}/${members.length} 成员命令失败`);
    }
    return { fulfilled: results.length - rejected.length, rejected: rejected.length };
  }

  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string) {
      const members = getOnlineMemberIds(groupId);
      if (members.length === 0) {
        throw new Error(`组 ${groupId} 无在线成员,无法播放`);
      }
      const results = await Promise.allSettled(
        members.map(d => createDlnaProtocolPlayer(d).playMedia(item, baseUrl)),
      );
      const ok = results.find(r => r.status === "fulfilled");
      if (!ok) throw new Error(`组 ${groupId} 全部成员 cast 失败`);
      const rejected = results.filter(r => r.status === "rejected");
      if (rejected.length > 0) {
        log.warn(`[group][cast] ${groupId}: ${rejected.length}/${members.length} 成员 cast 失败`);
      }
      // 上报用的 mediaUri 取 leader 的(状态派生自 leader)。
      return (ok as PromiseFulfilledResult<{ mediaUri: string }>).value;
    },
    async stop() { await fanOut(p => p.stop()); },
    async pause() { await fanOut(p => p.pause()); },
    async resume() { await fanOut(p => p.resume()); },
    async seek(seconds: number) { await fanOut(p => p.seek(seconds)); },
    async setVolume(vol: number) { await fanOut(p => p.setVolume(vol)); },
    async pollState(): Promise<PlayerState> {
      const leader = getGroupLeaderDeviceId(groupId);
      if (!leader) {
        // 全部成员离线:不要报 IDLE——那会被 PlaybackTracker 当作"曲目自然结束"
        // (lastPlaying→IDLE→ended)从而 deactivate 队列,看门狗就无法悬挂/恢复。
        // 报 BUFFERING 瞬态:tracker 视为瞬态屏蔽,lastPlaying 保留,等待成员回归后由
        // 看门狗 resumeActive(cast 成功会进乐观窗口 → PLAYING)。
        return { playerId, playbackState: PlaybackState.BUFFERING, position: 0, duration: 0, updatedAt: Date.now() };
      }
      // leader 当前不可达(SOAP 失败已被 isDeviceAvailable 标记)→ 同上,不把离线默认
      // STOPPED 当成结束(仅当 getOnlineMemberIds 用的是 isDeviceAvailable 后此处防御性保留)。
      if (!isDeviceAvailable(leader)) {
        return { playerId, playbackState: PlaybackState.BUFFERING, position: 0, duration: 0, updatedAt: Date.now() };
      }
      // 状态从 leader 派生(对照 MA _update_attributes);mediaUri 用于 track_changed 检测。
      const s = await createDlnaProtocolPlayer(leader).pollState();
      return { ...s, playerId };
    },
  };
}

/** 组状态(路由层 /v1/peers/group:<id>/status 用):直接取 leader 的设备状态。
 *  组无在线成员时返回 STOPPED 默认值。 */
export async function getGroupStatus(groupId: string): Promise<{
  state: string; position: number; duration: number; volume: number; muted: boolean; media?: unknown;
  updatedAt: number;
}> {
  const leader = getGroupLeaderDeviceId(groupId);
  if (!leader) return { state: "STOPPED", position: 0, duration: 0, volume: 0, muted: false, updatedAt: Date.now() };
  return getDeviceStatus(leader);
}
