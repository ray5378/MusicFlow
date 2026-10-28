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
import { getAirPlayStatus, isAirPlayDeviceDisabled, isAirplayBridgeEnabled, isBridgeOwned, bridgePrepareDevice, bridgeStopDevice, selectAirPlayBridgeProtocol } from "../airplay/control.js";
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
  let route = activeBridgeRoutes.get(groupId);
  // 自愈(2026-10-27):容器重启后 resume-active 恢复的桥可能没有路由登记
  // (PUT delays 实测 isBridgeRouteActive=false ⇒ 重建不触发 ⇒ 补偿改值失效)。
  // 路由缺失不再一票否决:现场初始化空路由走完整 join —— 子进程 prepare 自带
  // 「拆同 deviceId 旧会话」,泵 sync 自动停旧句柄起新句柄并回填,链路自洽。
  if (!route) {
    if (!isAirplayBridgeEnabled()) return false;
    // 只自愈「设备确实有桥会话在跑」的情形(登记缺失的恢复桥/泄漏桥);
    // 组未在播或设备无桥时保持旧契约 false —— 否则会给空闲组挂一座孤儿桥。
    if (!isBridgeOwned(deviceId)) return false;
    route = [];
    activeBridgeRoutes.set(groupId, route);
  }
  if (!isAirplayBridgeEnabled()) return false;
  if (route.some((r) => r.deviceId === deviceId)) return true; // 已在路由内,幂等
  const token = newBridgeToken();
  bridgeSocketPath(deviceId, token); // <100B 断言(与 playMedia 路径同源)
  // 协议**逐成员**选(AP1 设备 raop / 已配对 AP2 设备 ap2-realtime),不是组级:
  // 同一组里 AP1 与 AP2 成员各按自己的协议出声(选择点唯一 = control.ts)。
  const protocol = selectAirPlayBridgeProtocol(deviceId);
  await bridgePrepareDevice(deviceId, token, protocol, groupId);
  const spec: BridgeSocketSpec = { deviceId, socketPath: bridgeSocketPath(deviceId, token), token, protocol };
  route.push(spec);
  const groupName = sendspinGroupName(groupId);
  const r = await import("../sendspin/index.js");
  // 改法(洞 D2):泵侧 sync 失败必须**回滚本次加入**。
  // 否则路由里会留下「主进程已 prepare、泵侧不知道」的半挂桥 —— 调用方按 MAJ-07 回落
  // solo cast,设备既被桥占用又走 solo cast;而且因为登记还在,60s 对账
  // (reconcileBridgeRoutesOnce 以「路由登记」为事实源)永远认为它合法、不会兜底摘除
  // (与 D1 同一失效面:设备被 owner=bridge 永久占用,只能重启)。
  // 语义:回滚后仍把原始错误抛给调用方(它据此降级 solo cast)。
  let sync: Awaited<ReturnType<typeof r.sendspinGroupBridgeSync>>;
  try {
    sync = await r.sendspinGroupBridgeSync(groupName, [...route]);
  } catch (e) {
    const idx = route.findIndex((x) => x.deviceId === deviceId && x.token === token);
    if (idx >= 0) route.splice(idx, 1);
    // 摘会话失败(子进程没跑/已断)不回滚错误语义,交对账兜底,保持 best-effort。
    await bridgeStopDevice(token, deviceId).catch(() => { /* ignore */ });
    log.warn(
      `[group][bridge] ${groupId}: 播中加入失败(泵侧 sync 异常)→ 已回滚 device=${deviceId}: ${(e as Error)?.message || e}`,
    );
    throw e;
  }
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
  // 改法3(洞 C):泵侧摘句柄**未确认**(sync 抛错 / fork 下 supervisor 未运行静默
  // no-op → confirmed=false)时**推迟 bridgeStopDevice** —— 否则句柄没摘成、sock 先
  // unlink,BridgeMember 顶着死路径无限退避重连(单侧孤儿)。推迟后设备被桥多占用
  // ≤2 个对账周期(60s 对账兜底摘除),远好于永久孤儿。
  const sync = await r.sendspinGroupBridgeSync(groupName, [...route]).catch(() => null);
  if (sync?.confirmed) {
    await bridgeStopDevice(removed.token, deviceId);
    log.info(`[group][bridge] ${groupId}: 播中摘除 device=${deviceId}(设备回到可 cast 状态)`);
  } else {
    log.warn(`[group][bridge] ${groupId}: 泵侧摘句柄未确认(${sync ? "confirmed=false" : "sync 异常"}),推迟 bridgeStop 交对账兜底 device=${deviceId} token=${removed.token}`);
  }
  return true;
}

/** airplay 子进程重启后的桥路由重建(§5.2「airplay 子进程崩溃」行):
 *  逐设备用**原 token** 重发 bridgePrepare(同 socketPath ⇒ 泵侧 BridgeMember
 *  退避重连即接上,BOUNDARY{rehost} 新 generation 自动产生)。幂等、全 best-effort。 */
export async function rebuildBridgeRoutes(onlyGroupId?: string): Promise<number> {
  let ok = 0;
  for (const [groupId, route] of activeBridgeRoutes) {
    // 只重建指定组:改「按组延迟补偿」时用,避免顺带把别的组的桥也断一下。
    if (onlyGroupId && groupId !== onlyGroupId) continue;
    for (const spec of route) {
      try {
        await bridgePrepareDevice(spec.deviceId, spec.token, spec.protocol, groupId);
        ok++;
      } catch (e) {
        log.warn(`[group][bridge] ${groupId}: 子进程重启重建失败 device=${spec.deviceId}: ${(e as Error)?.message || e}`);
      }
    }
  }
  if (activeBridgeRoutes.size > 0 && !onlyGroupId) {
    log.info(`[group][bridge] 子进程重启重建: ${ok}/${[...activeBridgeRoutes.values()].reduce((n, r) => n + r.length, 0)} 座桥已重锚定`);
  } else if (onlyGroupId) {
    log.info(`[group][bridge] ${onlyGroupId}: 延迟补偿变更 → 重建 ${ok} 座桥重锚定`);
  }
  return ok;
}

/** 运行期降级(Phase 6b · T04):某座 **AP2** 桥的链路断了(`ev=link-loss` /
 *  连续发送错误达 `AP2_SEND_ERROR_LIMIT` / RTSP 被对端拆除)。
 *
 *  动作(顺序固定):
 *   ① 定位登记该 token 的组(路由登记 = 主进程侧事实源);
 *   ② `bridgeLeaveMember` 摘泵句柄 + `bridgeStopDevice` 拆会话 + **清 owner=bridge**
 *     (确认不到时兜底直调 bridgeStopDevice,绝不让设备被桥永久占用);
 *   ③ 该设备**本流**回落 solo cast(`createAirPlayProtocolPlayer.playMedia(当前曲)`)。
 *
 *  ⚠️ **绝不在会话内切协议**:中途换协议 = 中途换锚点(RTP 映射/对齐器全作废),
 *  同组其它成员会当场错位。要换协议只能「摘桥 → 重建 → 新锚点」,即本函数做的事。
 *  ⚠️ 幂等:token 已不在任何路由里 ⇒ 返回 false(重复上报无害)。
 */
export async function degradeBridgeMember(deviceId: string, token: string, reason: string): Promise<boolean> {
  let groupId: string | null = null;
  for (const [gid, route] of activeBridgeRoutes) {
    if (route.some((r) => r.deviceId === deviceId && r.token === token)) {
      groupId = gid;
      break;
    }
  }
  if (groupId === null) return false;
  const left = await bridgeLeaveMember(groupId, deviceId).catch((e) => {
    log.warn(`[group][bridge] ${groupId}: 降级摘桥异常(继续兜底) device=${deviceId}: ${(e as Error)?.message || e}`);
    return false;
  });
  if (!left) {
    // 摘桥未确认(泵侧未回执/同步抛错):直接拆会话清 owner,宁可让设备回可 cast 状态。
    await bridgeStopDevice(token, deviceId).catch(() => { /* ignore */ });
  }
  log.warn(`[group][bridge] ${groupId}: AP2 链路断 → 降级 device=${deviceId} reason=${reason}(本流回落 solo cast)`);
  // ③ 本流回落:取组队列当前项,逐设备 cast(AirPlay 无 in-place seek,重投即新会话)。
  try {
    const { getQueueController } = await import("../player/index.js");
    const snap = getQueueController().snapshot(`group:${groupId}`);
    const item = snap.items[snap.currentIndex];
    if (!item) {
      log.warn(`[group][bridge] ${groupId}: 降级时队列无当前项,device=${deviceId} 仅摘桥(下一首自然走 solo cast)`);
      return true;
    }
    const { getEffectiveBaseUrl } = await import("../dlna/control.js");
    await createAirPlayProtocolPlayer(deviceId).playMedia(item, getEffectiveBaseUrl());
    log.info(`[group][bridge] ${groupId}: 降级回落 solo cast 成功 device=${deviceId} song=${item.songId}`);
  } catch (e) {
    // 回落失败只 warn:设备本流静音,但桥/owner 已清干净,不会卡住后续播放。
    log.warn(`[group][bridge] ${groupId}: 降级回落 solo cast 失败 device=${deviceId}: ${(e as Error)?.message || e}`);
  }
  return true;
}

/** AP2 降级看门狗周期(ms):远小于 60s 对账周期 —— 链路断是**出声中断**,
 *  等一个对账周期用户听到的就是「突然没了」。 */
export const BRIDGE_DEGRADE_POLL_MS = 5_000;

let bridgeDegradeTimer: NodeJS.Timeout | null = null;

/** 幂等启动 AP2 降级看门狗(与桥路由对账同源:由 `startBridgeRouteReconciler` 一并拉起)。 */
export function startBridgeDegradeWatchdog(intervalMs = BRIDGE_DEGRADE_POLL_MS): void {
  if (bridgeDegradeTimer !== null) return;
  bridgeDegradeTimer = setInterval(() => { void checkBridgeDegradedOnce(); }, intervalMs);
  bridgeDegradeTimer.unref?.();
}

export function stopBridgeDegradeWatchdog(): void {
  if (bridgeDegradeTimer !== null) {
    clearInterval(bridgeDegradeTimer);
    bridgeDegradeTimer = null;
  }
}

/** 单轮降级检查:读 airplay 子进程的桥会话快照(`bridgeStatus`),把
 *  `degraded=true` 的会话逐个降级。全程 best-effort(子进程没跑 ⇒ 无动作)。 */
export async function checkBridgeDegradedOnce(): Promise<number> {
  if (activeBridgeRoutes.size === 0) return 0;
  const { airplaySupervisor } = await import("../airplay/supervisor.js");
  if (!airplaySupervisor.isRunning()) return 0;
  type Row = { deviceId: string; token: string; degraded?: boolean; linkLoss?: string | null };
  let rows: Row[] = [];
  try {
    rows = await airplaySupervisor.rpc<Row[]>("bridgeStatus");
  } catch {
    return 0; // 子进程重启中:下一轮再看
  }
  let n = 0;
  for (const r of rows) {
    if (!r?.degraded) continue;
    if (await degradeBridgeMember(r.deviceId, r.token, r.linkLoss ?? "ap2-link-loss")) n++;
  }
  return n;
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

/** v4.9.3(§互斥豁免):该桥会话是否仍归属一个「活」的用户组(组存在且设备仍是成员)。
 *  活(含 bridgePrepare 进行中窗口,此时 activeBridgeRoutes 尚未登记)⇒ 同 host
 *  DLNA 互斥豁免(接管语义);组已解散/设备已移出 ⇒ 孤儿桥会话,允许互斥回收。 */
export function isGroupBridgeSessionAttached(groupId: string, deviceId: string): boolean {
  const g = getGroupManager().get(groupId);
  if (!g) return false;
  return g.memberIds.includes(`airplay:${deviceId}`);
}

export function createGroupProtocolPlayer(groupId: string): ProtocolPlayer {
  const playerId = `group:${groupId}`;

  async function fanOut(
    opName: string,
    op: (p: ProtocolPlayer) => Promise<unknown>,
  ): Promise<{ fulfilled: number; rejected: number }> {
    // dlna 与 airplay 成员一起逐设备扇出(airplay 用独立 cast,不进 sendspin pump)。
    // Phase 3(MAJ-06):桥占用设备(owner=bridge)的**传输类** op(stop/pause/resume/
    // seek)由组泵承担,逐成员扇出必须跳过,否则与桥会话互踩(守卫钉此语句形态)。
    const dlnaIds = getOnlineMemberIds(groupId);
    const apIds = getOnlineAirplayIds(groupId).filter((d) => !isBridgeOwned(d));
    // ⚠️ setVolume 例外(2026-10-27 真机 HiVi 音量 slider 死):音量泵不承担、桥也无
    // 其他音量路径(桥会话只在建立时收到一次 initial volume)→ 桥占用成员在 setVolume
    // 时仍要扇出。setAirPlayVolume = 先落库再 RAOP SET_PARAMETER / DLNA RenderingControl
    // 同 host 转发,纯控制链不触 RTP/时间线,与泵互不踩;过滤语句本体保持守卫钉定形态。
    if (opName === "setVolume") {
      for (const d of getOnlineAirplayIds(groupId)) {
        if (isBridgeOwned(d) && !apIds.includes(d)) apIds.push(d);
      }
    }
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
   *  Phase 3:bridge 规格透传到组泵(v4.9.3 方向 A:纯 AP 桥组 spin=0 也有组泵,见下守卫)。 */
  async function spinOp(op: (p: ProtocolPlayer) => Promise<unknown>): Promise<void> {
    // v4.9.3 方向 A:纯 AirPlay 桥组(无 spin 成员但有活跃桥路由)的传输/音量 op
    // 也必须落到组泵 —— 桥消费泵时间线,跳过泵 = 桥不可暂停/不可停/音量不跟随。
    if (splitGroupMembers(groupId).spin.length === 0 && !activeBridgeRoutes.has(groupId)) return;
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
    /** B 方案暖复用:上一条路由的 specs —— 同设备同协议沿用旧 token ⇒ 子进程暖复用会话。 */
    reuse?: BridgeSocketSpec[],
  ): Promise<{ sockets: BridgeSocketSpec[]; soloFallback: string[] } | null> {
    if (!isAirplayBridgeEnabled() || apOnline.length === 0) return null;
    // v4.9.3(§音量语义):桥会话初始音量 = player_groups 落库值(用户裁定:流转/起播
    // 绝不采用成员设备自身音量);随 bridgePrepare 下发,子进程不碰 DB。
    const groupInitialVolume = getGroupManager().getVolume(groupId);
    const sockets: BridgeSocketSpec[] = [];
    const soloFallback: string[] = [];
    for (const d of apOnline) {
      // 协议先选(B 方案:暖复用判据含协议一致 ⇒ token 沿用与否取决于协议)。
      const protocol = selectAirPlayBridgeProtocol(d);
      const prevSpec = reuse?.find((r) => r.deviceId === d && r.protocol === protocol);
      // 同设备同协议沿用旧 token ⇒ 子进程暖复用会话(RAOP 握手零重来);否则新 token(冷启语义)。
      const token = prevSpec ? prevSpec.token : randomBytes(12).toString("hex");
      try {
        // socketPath 在主进程按同一实现计算(bridgeSocketPath,<100B 断言在此抛)。
        bridgeSocketPath(d, token);
        // v4.9.4:settle 只在冷建(新 token)时做;warm 复用(同 token 哑会话)不等待 ——
        // 快路径,DLNA 早已让位(本组上一首即在播)。
        await bridgePrepareDevice(d, token, protocol, groupId, { initialVolume: groupInitialVolume, settleDlna: !prevSpec });
        sockets.push({ deviceId: d, socketPath: bridgeSocketPath(d, token), token, protocol });
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
      // B 方案(对齐 MA warm reuse):上一条桥路由与当前在线 AirPlay 成员**同集合且
      // 协议一致** ⇒ 复用 token 且不拆会话 —— 桥子进程按「同 token 同协议」暖复用
      // (RAOP 握手/设备缓冲零重来),新曲由 BOUNDARY(track) 驱动重锚(与 seek 同路径);
      // 句柄热复用见 bridgeAttach.syncGroupBridges。成员/协议变化 ⇒ 冷启(拆旧建新)。
      const prevRoute = activeBridgeRoutes.get(groupId);
      const routeReusable = apOnline.length > 0 && !!prevRoute && prevRoute.length > 0
        && apOnline.length === prevRoute.length
        && apOnline.every((d) => prevRoute.some((r) => r.deviceId === d && r.protocol === selectAirPlayBridgeProtocol(d)));
      if (!routeReusable) await teardownBridgeRoute();
      // 路由快照(§5.1,v4.9.3 方向 A):bridgeEnabled && ap>0 → "bridge" —— 纯 AirPlay
      // 组也强制走桥(组内对齐;spin 成员有无不再作为路由条件,prepare 失败仍按 MAJ-07
      // 逐设备回落 solo cast);
      // 否则(无 AP 成员 / 桥禁用)"legacy-cast"(flag=0 时与旧行为逐字节同路径)。
      const bridgeRoute = apOnline.length > 0 ? await prepareBridgeRoute(apOnline, routeReusable ? prevRoute : undefined) : null;
      const jobs: Array<Promise<{ mediaUri: string }>> = [];
      // v4.9.3 方向 A:纯 AirPlay 桥组(sp=0 且桥路由已备)也必须起组泵 —— 泵是桥的
      // 唯一 PCM 源,不起泵桥恒静默;members 空数组由 sendspin/protocolPlayer 放行
      // (带 bridge 规格时不再抛「无在线 sendspin 成员」)。
      if (spinOnline.length > 0 || bridgeRoute) {
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
      if (!ok) {
        // 修法(洞 D1):全成员 cast 失败 ⇒ 本组没有可用出流,必须**立刻回收桥路由**。
        // 登记(上面的 activeBridgeRoutes.set)刻意保留在 allSettled 之前 —— 那是为了
        // 保护起播窗口(对账恰好跑在起播过程中时,不能把正在建立的桥当孤儿摘掉)。
        // 但失败分支若不回收,60s 对账就以「已登记」为事实源永远认为它合法,
        // 设备被 owner=bridge 永久占用(native cast 被互斥拒 ⇒ 无声 / 音量失效 / 只能重启)。
        // ⚠️ 回收本身失败只 warn,**绝不能吞掉原始错误**(原始错误才是主错误)。
        try {
          await teardownBridgeRoute();
        } catch (e) {
          log.warn(
            `[group][cast] ${groupId}: 全成员失败后回收桥路由异常(忽略,继续抛原始错误): ${(e as Error)?.message || e}`,
          );
        }
        throw new Error(`组 ${groupId} 全部成员 cast 失败`);
      }
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
        // 桥占用(混合组或纯 AP 桥组,v4.9.3 方向 A;桥的 PCM 源即组泵)时,状态从共享组泵派生。
        if (isBridgeOwned(leader.id)) {
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
    const st = await sendspinGroupPoll(gname).catch(() => ({ playing: false, paused: false, positionMs: 0, durationMs: 0, buffering: false }));
    const front = getSendspinFront();
    const gv = front?.groups.get(gname) as any;
    return {
      state: st.paused ? "PAUSED" : st.playing ? ((st as any).buffering ? "BUFFERING" : "PLAYING") : "STOPPED",
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
    if (isBridgeOwned(leader.id)) {
      const { sendspinGroupPoll } = await import("../sendspin/index.js");
      const gname = sendspinGroupName(groupId);
      const gst = await sendspinGroupPoll(gname).catch(() => ({ playing: false, paused: false, positionMs: 0, durationMs: 0, buffering: false }));
      return {
        state: gst.paused ? "PAUSED" : gst.playing ? ((gst as any).buffering ? "BUFFERING" : "PLAYING") : "STOPPED",
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

// ---- 改法4:桥路由对账(检测+摘除+warn,60s 周期;第一版不做 rebuild 重建)----
// 事实源 = activeBridgeRoutes(主进程路由登记)。两侧现状:sendspin 泵侧句柄
// (sendspinBridgeStatus)/ airplay 会话侧(bridgeStatus)。登记里没有而侧上有 →
// 单侧孤儿(历史来源:摘除吞错拆 sock、空组回收不清桥、fork 组停不清桥)。
// 宽限:孤儿连续两轮(≥60s 间隔)仍在才摘 —— 避开 bridgePrepare 成功→route.push
// 之间、rebuildBridgeRoutes 重锚定中的瞬态窗口。rebuild 触发条件另行评审,本版只摘不建。
let bridgeReconcilerTimer: NodeJS.Timeout | null = null;
/** 孤儿首见时刻(key → ms epoch):连续两轮仍在才动手。 */
const bridgeOrphanFirstSeen = new Map<string, number>();
/** 宽限窗(ms):略小于一个对账周期,保证第二轮必过线。 */
const BRIDGE_RECONCILE_GRACE_MS = 55_000;

/** 幂等启动对账定时器(60s 周期)。AP2 降级看门狗(5s)一并拉起 —— 两者共用
 *  同一个启动点(index.ts 走这里),不新增启动顺序依赖。 */
export function startBridgeRouteReconciler(intervalMs = 60_000): void {
  startBridgeDegradeWatchdog();
  if (bridgeReconcilerTimer !== null) return;
  bridgeReconcilerTimer = setInterval(() => { void reconcileBridgeRoutesOnce(); }, intervalMs);
  bridgeReconcilerTimer.unref?.();
}

export function stopBridgeRouteReconciler(): void {
  stopBridgeDegradeWatchdog();
  if (bridgeReconcilerTimer !== null) {
    clearInterval(bridgeReconcilerTimer);
    bridgeReconcilerTimer = null;
  }
}

/** 测试复位(定时器 + 孤儿首见表 + 路由表)。 */
export function resetBridgeRouteReconcilerForTest(): void {
  stopBridgeRouteReconciler();
  bridgeOrphanFirstSeen.clear();
  activeBridgeRoutes.clear();
}

/** 测试注入:直接设定活跃桥路由(仅 *.test.ts;生产路由由 playMedia/bridgeJoinMember 维护)。 */
export function setBridgeRoutesForTest(routes: Map<string, BridgeSocketSpec[]>): void {
  activeBridgeRoutes.clear();
  for (const [k, v] of routes) activeBridgeRoutes.set(k, [...v]);
}

/** 单轮对账:两侧现状 vs 路由登记,超宽限的孤儿逐侧摘除 + warn。全程 best-effort。 */
export async function reconcileBridgeRoutesOnce(): Promise<void> {
  try {
    const wantedDevices = new Set<string>();
    const wantedTokens = new Set<string>();
    for (const specs of activeBridgeRoutes.values()) {
      for (const s of specs) {
        wantedDevices.add(s.deviceId);
        wantedTokens.add(`${s.deviceId}:${s.token}`);
      }
    }
    const now = Date.now();
    const { sendspinBridgeStatus, sendspinBridgeDetach } = await import("../sendspin/index.js");
    // 侧 1:sendspin 泵侧句柄(以 deviceId 对账)
    let spin: Array<{ group: string; deviceId: string }> = [];
    try { spin = await sendspinBridgeStatus(); } catch { spin = []; }
    const seenSpin = new Set<string>();
    for (const b of spin) {
      const key = `spin:${b.group}:${b.deviceId}`;
      if (wantedDevices.has(b.deviceId)) { bridgeOrphanFirstSeen.delete(key); continue; }
      seenSpin.add(key);
      if (!reapOrphan(key, now)) continue;
      const ok = await sendspinBridgeDetach(b.group, b.deviceId).catch(() => false);
      log.warn(`[group][bridge] 对账摘除孤儿句柄: side=sendspin group=${b.group} device=${b.deviceId} detached=${ok}(路由登记无此设备)`);
    }
    for (const k of [...bridgeOrphanFirstSeen.keys()]) {
      if (k.startsWith("spin:") && !seenSpin.has(k)) bridgeOrphanFirstSeen.delete(k);
    }
    // 侧 2:airplay 会话侧(以 deviceId:token 对账 —— 同设备换 token 的旧会话也算孤儿)
    const { airplaySupervisor } = await import("../airplay/supervisor.js");
    if (airplaySupervisor.isRunning()) {
      type AirSess = { deviceId: string; token: string };
      let sessions: AirSess[] = [];
      try { sessions = await airplaySupervisor.rpc<AirSess[]>("bridgeStatus"); } catch { sessions = []; }
      const seenAir = new Set<string>();
      for (const s of sessions) {
        const key = `air:${s.deviceId}:${s.token}`;
        if (wantedTokens.has(`${s.deviceId}:${s.token}`)) { bridgeOrphanFirstSeen.delete(key); continue; }
        seenAir.add(key);
        if (!reapOrphan(key, now)) continue;
        await bridgeStopDevice(s.token, s.deviceId).catch(() => { /* 摘会话失败下轮重试 */ });
        log.warn(`[group][bridge] 对账摘除孤儿会话: side=airplay device=${s.deviceId} token=${s.token}(路由登记无此 token)`);
      }
      for (const k of [...bridgeOrphanFirstSeen.keys()]) {
        if (k.startsWith("air:") && !seenAir.has(k)) bridgeOrphanFirstSeen.delete(k);
      }
    }
  } catch (e) {
    log.warn(`[group][bridge] 对账轮失败(下轮重试): ${(e as Error)?.message || e}`);
  }
}

/** 宽限判定:首见登记;满宽限(连续两轮仍在)返回 true 并清除登记。 */
function reapOrphan(key: string, now: number): boolean {
  const t0 = bridgeOrphanFirstSeen.get(key);
  if (t0 === undefined) {
    bridgeOrphanFirstSeen.set(key, now);
    return false;
  }
  if (now - t0 < BRIDGE_RECONCILE_GRACE_MS) return false;
  bridgeOrphanFirstSeen.delete(key);
  return true;
}
