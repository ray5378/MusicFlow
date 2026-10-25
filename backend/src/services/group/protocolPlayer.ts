// 组协议 player:实现 ProtocolPlayer 接口,对组内在线成员扇出命令。
// 仿 MA Universal Group(全部成员并发播同一 URL,无漂移校正):
//   - 成员按 kind 分流:dlna/airplay 逐成员 cast(各设备自拉流);sendspin 子集走**一个**
//     共享 pump(ug:<groupId> 组＋单时间线,多房间同步,见 sendspin/playerCore)。
//     混编组各播各的,roughly 同时起播,不做跨协议采样级对齐(MA 桥接语义同)。
//   - playMedia/stop/pause/resume/seek/setVolume → dlna/airplay 扇出 ＋ sendspin 组单发
//   - pollState → leader 派生(leader 可能是 sendspin/airplay 成员)
//   - 成员离线自动跳过;成员增删实时读取 GroupManager,无需重新注册
import { getGroupManager, splitMemberId } from "./index.js";
import { createDlnaProtocolPlayer, getDevice, getDeviceStatus, isDeviceAvailable } from "../dlna/control.js";
import { createAirPlayProtocolPlayer } from "../airplay/protocolPlayer.js";
import { getAirPlayStatus, isAirPlayDeviceDisabled, isAirplayBridgeEnabled, isBridgeOwned, bridgePrepareDevice, bridgeStopDevice } from "../airplay/control.js";
import { bridgeSocketPath } from "../airplay/bridgeChannel.js";
import type { BridgeSocketSpec } from "../sendspin/bridgeAttach.js";
import { getSendspinFront } from "../sendspin/index.js";
import { sendspinGroupName } from "../sendspin/playerCore.js";
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../player/types.js";
import { createLogger } from "../../utils/logger.js";
import { randomBytes } from "node:crypto";

// ---- Phase 3/5:活跃桥路由(§5.1 路由快照 + §5.5 owner token)----
// groupId → 已成功 bridgePrepare 的设备/token(流内不切路由;seek 重建不重 prepare,
// 自然切歌/新 playMedia 重建路由)。模块级:跨 player 实例共享,流内成员变化
// (bridgeJoinMember/bridgeLeaveMember)与 airplay 子进程重启(rebuildBridgeRoutes)都要读它。
const activeBridgeRoutes = new Map<string, BridgeSocketSpec[]>();

/** 生成新的桥会话 token(§5.5 owner token;与 playMedia 路径同一格式)。 */
const newBridgeToken = (): string => randomBytes(12).toString("hex");

/** 该组当前是否走桥接路由(§5.2 流内成员变化的路由判定依据)。 */
export function isBridgeRouteActive(groupId: string): boolean {
  return (activeBridgeRoutes.get(groupId)?.length ?? 0) > 0;
}

/** 播中加入一台 AirPlay 到桥路由(§5.2:「bridgePrepare + 从 pump ring 回填,
 *  不 rejoinMembersAirplay」)。桥路由未激活时返回 false(调用方回落 legacy join)。
 *  抛错 = bridgePrepare 失败(调用方按 MAJ-07 降级:回落 solo cast)。 */
export async function bridgeJoinMember(groupId: string, deviceId: string): Promise<boolean> {
  const route = activeBridgeRoutes.get(groupId);
  if (!route || !isAirplayBridgeEnabled()) return false;
  if (route.some((r) => r.deviceId === deviceId)) return true; // 已在路由内,幂等
  const token = newBridgeToken();
  bridgeSocketPath(deviceId, token); // <100B 断言(与 playMedia 路径同源)
  await bridgePrepareDevice(deviceId, token, "raop");
  const spec: BridgeSocketSpec = { deviceId, socketPath: bridgeSocketPath(deviceId, token), token, protocol: "raop" };
  route.push(spec);
  const groupName = sendspinGroupName(groupId);
  const r = await import("../sendspin/index.js");
  const sync = await r.sendspinGroupBridgeSync(groupName, [...route]);
  log.info(`[group][bridge] ${groupId}: 播中加入 device=${deviceId} sync=${sync.synced} backfill=${sync.backfilled} frames`);
  return true;
}

/** 播中摘除一台 AirPlay(§5.2:「bridgeStop(device);设备回到可 cast 状态」)。
 *  幂等:不在路由内返回 false。 */
export async function bridgeLeaveMember(groupId: string, deviceId: string): Promise<boolean> {
  const route = activeBridgeRoutes.get(groupId);
  if (!route) return false;
  const idx = route.findIndex((r) => r.deviceId === deviceId);
  if (idx < 0) return false;
  const [removed] = route.splice(idx, 1);
  const groupName = sendspinGroupName(groupId);
  const r = await import("../sendspin/index.js");
  await r.sendspinGroupBridgeSync(groupName, [...route]).catch(() => null); // 泵侧摘句柄(best-effort)
  await bridgeStopDevice(removed.token, deviceId);
  log.info(`[group][bridge] ${groupId}: 播中摘除 device=${deviceId}(设备回到可 cast 状态)`);
  return true;
}

/** airplay 子进程重启后的桥路由重建(§5.2「airplay 子进程崩溃」行):
 *  逐设备用**原 token** 重发 bridgePrepare(同 socketPath ⇒ 泵侧 BridgeMember
 *  退避重连即接上,BOUNDARY{rehost} 新 generation 自动产生)。幂等、全 best-effort。 */
export async function rebuildBridgeRoutes(): Promise<number> {
  let ok = 0;
  for (const [groupId, route] of activeBridgeRoutes) {
    for (const spec of route) {
      try {
        await bridgePrepareDevice(spec.deviceId, spec.token, spec.protocol);
        ok++;
      } catch (e) {
        log.warn(`[group][bridge] ${groupId}: 子进程重启重建失败 device=${spec.deviceId}: ${(e as Error)?.message || e}`);
      }
    }
  }
  if (activeBridgeRoutes.size > 0) {
    log.info(`[group][bridge] 子进程重启重建: ${ok}/${[...activeBridgeRoutes.values()].reduce((n, r) => n + r.length, 0)} 座桥已重锚定`);
  }
  return ok;
}

/** 设备离线(mDNS byebye,§5.2):立刻从全部活跃桥路由摘除(不等重连),
 *  逐组 bridgeSync 摘泵句柄 + bridgeStop 清会话/owner;设备重新上线按「加入」处理。 */
export async function notifyAirplayDeviceOffline(deviceId: string): Promise<number> {
  let n = 0;
  for (const [groupId, route] of [...activeBridgeRoutes]) {
    if (!route.some((r) => r.deviceId === deviceId)) continue;
    try {
      if (await bridgeLeaveMember(groupId, deviceId)) n++;
    } catch (e) {
      log.warn(`[group][bridge] ${groupId}: 离线摘除失败 device=${deviceId}: ${(e as Error)?.message || e}`);
    }
  }
  if (n > 0) log.info(`[group][bridge] 设备离线: device=${deviceId} 已从 ${n} 个组桥路由摘除(标 offline,重连按加入处理)`);
  return n;
}

/** 组内成员按 kind 拆分(裸 id)。dlna 含历史裸写法(仅旧组,新提交已禁)。 */
export function splitGroupMembers(groupId: string): { dlna: string[]; airplay: string[]; spin: string[] } {
  const g = getGroupManager().get(groupId);
  const dlna: string[] = [];
  const airplay: string[] = [];
  const spin: string[] = [];
  if (!g) return { dlna, airplay, spin };
  for (const m of g.memberIds) {
    const s = splitMemberId(m);
    if (!s) continue;
    if (s.kind === "sendspin") spin.push(s.id);
    else if (s.kind === "airplay") airplay.push(s.id);
    else dlna.push(s.id);
  }
  return { dlna, airplay, spin };
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

/** 组内在线 airplay 成员(裸 deviceId):设备未禁用且 status.available 判定。
 *  available 来自设备档案 + 发现态(与 /v1/airplay 同源),会话不存在时回档案值。 */
export function getOnlineAirplayIds(groupId: string): string[] {
  return splitGroupMembers(groupId).airplay
    .filter(id => !isAirPlayDeviceDisabled(id) && getAirPlayStatus(id).available);
}

/** 组是否有任一在线成员(dlna / airplay / sendspin 任一)。QC 结束抑制/看门狗悬挂判定用。 */
export function hasOnlineMember(groupId: string): boolean {
  if (getOnlineMemberIds(groupId).length > 0) return true;
  if (getOnlineAirplayIds(groupId).length > 0) return true;
  return getOnlineSendspinIds(groupId).length > 0;
}

/** 组 leader(固定顺序首个在线成员,跨 kind;对照 MA _select_sync_leader)。
 *  返回 kind＋裸 id;组无在线成员返回 undefined。 */
export function getGroupLeader(groupId: string): { kind: "dlna" | "sendspin" | "airplay"; id: string } | undefined {
  const g = getGroupManager().get(groupId);
  if (!g) return undefined;
  const spinOnline = new Set(getOnlineSendspinIds(groupId));
  const apOnline = new Set(getOnlineAirplayIds(groupId));
  for (const m of g.memberIds) {
    const s = splitMemberId(m);
    if (!s) continue;
    if (s.kind === "sendspin") {
      if (spinOnline.has(s.id)) return { kind: "sendspin", id: s.id };
    } else if (s.kind === "airplay") {
      if (apOnline.has(s.id)) return { kind: "airplay", id: s.id };
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
    // dlna 与 airplay 成员一起逐设备扇出(airplay 用独立 cast,不进 sendspin pump)。
    // Phase 3(MAJ-06):桥占用设备(owner=bridge)的传输由组泵承担 —— 逐成员扇出
    // (stop/pause/resume/seek/setVolume)必须跳过它,否则会与桥会话互踩。
    const dlnaIds = getOnlineMemberIds(groupId);
    const apIds = getOnlineAirplayIds(groupId).filter((d) => !isBridgeOwned(d));
    if (dlnaIds.length === 0 && apIds.length === 0) {
      log.debug(`[group][${opName}] ${groupId}: 无在线 DLNA/AirPlay 成员,跳过扇出`);
      return { fulfilled: 0, rejected: 0 };
    }
    const names = [...dlnaIds, ...apIds];
    const players = [...dlnaIds.map(d => createDlnaProtocolPlayer(d)), ...apIds.map(d => createAirPlayProtocolPlayer(d))];
    const t0 = Date.now();
    const results = await Promise.allSettled(players.map(p => op(p)));
    // debug:逐成员记录失败者 —— 原实现只打「N/M 失败」总数,查「到底是谁没跟上」
    // (组内 seek 后某台音箱停在旧位置)时无从下手。
    const failed = results
      .map((r, i) => (r.status === "rejected" ? `${names[i]}(${r.reason?.message || r.reason})` : null))
      .filter((x): x is string => x !== null);
    if (failed.length > 0) {
      log.warn(`[group][${opName}] ${groupId}: ${failed.length}/${names.length} 成员失败 ${Date.now() - t0}ms → ${failed.join(", ")}`);
    }
    return { fulfilled: results.length - failed.length, rejected: failed.length };
  }

  /** sendspin 子集单发组指令(共享 pump,非逐成员扇出)。无 sendspin 成员直接跳过。
   *  Phase 3:bridge 规格透传到组泵(spinOnline=0 时无组泵,路由本就不会进 bridge)。 */
  async function spinOp(op: (p: ProtocolPlayer) => Promise<unknown>): Promise<void> {
    if (splitGroupMembers(groupId).spin.length === 0) return;
    // 动态导入:QC → 本文件 → sendspin/protocolPlayer → player/index → QC 成环,
    // 静态边会 TDZ,沿用 emitMediaChanged 同构。
    const { createSendspinGroupPlayer } = await import("../sendspin/protocolPlayer.js");
    await op(createSendspinGroupPlayer(groupId));
  }

  // ---- Phase 3:桥接路由(§5.1 路由快照 + §5.5 owner token + MAJ-07 降级) ----
  // activeBridgeRoutes 在模块层(见文件顶部):跨 player 实例共享,供
  // bridgeJoinMember/bridgeLeaveMember/rebuildBridgeRoutes 等流内成员变化操作访问。

  /** 拆本组桥路由:逐设备 bridgeStop + 清 owner。幂等。 */
  async function teardownBridgeRoute(): Promise<void> {
    const route = activeBridgeRoutes.get(groupId);
    if (!route) return;
    activeBridgeRoutes.delete(groupId);
    await Promise.allSettled(route.map((r) => bridgeStopDevice(r.token, r.deviceId)));
  }

  /** 准备桥路由:逐设备生成 token → bridgePrepare(§4.1 顺序 ①)。
   *  单设备失败(MAJ-07)→ 记入 fallback,该设备本流回落 solo cast;
   *  全部失败 → 返回 null(整组退回 legacy 路由,与 flag=0 同行为)。
   *  返回:成功规格数组 + 需回落 solo cast 的设备列表。 */
  async function prepareBridgeRoute(
    apOnline: string[],
  ): Promise<{ sockets: BridgeSocketSpec[]; soloFallback: string[] } | null> {
    if (!isAirplayBridgeEnabled() || apOnline.length === 0) return null;
    const sockets: BridgeSocketSpec[] = [];
    const soloFallback: string[] = [];
    for (const d of apOnline) {
      const token = randomBytes(12).toString("hex");
      try {
        // socketPath 在主进程按同一实现计算(bridgeSocketPath,<100B 断言在此抛)。
        bridgeSocketPath(d, token);
        await bridgePrepareDevice(d, token, "raop");
        sockets.push({ deviceId: d, socketPath: bridgeSocketPath(d, token), token, protocol: "raop" });
      } catch (e) {
        log.warn(`[group][bridge] ${groupId}: bridgePrepare 失败 device=${d} → 本流回落 solo cast: ${(e as Error)?.message || e}`);
        soloFallback.push(d);
      }
    }
    if (sockets.length === 0) return null;
    return { sockets, soloFallback };
  }

  return {
    playerId,
    async playMedia(item: QueueItem, baseUrl: string) {
      const dlnaOnline = getOnlineMemberIds(groupId);
      const apOnline = getOnlineAirplayIds(groupId);
      const spinOnline = getOnlineSendspinIds(groupId);
      if (dlnaOnline.length === 0 && apOnline.length === 0 && spinOnline.length === 0) {
        throw new Error(`组 ${groupId} 无在线成员,无法播放`);
      }
      // 上一条桥路由先拆(新 playMedia 重建路由;同代次 socket 会话随之回收)。
      await teardownBridgeRoute();
      // 路由快照(§5.1):bridgeEnabled && spin>0 && ap>0 → "bridge";
      // 否则 "legacy-cast"(flag=0 时与旧行为逐字节同路径)。
      const bridgeRoute = spinOnline.length > 0 ? await prepareBridgeRoute(apOnline) : null;
      const jobs: Array<Promise<{ mediaUri: string }>> = [];
      if (spinOnline.length > 0) {
        // sendspin 子集共用一个 pump 同一时间线(多房间同步),不是逐成员 cast。
        jobs.push((async () => {
          const { createSendspinGroupPlayer } = await import("../sendspin/protocolPlayer.js");
          return createSendspinGroupPlayer(groupId).playMedia(
            item, baseUrl, 0,
            bridgeRoute ? { sockets: bridgeRoute.sockets } : undefined,
          );
        })());
      }
      for (const d of dlnaOnline) jobs.push(createDlnaProtocolPlayer(d).playMedia(item, baseUrl));
      // airplay 成员:bridge 成功者**不**solo cast(桥消费组泵 PCM,§2.1);
      // prepare 失败者回落 solo cast(MAJ-07:绝不出现「在组里但无声且状态正常」)。
      const apSolo = bridgeRoute
        ? apOnline.filter((d) => bridgeRoute.soloFallback.includes(d))
        : apOnline;
      if (bridgeRoute) activeBridgeRoutes.set(groupId, bridgeRoute.sockets);
      for (const d of apSolo) jobs.push(createAirPlayProtocolPlayer(d).playMedia(item, baseUrl));
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
    async stop() {
      // 组停 = 流终态:先扇出/组停(桥成员被 stopGroupCore 清桥、发 BOUNDARY{stop}),
      // 再拆桥会话(bridgeStop TEARDOWN RAOP + 清 owner)。
      await fanOut("stop", p => p.stop());
      await spinOp(p => p.stop());
      await teardownBridgeRoute();
    },
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
    async setVolume(vol: number) {
      // 组音量先落库(无成员也持久);再扇出。路由层可能已写过,这里幂等覆盖。
      try { getGroupManager().setVolume(groupId, vol); } catch { /* 库失败不挡扇出 */ }
      await fanOut("setVolume", p => p.setVolume(vol));
      await spinOp(p => p.setVolume(vol));
    },
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
      if (leader.kind === "airplay") {
        // §5.5(MAJ-06):桥占用设备的传输由组泵承担。此时该设备的 **solo 会话视图恒空**
        // (RAOP 会话归 bridge 所有,getAirPlayStatus 看不到)→ 若照旧从 AirPlay 会话派生
        // 会恒报 IDLE/STOPPED → PlaybackTracker 判"曲目自然结束" → idle_early 复查走同一条
        // 错路也非 PLAYING → 放行切歌 → clearPlayback 打断桥流 → 每 ~5s 无限重启
        // (2026-10-26 隔离环境 A/B 实测:同组仅换 memberIds 顺序,leader=sendspin 稳定
        // PLAYING 且 idle_early=0;leader=airplay 恒 STOPPED 且 idle_early 4 次/22s)。
        // 组内存在 sendspin 成员(桥的 PCM 源即组泵)时,状态必须改从共享组泵派生。
        if (isBridgeOwned(leader.id) && splitGroupMembers(groupId).spin.length > 0) {
          const { createSendspinGroupPlayer } = await import("../sendspin/protocolPlayer.js");
          const s = await createSendspinGroupPlayer(groupId).pollState();
          return { ...s, playerId };
        }
        // airplay leader(非桥占用,独立 solo cast):状态从设备会话态派生(sessionView 同源)。
        const s = await createAirPlayProtocolPlayer(leader.id).pollState();
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
  // 音量权威 = GroupManager 持久库值(空组/全离线也回显用户上次调节)。
  const persistedVolume = getGroupManager().getVolume(groupId);
  const leader = getGroupLeader(groupId);
  if (!leader) {
    return { state: "STOPPED", position: 0, duration: 0, volume: persistedVolume, muted: false, updatedAt: Date.now() };
  }
  if (leader.kind === "sendspin") {
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
  if (leader.kind === "airplay") {
    // §5.5 同 pollState:桥占用时 solo 会话视图恒空,必须改从共享组泵派生
    // (否则 /v1/peers/group:<id>/status 在桥播放全程恒报 STOPPED)。
    if (isBridgeOwned(leader.id) && splitGroupMembers(groupId).spin.length > 0) {
      const { sendspinGroupPoll } = await import("../sendspin/index.js");
      const gname = sendspinGroupName(groupId);
      const gst = await sendspinGroupPoll(gname).catch(() => ({ playing: false, paused: false, positionMs: 0, durationMs: 0 }));
      return {
        state: gst.paused ? "PAUSED" : gst.playing ? "PLAYING" : "STOPPED",
        position: Math.floor(gst.positionMs / 1000),
        duration: Math.floor(gst.durationMs / 1000),
        volume: persistedVolume,
        muted: false,
        updatedAt: Date.now(),
      };
    }
    // airplay leader(非桥占用,独立 solo cast):会话态同步取值(无会话/已结束时回设备档案态,position=0)。
    const st = getAirPlayStatus(leader.id);
    const state = st.playbackState === PlaybackState.PLAYING ? "PLAYING"
      : st.playbackState === PlaybackState.PAUSED ? "PAUSED" : "STOPPED";
    return {
      state,
      position: Math.floor(st.position || 0),
      duration: Math.floor(st.duration || 0),
      volume: persistedVolume,
      muted: !!st.muted,
      updatedAt: Date.now(),
    };
  }
  const st = await getDeviceStatus(leader.id);
  // DLNA leader 的设备音量是单机标度;组音量以 GroupManager 为准(用户调的是「组」)。
  return { ...st, volume: persistedVolume };
}
