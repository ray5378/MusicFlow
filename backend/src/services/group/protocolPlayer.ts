// 组协议 player:实现 ProtocolPlayer 接口,对组内在线成员扇出命令。
// 仿 MA Universal Group(全部成员并发播同一 URL,无漂移校正):
//   - 成员按 kind 分流:dlna 逐成员 cast(各设备自拉流);sendspin 子集走**一个**
//     共享 pump(ug:<groupId> 组＋单时间线,多房间同步,见 sendspin/playerCore)。
//     混编组(dlna＋sendspin 同组)两种路径各播各的, roughly 同时起播,不做跨协议
//     采样级对齐(MA 桥接语义同)。
//   - playMedia/stop/pause/resume/seek/setVolume → dlna 扇出 ＋ sendspin 组单发
//   - pollState → leader 派生(leader 可能是 sendspin 成员,走组 pump 状态)
//   - 成员离线自动跳过;成员增删实时读取 GroupManager,无需重新注册
import { getGroupManager, splitMemberId } from "./index.js";
import { createDlnaProtocolPlayer, getDevice, getDeviceStatus, isDeviceAvailable } from "../dlna/control.js";
import { getSendspinFront } from "../sendspin/index.js";
import { sendspinGroupName } from "../sendspin/playerCore.js";
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../player/types.js";
import { createLogger } from "../../utils/logger.js";

/** 组内成员按 kind 拆分(裸 id)。dlna 含历史裸写法。 */
export function splitGroupMembers(groupId: string): { dlna: string[]; spin: string[] } {
  const g = getGroupManager().get(groupId);
  const dlna: string[] = [];
  const spin: string[] = [];
  if (!g) return { dlna, spin };
  for (const m of g.memberIds) {
    const s = splitMemberId(m);
    if (!s) continue;
    (s.kind === "sendspin" ? spin : dlna).push(s.id);
  }
  return { dlna, spin };
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

/** 组是否有任一在线成员(dlna 在线或 sendspin 在线)。QC 结束抑制/看门狗悬挂判定用。 */
export function hasOnlineMember(groupId: string): boolean {
  if (getOnlineMemberIds(groupId).length > 0) return true;
  return getOnlineSendspinIds(groupId).length > 0;
}

/** 组 leader(固定顺序首个在线成员,跨 kind;对照 MA _select_sync_leader)。
 *  返回 kind＋裸 id;组无在线成员返回 undefined。 */
export function getGroupLeader(groupId: string): { kind: "dlna" | "sendspin"; id: string } | undefined {
  const g = getGroupManager().get(groupId);
  if (!g) return undefined;
  const spinOnline = new Set(getOnlineSendspinIds(groupId));
  for (const m of g.memberIds) {
    const s = splitMemberId(m);
    if (!s) continue;
    if (s.kind === "sendspin") {
      if (spinOnline.has(s.id)) return { kind: "sendspin", id: s.id };
    } else if (isDeviceAvailable(s.id)) {
      return { kind: "dlna", id: s.id };
    }
  }
  return undefined;
}

/** 组当前在线的成员 deviceId 列表(按成员顺序)。
 *  用"实时可达性"(isDeviceAvailable,由最近一次 SOAP 成败决定)而非发现缓存里的
 *  available(10 分钟无 SSDP 才翻转)——否则断电/断网一分钟内看门狗完全无法感知成员离线。
 *  ⚠️ 仅 DLNA 成员(裸 deviceId,历史兼容);sendspin 在线成员走 getOnlineSendspinIds,
 *  任一在线判定走 hasOnlineMember。 */
const log = createLogger("group");
export function getOnlineMemberIds(groupId: string): string[] {
  const g = getGroupManager().get(groupId);
  if (!g) return [];
  return g.memberIds
    .map(m => splitMemberId(m))
    .filter(s => s !== null && s.kind === "dlna")
    .map(s => (s as { id: string }).id)
    .filter(d => isDeviceAvailable(d));
}

/** 组的状态派生 leader = 固定顺序第一个在线成员(对照 MA _select_sync_leader)。
 *  保留 DLNA 专用口径(裸 deviceId,事件叠加层用);跨 kind 判定走 getGroupLeader。 */
export function getGroupLeaderDeviceId(groupId: string): string | undefined {
  return getOnlineMemberIds(groupId)[0];
}

export function createGroupProtocolPlayer(groupId: string): ProtocolPlayer {
  const playerId = `group:${groupId}`;

  async function fanOut(
    opName: string,
    op: (p: ProtocolPlayer) => Promise<unknown>,
  ): Promise<{ fulfilled: number; rejected: number }> {
    const members = getOnlineMemberIds(groupId);
    if (members.length === 0) {
      log.debug(`[group][${opName}] ${groupId}: 无在线 DLNA 成员,跳过扇出`);
      return { fulfilled: 0, rejected: 0 };
    }
    const t0 = Date.now();
    const results = await Promise.allSettled(members.map(d => op(createDlnaProtocolPlayer(d))));
    // debug:逐成员记录失败者 —— 原实现只打「N/M 失败」总数,查「到底是谁没跟上」
    // (组内 seek 后某台音箱停在旧位置)时无从下手。
    const failed = results
      .map((r, i) => (r.status === "rejected" ? `${members[i]}(${r.reason?.message || r.reason})` : null))
      .filter((x): x is string => x !== null);
    if (failed.length > 0) {
      log.warn(`[group][${opName}] ${groupId}: ${failed.length}/${members.length} 成员失败 ${Date.now() - t0}ms → ${failed.join(", ")}`);
    }
    return { fulfilled: results.length - failed.length, rejected: failed.length };
  }

  /** sendspin 子集单发组指令(共享 pump,非逐成员扇出)。无 sendspin 成员直接跳过。 */
  async function spinOp(op: (p: ProtocolPlayer) => Promise<unknown>): Promise<void> {
    if (splitGroupMembers(groupId).spin.length === 0) return;
    // 动态导入:QC → 本文件 → sendspin/protocolPlayer → player/index → QC 成环,
    // 静态边会 TDZ,沿用 emitMediaChanged 同构。
    const { createSendspinGroupPlayer } = await import("../sendspin/protocolPlayer.js");
    await op(createSendspinGroupPlayer(groupId));
  }

  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string) {
      const dlnaOnline = getOnlineMemberIds(groupId);
      const spinOnline = getOnlineSendspinIds(groupId);
      if (dlnaOnline.length === 0 && spinOnline.length === 0) {
        throw new Error(`组 ${groupId} 无在线成员,无法播放`);
      }
      const jobs: Array<Promise<{ mediaUri: string }>> = [];
      if (spinOnline.length > 0) {
        // sendspin 子集共用一个 pump 同一时间线(多房间同步),不是逐成员 cast。
        jobs.push((async () => {
          const { createSendspinGroupPlayer } = await import("../sendspin/protocolPlayer.js");
          return createSendspinGroupPlayer(groupId).playMedia(item, baseUrl);
        })());
      }
      for (const d of dlnaOnline) jobs.push(createDlnaProtocolPlayer(d).playMedia(item, baseUrl));
      const results = await Promise.allSettled(jobs);
      const ok = results.find(r => r.status === "fulfilled");
      if (!ok) throw new Error(`组 ${groupId} 全部成员 cast 失败`);
      const rejected = results.filter(r => r.status === "rejected");
      if (rejected.length > 0) {
        log.warn(`[group][cast] ${groupId}: ${rejected.length}/${results.length} 路播放失败`);
      }
      // 上报用的 mediaUri 取首个成功的(状态派生仍走 leader,见 pollState)。
      return (ok as PromiseFulfilledResult<{ mediaUri: string }>).value;
    },
    async stop() { await fanOut("stop", p => p.stop()); await spinOp(p => p.stop()); },
    async pause() { await fanOut("pause", p => p.pause()); await spinOp(p => p.pause()); },
    async resume() { await fanOut("resume", p => p.resume()); await spinOp(p => p.resume()); },
    async seek(seconds: number) {
      // debug:组 seek 是「DLNA 扇出 + sendspin 组单发」两条独立路径 ——
      // 一条成功一条失败时,组内成员会停在两个不同时间轴(组内不同步的根因),
      // 所以这里必须把两路的结果分别打出来。
      const t0 = Date.now();
      const dlna = await fanOut("seek", p => p.seek(seconds));
      const spinCount = splitGroupMembers(groupId).spin.length;
      await spinOp(p => p.seek(seconds));
      log.debug(
        `[group][seek] ${groupId} 目标=${seconds.toFixed(2)}s DLNA ${dlna.fulfilled}/${dlna.fulfilled + dlna.rejected}`
        + ` sendspin=${spinCount} 耗时 ${Date.now() - t0}ms`,
      );
    },
    async setVolume(vol: number) { await fanOut("setVolume", p => p.setVolume(vol)); await spinOp(p => p.setVolume(vol)); },
    async pollState(): Promise<PlayerState> {
      const leader = getGroupLeader(groupId);
      if (!leader) {
        // 全部成员离线:不要报 IDLE——那会被 PlaybackTracker 当作"曲目自然结束"
        // (lastPlaying→IDLE→ended)从而 deactivate 队列,看门狗就无法悬挂/恢复。
        // 报 BUFFERING 瞬态:tracker 视为瞬态屏蔽,lastPlaying 保留,等待成员回归后由
        // 看门狗 resumeActive(cast 成功会进乐观窗口 → PLAYING)。
        return { playerId, playbackState: PlaybackState.BUFFERING, position: 0, duration: 0, updatedAt: Date.now() };
      }
      if (leader.kind === "sendspin") {
        // sendspin 成员音频来自共享组 pump,状态从组 pump 派生(非单设备 pump)。
        const { createSendspinGroupPlayer } = await import("../sendspin/protocolPlayer.js");
        const s = await createSendspinGroupPlayer(groupId).pollState();
        return { ...s, playerId };
      }
      // leader 当前不可达(SOAP 失败已被 isDeviceAvailable 标记)→ 同上,不把离线默认
      // STOPPED 当成结束(仅当 getOnlineMemberIds 用的是 isDeviceAvailable 后此处防御性保留)。
      if (!isDeviceAvailable(leader.id)) {
        return { playerId, playbackState: PlaybackState.BUFFERING, position: 0, duration: 0, updatedAt: Date.now() };
      }
      // 状态从 leader 派生(对照 MA _update_attributes);mediaUri 用于 track_changed 检测。
      const s = await createDlnaProtocolPlayer(leader.id).pollState();
      return { ...s, playerId };
    },
  };
}

/** 组状态(路由层 /v1/peers/group:<id>/status 用):leader 派生;无在线成员 STOPPED 默认值。
 *  leader 是 sendspin 成员时从共享组 pump 派生(位置/时长走组时间线,音量走组标度)。 */
export async function getGroupStatus(groupId: string): Promise<{
  state: string; position: number; duration: number; volume: number; muted: boolean; media?: unknown;
  updatedAt: number;
}> {
  const leader = getGroupLeader(groupId);
  if (!leader) return { state: "STOPPED", position: 0, duration: 0, volume: 0, muted: false, updatedAt: Date.now() };
  if (leader.kind === "sendspin") {
    const { sendspinGroupPoll } = await import("../sendspin/index.js");
    const gname = sendspinGroupName(groupId);
    const st = await sendspinGroupPoll(gname).catch(() => ({ playing: false, positionMs: 0, durationMs: 0 }));
    const front = getSendspinFront();
    const gv = front?.groups.get(gname) as any;
    return {
      state: st.playing ? "PLAYING" : "STOPPED",
      position: Math.floor(st.positionMs / 1000),
      duration: Math.floor(st.durationMs / 1000),
      volume: typeof gv?.volume === "number" ? gv.volume : 100,
      muted: !!gv?.muted,
      media: gv?.current ?? undefined,
      updatedAt: Date.now(),
    };
  }
  return getDeviceStatus(leader.id);
}
