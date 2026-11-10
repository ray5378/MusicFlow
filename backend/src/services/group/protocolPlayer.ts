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
import { createAirPlayPlayerForDevice } from "../airplay/protocolPlayer.js";
import { getAirPlayStatus, isAirPlayDeviceDisabled, isAirplayBridgeEnabled, isBridgeOwned, hasActiveSession, bridgePrepareDevice, bridgeStopDevice, bridgeManualDevice, selectAirPlayBridgeProtocol } from "../airplay/control.js";
import { bridgeSocketPath } from "../airplay/bridgeChannel.js";
import { raopProbeDevice, retryBridgePrepareWithProbe, isBridgeHandshakeDeviceError } from "../airplay/raopProbe.js";
import { getAirPlayDevice, rescanAirPlayDevices } from "../airplay/discovery.js";
import type { BridgeSocketSpec } from "../sendspin/bridgeAttach.js";
import { getSendspinFront, sendspinGroupBridgeSync } from "../sendspin/index.js";
import { sendspinGroupName } from "../sendspin/playerCore.js";
import { PlaybackState, type PlayerState, type ProtocolPlayer, type QueueItem } from "../player/types.js";
import { createLogger } from "../../utils/logger.js";
import { randomBytes } from "node:crypto";

// ---- Phase 3/5:活跃桥路由(§5.1 路由快照 + §5.5 owner token)----
// groupId → 已成功 bridgePrepare 的设备/token(流内不切路由;seek 重建不重 prepare,
// 自然切歌/新 playMedia 重建路由)。模块级:跨 player 实例共享,流内成员变化
// (bridgeJoinMember/bridgeLeaveMember)与 airplay 子进程重启(rebuildBridgeRoutes)都要读它。
const activeBridgeRoutes = new Map<string, BridgeSocketSpec[]>();

/** deviceId → 最近一次桥建立失败原因（D7：仅该台失败，状态可读、不回落直连）。
 *  成功建立即清除；仅作观测面，播放决策一律以 activeBridgeRoutes 为准。 */
const bridgeUnavailable = new Map<string, { at: number; reason: string }>();

/** 查询某台设备最近一次桥建立失败原因（未失败 = undefined）。 */
export function getBridgeUnavailableReason(deviceId: string): { at: number; reason: string } | undefined {
  return bridgeUnavailable.get(deviceId);
}

/** 生成新的桥会话 token(§5.5 owner token;与 playMedia 路径同一格式)。 */
const newBridgeToken = (): string => randomBytes(12).toString("hex");

/** 单台桥准备的硬顶(ms):冷建 / 暖复用。
 *  离线设备的 `bridgePrepare` 内会先让位同 host DLNA(STOP SOAP)再走 RTSP,
 *  任一步都可能等到网络超时;实测一台离线设备独占约 9s,把整组取源拖后。
 *  正常设备冷建 <1s、暖复用 <300ms,这里只是异常兜底,不参与正常时序。 */
const BRIDGE_PREPARE_COLD_CAP_MS = 2_500;
const BRIDGE_PREPARE_WARM_CAP_MS = 5_000;
/** 负缓存 TTL:一次失败后 30s 内不再对该设备发起握手探测(每首歌只付一次代价)。 */
const BRIDGE_PREPARE_NEGATIVE_TTL_MS = 30_000;
/** 设备类失败后的 TEARDOWN 探测上限(原默认 6s,离线设备会白等到超时)。 */
const BRIDGE_PREPARE_PROBE_CAP_MS = 1_500;

/** Promise 硬顶:超时 reject(调用方按失败处理)。定时器 unref,不阻止进程退出。 */
function capPromise<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge-prepare-timeout(${label}, ${ms}ms)`)), ms);
    timer.unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 该组当前是否走桥接路由(§5.2 流内成员变化的路由判定依据)。 */
export function isBridgeRouteActive(groupId: string): boolean {
  return (activeBridgeRoutes.get(groupId)?.length ?? 0) > 0;
}

/** 该 AirPlay 设备当前挂在哪个**群组**的桥路由上(没有 → null)。
 *
 *  用途:成员级 `/v1/peers/airplay:<dev>/status` 的状态派生。桥播放时音频来自
 *  群组泵(`ug:<gid>`),主进程 AirPlay 会话表里没有这台设备的会话 —— 只能按
 *  路由反查组名再从泵取状态(单机桥另有 soloBridgeRoutes,由 airplay 侧先查)。 */
export function groupIdOfBridgeMember(deviceId: string): string | null {
  for (const [gid, route] of activeBridgeRoutes) {
    if (route.some((r) => r.deviceId === deviceId)) return gid;
  }
  return null;
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
  // D7：桥降级**不回落 solo cast**——清干净桥/owner 后，本设备标记为「本曲不可用」，
  // 下一首起播重新走桥（prepare 成功即自动恢复）。
  bridgeUnavailable.set(deviceId, { at: Date.now(), reason: `bridge-degraded: ${reason}` });
  log.warn(`[group][bridge] ${groupId}: 链路断 → 摘桥 device=${deviceId} reason=${reason}(D7:本曲不播放,下曲重新建桥)`);
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

/** F1 容错窗上限:stale 超过此时长 = 真离线(起播剔除,不拖慢)。 */
export const AIRPLAY_STALE_TOLERANT_MS = 10 * 60 * 1000;

/** F1(2026-10-28):组 airplay 成员在线判定(stale 容错版,playMedia 起播专用)。
 *  背景(240 实证):MUZO/HiVi 类接收端空闲期停止应答 mDNS,90s staleness
 *  (discovery 读时判定)会把刚离手几分钟的设备错标 offline → getOnlineAirplayIds
 *  剔除 → prepareBridgeRoute 静默返回 null(群组 play 11ms 完成、零桥日志)。
 *  - 组含 airplay 成员但 strict 判定全部离线 ⇒ 先快速刷新一次(rescanAirPlayDevices(300))再判;
 *  - 仍不可用但 lastSeen < AIRPLAY_STALE_TOLERANT_MS ⇒ 容错按在线进桥
 *    (桥 prepare 的握手预算兜底,失败按 MAJ-07 逐设备回落 solo);
 *  - F4:桥 owner(isBridgeOwned)或有活跃投屏会话的设备豁免 staleness(会话在播 = 在线事实);
 *  - lastSeen ≥ 10min(真离线,如长期下线成员)⇒ 照旧剔除,不拖慢起播。 */
export async function getOnlineAirplayIdsTolerant(groupId: string): Promise<string[]> {
  const ids = splitGroupMembers(groupId).airplay;
  if (ids.length === 0) return [];
  const strictOnline = (): string[] =>
    ids.filter((id) => !isAirPlayDeviceDisabled(id) && getAirPlayStatus(id).available);
  let online = strictOnline();
  if (online.length === 0) {
    // 全部 strict 离线:快速刷新一次(≤300ms 窗),给「空闲静默但仍在网」的设备一次应答机会。
    await rescanAirPlayDevices(300);
    online = strictOnline();
  }
  const now = Date.now();
  return ids.filter((id) => {
    if (online.includes(id)) return true;
    if (isAirPlayDeviceDisabled(id)) return false;
    if (isBridgeOwned(id) || hasActiveSession(id)) return true; // F4 豁免
    const dev = getAirPlayDevice(id);
    if (!dev) return false;
    return now - dev.lastSeen < AIRPLAY_STALE_TOLERANT_MS;
  });
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
    // 桥开关开时，apIds 恒为空（音乐成员全部由组泵/桥承担）；此处仅为 setVolume 的
    // 桥占用成员与 `MUSICFLOW_AIRPLAY_BRIDGE=0` 回滚路径保留扇出。
    const players = [...dlnaIds.map(d => createDlnaProtocolPlayer(d)), ...apIds.map(d => createAirPlayPlayerForDevice(d))];
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

  /** 桥准备失败的负缓存(key=deviceId):离线/不可达设备在 TTL 内不再重复握手探测。
   *  起因(2026-11-04 240 实测):组内一台离线 AP 设备,每首歌起播前都串行等它
   *  让位 DLNA + 握手重试,累计约 9s,把泵的取源整体拖后 → 桥缓冲耗尽断音 5.8s。 */
  const bridgeProbeNegative = new Map<string, { until: number; reason: string }>();

  /** 准备桥路由:逐设备生成 token → bridgePrepare(§4.1 顺序 ①)。
   *  单设备失败(MAJ-07)→ 记入 fallback,该设备本流回落 solo cast;
   *  全部失败 → 返回 null(整组退回 legacy 路由,与 flag=0 同行为)。
   *  返回:成功规格数组 + 需回落 solo cast 的设备列表。
   *  S1(v4.10.x):握手阶段设备类失败(ECONNRESET 等,容器重建后 MUZO 固件保留
   *  半开会话的典型症状)先走「TEARDOWN 探测 + 1.5s/5s 退避重试」救回,救不回才
   *  回落 solo cast —— 现场验证过 stop→10s→play 一次成功,把该人工步骤自动化。 */
  async function prepareBridgeRoute(
    apOnline: string[],
    /** B 方案暖复用:上一条路由的 specs —— 同设备同协议沿用旧 token ⇒ 子进程暖复用会话。 */
    reuse?: BridgeSocketSpec[],
  ): Promise<{ sockets: BridgeSocketSpec[]; failed: string[] } | null> {
    if (!isAirplayBridgeEnabled() || apOnline.length === 0) return null;
    // v4.9.3(§音量语义):桥会话初始音量 = player_groups 落库值(用户裁定:流转/起播
    // 绝不采用成员设备自身音量);随 bridgePrepare 下发,子进程不碰 DB。
    const groupInitialVolume = getGroupManager().getVolume(groupId);
    const sockets: BridgeSocketSpec[] = [];
    const failed: string[] = [];
    // ★ 2026-11-04 P1:逐设备**并发**准备。串行时容器重启后两台设备各自命中
    //   「ECONNRESET → TEARDOWN 探测 → 退避 → 重试成功」,退避时间叠加 ⇒
    //   resume 补建桥路由 11.9s,请求到出声约 17s。设备之间不共享会话/settle,
    //   并发安全;总耗时从 sum 降为 max。
    type PrepareOne = { deviceId: string; spec?: BridgeSocketSpec };
    const prepared = await Promise.all(apOnline.map(async (d): Promise<PrepareOne> => {
      // 协议先选(B 方案:暖复用判据含协议一致 ⇒ token 沿用与否取决于协议)。
      const protocol = selectAirPlayBridgeProtocol(d);
      const prevSpec = reuse?.find((r) => r.deviceId === d && r.protocol === protocol);
      // 负缓存命中(且无暖会话可复用):上一首歌已确认这台不可达,30s 内直接判失败,
      // 不再为它付握手/探测的网络超时代价 —— 这是「离线成员拖住整组起播」的根治点。
      const neg = bridgeProbeNegative.get(d);
      if (!prevSpec && neg && neg.until > Date.now()) {
        const reason = `bridge-skip(负缓存): ${neg.reason}`;
        bridgeUnavailable.set(d, { at: Date.now(), reason });
        log.info(`[bridge-prepare] skip device=${d} 负缓存命中(剩余 ${Math.round((neg.until - Date.now()) / 1000)}s): ${neg.reason}`);
        return { deviceId: d };
      }
      // 同设备同协议沿用旧 token ⇒ 子进程暖复用会话(RAOP 握手零重来);否则新 token(冷启语义)。
      const token = prevSpec ? prevSpec.token : randomBytes(12).toString("hex");
      const attempt = (): Promise<{ listening: true; socketPath: string }> => {
        // socketPath 在主进程按同一实现计算(bridgeSocketPath,<100B 断言在此抛)。
        bridgeSocketPath(d, token);
        // v4.9.4:settle 只在冷建(新 token)时做;warm 复用(同 token 哑会话)不等待 ——
        // 快路径,DLNA 早已让位(本组上一首即在播)。
        return bridgePrepareDevice(d, token, protocol, groupId, { initialVolume: groupInitialVolume, settleDlna: !prevSpec });
      };
      const capMs = prevSpec ? BRIDGE_PREPARE_WARM_CAP_MS : BRIDGE_PREPARE_COLD_CAP_MS;
      try {
        await capPromise(attempt(), capMs, `device=${d}`);
        bridgeProbeNegative.delete(d);
        return { deviceId: d, spec: { deviceId: d, socketPath: bridgeSocketPath(d, token), token, protocol } };
      } catch (e) {
        const reason = (e as Error)?.message || String(e);
        // 硬顶超时不取消底层握手:迟到成功的会话不在路由表里,必须主动收掉,
        // 否则子进程会留一条没人消费的桥会话(泄漏 socket / 抢设备音频通道)。
        if (reason.startsWith("bridge-prepare-timeout")) {
          void bridgeStopDevice(token, d).catch(() => {});
        }
        // S1:仅握手阶段设备类失败值得重试(AP2 凭据缺失等语义错误重试必复现)。
        if (isBridgeHandshakeDeviceError(reason)) {
          const recovered = await retryBridgePrepareWithProbe({
            reason,
            // 探测本身也压到 1.5s:默认 6s 对离线设备纯属白等。
            probe: () => raopProbeDevice(d, BRIDGE_PREPARE_PROBE_CAP_MS),
            attempt: () => capPromise(attempt(), BRIDGE_PREPARE_COLD_CAP_MS, `retry device=${d}`),
            onRetry: (n, probe) => log.info(`[bridge-prepare] retry#${n} device=${d} probe=${probe.reachable ? "ok" : "unreachable"}(options=${probe.optionsStatus ?? "-"} teardown=${probe.teardownStatus ?? "-"}) reason=${reason}`),
            onGiveUp: (n, probe) => log.warn(`[bridge-prepare] retry#${n} device=${d} probe 不可达(${probe.detail}) → 放弃重试,本流回落 solo cast`),
            onFail: (n, err) => log.warn(`[bridge-prepare] retry#${n} 仍失败 device=${d}: ${(err as Error)?.message || err}`),
            onRecovered: (n) => log.info(`[bridge-prepare] retry#${n} 成功 device=${d},桥会话已建立`),
          });
          if (recovered) {
            bridgeProbeNegative.delete(d);
            return { deviceId: d, spec: { deviceId: d, socketPath: bridgeSocketPath(d, token), token, protocol } };
          }
        }
        // D7：重试后仍失败 ⇒ 仅该台本次不播放并留可读原因；不再回落 solo cast。
        bridgeUnavailable.set(d, { at: Date.now(), reason });
        // 失败进负缓存:后续 30s 内的起播不再为这台付网络超时(成功/暖复用会清掉)。
        bridgeProbeNegative.set(d, { until: Date.now() + BRIDGE_PREPARE_NEGATIVE_TTL_MS, reason });
        log.warn(`[group][bridge] ${groupId}: bridgePrepare 失败 device=${d} → 本曲该设备不播放(D7): ${reason}`);
        return { deviceId: d };
      }
    }));
    for (const r of prepared) {
      if (r.spec) sockets.push(r.spec);
      else failed.push(r.deviceId);
    }
    for (const s of sockets) bridgeUnavailable.delete(s.deviceId);
    if (sockets.length === 0) return null;
    return { sockets, failed };
  }

  /** R1 方案 A(2026-10-30):resume 前补建桥路由 —— 专治「容器重启后再点播放,
      泵只推 WS、桥成员全程静默,必须切歌才出声」。
     判据:桥开关开 && 组内有在线 AirPlay 成员 && 本组不在 activeBridgeRoutes
     (重启后 Map 空 / 桥崩溃后已摘)。命中则冷建路由(新 token)+ 登记 + 用
     bridgeSync 给泵补挂句柄(泵此刻仍暂停,resume 后按表推送)。
     返回是否补建成功。路由还在时零开销。 */
  async function ensureBridgeRouteOnResume(): Promise<boolean> {
    if (!isAirplayBridgeEnabled()) return false;
    if (activeBridgeRoutes.has(groupId)) return false; // 桥还在 = 正常 resume,不碰
    const apOnline = await getOnlineAirplayIdsTolerant(groupId);
    if (apOnline.length === 0) return false;
    const t0 = Date.now();
    const prepared = await prepareBridgeRoute(apOnline);
    if (!prepared) {
      log.warn(`[group][bridge] ${groupId}: resume 补建桥路由失败(全部设备 prepare 失败)→ AirPlay 成员本曲静默`);
      return false;
    }
    activeBridgeRoutes.set(groupId, prepared.sockets);
    // 泵侧补挂:此刻泵多为暂停/刚起状态,bridgeSync 只登记句柄;resume 后按表推流。
    let synced = 0;
    let confirmed = false;
    try {
      const r = await sendspinGroupBridgeSync(sendspinGroupName(groupId), prepared.sockets);
      synced = r.synced;
      confirmed = r.confirmed;
    } catch (e) {
      log.warn(`[group][bridge] ${groupId}: resume 补挂泵句柄异常: ${(e as Error)?.message || e}`);
    }
    log.info(`[group][bridge] ${groupId}: resume 补建桥路由 ${prepared.sockets.length} 台`
      + `(synced=${synced} confirmed=${confirmed}) ${Date.now() - t0}ms`
      + (prepared.failed.length > 0 ? ` ⚠️ ${prepared.failed.length} 台 prepare 失败(D7 本曲不播放):${prepared.failed.join(",")}` : ""));
    return true;
  }

  return {
    playerId,
    async playMedia(
      item: QueueItem,
      baseUrl: string,
      _startMs = 0,
      _bridge?: unknown,
      opts?: { manual?: boolean },
    ) {
      const dlnaOnline = getOnlineMemberIds(groupId);
      const apOnline = await getOnlineAirplayIdsTolerant(groupId);
      const spinOnline = getOnlineSendspinIds(groupId);
      // F2:路由决策单行日志(格式由 check-group-invariants 钉住;ageMs 供 staleness 误判追查)。
      log.info(`[group][route] ${groupId} dlna=${dlnaOnline.length} spin=${spinOnline.length} ap=${apOnline.length} apDetail=${JSON.stringify(splitGroupMembers(groupId).airplay.map((id) => {
        const dev = getAirPlayDevice(id);
        return { id, ageMs: dev ? Date.now() - dev.lastSeen : null, online: apOnline.includes(id) };
      }))}`);
      if (dlnaOnline.length === 0 && apOnline.length === 0 && spinOnline.length === 0) {
        throw new Error(`组 ${groupId} 无在线成员,无法播放`);
      }
      // B 方案(对齐 MA warm reuse):上一条桥路由与当前在线 AirPlay 成员**同集合且
      // 协议一致** ⇒ 复用 token 且不拆会话 —— 桥子进程按「同 token 同协议」暖复用
      // (RAOP 握手/设备缓冲零重来),新曲由 BOUNDARY(track) 驱动重锚(与 seek 同路径);
      // 句柄热复用见 bridgeAttach.syncGroupBridges。成员/协议变化 ⇒ 冷启(拆旧建新)。
      const prevRoute = activeBridgeRoutes.get(groupId);
      // 逐设备复用(修 2026-11-03):此前按「在线集合必须与上一条路由**完全一致**」整条判 ——
      // 只要组里有一台 AirPlay 离线/prepare 失败(D7:240 实测 GGMM ECONNREFUSED),
      // prevRoute 就比 apOnline 少一条 ⇒ **每首歌**整组冷拆重握手 ⇒ 换歌处旧桥会话
      // closed、新端口首包才出声(抓包实测 RTP 空洞 2220ms)。
      // 改为逐设备:仍在线的旧 spec 沿用同 token ⇒ 子进程暖复用(RAOP 握手零重来,
      // 见 bridgeSession.prepare 的同 token 分支);只有「已不在线 / 协议变了」的才停旧会话,
      // 新出现的设备才走冷建。集合差异只影响差异项本身,不牵连其它成员。
      const reuseSpecs = (prevRoute ?? []).filter(
        (r) => apOnline.includes(r.deviceId) && r.protocol === selectAirPlayBridgeProtocol(r.deviceId),
      );
      const droppedSpecs = (prevRoute ?? []).filter((r) => !reuseSpecs.includes(r));
      if (droppedSpecs.length > 0) {
        log.info(`[group][bridge] ${groupId}: 逐设备复用 ${reuseSpecs.length} 台、停旧 ${droppedSpecs.length} 台`
          + `(${droppedSpecs.map((r) => r.deviceId).join(",")})`);
        await Promise.allSettled(droppedSpecs.map((r) => bridgeStopDevice(r.token, r.deviceId)));
      }
      // 路由快照(§5.1,v4.9.3 方向 A):bridgeEnabled && ap>0 → "bridge" —— 纯 AirPlay
      // 组也强制走桥(组内对齐;spin 成员有无不再作为路由条件,prepare 失败仍按 MAJ-07
      // 逐设备回落 solo cast);
      // 否则(无 AP 成员 / 桥禁用)"legacy-cast"(flag=0 时与旧行为逐字节同路径)。
      const bridgeRoute = apOnline.length > 0 ? await prepareBridgeRoute(apOnline, reuseSpecs) : null;
      // 全失败(整组退回 legacy)→ 旧会话必须回收,否则 owner=bridge 悬挂(D1 同款)。
      if (!bridgeRoute && prevRoute) await teardownBridgeRoute();
      // D6/P1:用户手动 next/prev ⇒ 给**复用中的**桥路由打 sticky「手动」标记;
      // 子进程在下一个 track boundary 执行恰 1 次 FLUSH + ts 回拨。冷建路由没有
      // 旧轨道边界可消费,不打标记。
      if (opts?.manual === true && reuseSpecs.length > 0) {
        await Promise.allSettled(reuseSpecs.map((r) => bridgeManualDevice(r.token)));
      }
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
            // S1:下一首预取提示原样透传(桥边界连续性靠泵侧预解码,见 streamEngine)。
            opts,
          );
        })());
      }
      for (const d of dlnaOnline) jobs.push(createDlnaProtocolPlayer(d).playMedia(item, baseUrl));
      // D2/D7：桥开关开时，任何 AirPlay 成员都不允许 solo cast —— prepare 失败者
      // 仅该台本次不播放（原因记入 bridgeUnavailable），由调用方/状态面给出可读错误。
      // `MUSICFLOW_AIRPLAY_BRIDGE=0` 时 bridgeRoute 必为 null，走原有 legacy 扇出（整体回滚）。
      const apSolo = isAirplayBridgeEnabled() ? [] : apOnline;
      if (bridgeRoute) activeBridgeRoutes.set(groupId, bridgeRoute.sockets);
      if (isAirplayBridgeEnabled() && apOnline.length > 0) {
        const failedDevices = bridgeRoute ? bridgeRoute.failed : apOnline;
        if (failedDevices.length > 0) {
          log.warn(`[group][bridge] ${groupId}: ${failedDevices.length} 台 AirPlay 桥不可用，本曲不播放(D7): ${failedDevices.join(",")}`);
        }
      }
      for (const d of apSolo) jobs.push(createAirPlayPlayerForDevice(d).playMedia(item, baseUrl));
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
    async resume() {
      // R1(2026-10-30 容器重启后续播无声):activeBridgeRoutes 是进程内 Map,重启后为空;
      // resume() 语义假设「桥路由还活着」⇒ 只 fanOut DLNA + 组泵,AirPlay 桥无人重建 ⇒
      // 泵只推 WS 客户端,桥成员全程静默,必须切歌(走 cast 路径)才恢复。
      // 这里在 resume 前补建桥路由并给泵补挂句柄(方案 A);路由还在时零开销直接返回。
      await ensureBridgeRouteOnResume();
      await fanOut("resume", p => p.resume());
      await spinOp(p => p.resume());
    },
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
        // D2：桥开关开时，组内 AirPlay leader 的状态一律从共享组泵派生 —— 不再从
        // solo 会话视图取（桥占用下该视图恒空，会误判自然结束）。
        if (isAirplayBridgeEnabled() || isBridgeOwned(leader.id)) {
          const { createSendspinGroupPlayer } = await import("../sendspin/protocolPlayer.js");
          const s = await createSendspinGroupPlayer(groupId).pollState();
          return { ...s, playerId };
        }
        // `MUSICFLOW_AIRPLAY_BRIDGE=0` 回滚：airplay leader 从设备独立会话态派生。
        const s = await createAirPlayPlayerForDevice(leader.id).pollState();
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

/** 群组 status 的 media 元数据兜底(2026-10-28 真机:流转后首曲偶发 title/cover 缺失)。
 *  根因:泵侧起播(streamEngine.play)把**上一首**的 title/artist/album/coverArt 继承给新
 *  current;上一首为空或恰好换曲时,新 current 只剩 songId+durationMs(子进程拿不到队列,
 *  无从补)。故在主进程 status 出口按 songId 从组队列回填 —— 命中即补缺字段,找不到原样返回。 */
async function enrichGroupCurrentMedia(groupId: string, media: any): Promise<any> {
  if (!media || typeof media.songId !== "string") return media;
  if (media.title && media.coverArt) return media;
  try {
    // 动态 import 与文件内其它队列访问同款(避免 group↔player 静态环)。
    const { getQueueController } = await import("../player/index.js");
    const snap = getQueueController().snapshot(`group:${groupId}`);
    const item = (snap?.items ?? []).find((it: any) => it?.songId === media.songId);
    if (!item) return media;
    return {
      ...media,
      title: media.title ?? item.title,
      artist: media.artist ?? item.artist,
      album: media.album ?? item.album,
      coverArt: media.coverArt ?? item.coverArt,
    };
  } catch { return media; }
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
      media: await enrichGroupCurrentMedia(groupId, gv?.current),
      updatedAt: Date.now(),
    };
  }
  if (leader.kind === "airplay") {
    // §5.5 同 pollState:桥占用时 solo 会话视图恒空,必须改从共享组泵派生
    // (否则 /v1/peers/group:<id>/status 在桥播放全程恒报 STOPPED)。
    // D2:与 pollState 同名分支同一口径 —— 桥开关开时,组内 AirPlay leader 一律从
    // 共享组泵派生(不只是 isBridgeOwned);solo 会话映射只属于 `MUSICFLOW_AIRPLAY_BRIDGE=0`
    // 回滚专线。少这一条时纯 AP 组 / 桥已建但尚未登记 owner 的瞬间会回落到设备会话,
    // 位置/状态与组时间线不一致(测试「airplay solo leader(桥开关开后)→ 从组泵派生」)。
    if (isAirplayBridgeEnabled() || isBridgeOwned(leader.id)) {
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
    // 事实源补全(2026-11-01 单会话断裂根因):单机伪组(`__bridge_solo:<deviceId>`)
    // 的桥路由登记在 airplay/protocolPlayer 的 soloBridgeRoutes,**不**进本文件这张
    // activeBridgeRoutes(后者只覆盖用户组)。不并入 ⇒ 单机桥在 sendspin 句柄侧与
    // airplay 会话侧都被判「孤儿」,宽限后每 ~60s 摘一次**正在播**的会话:
    // 实测 17:16:17 摘句柄 → bridge link live→idle → session 断开 reason=closed →
    // 泵空转「编码器疑似失效」,并让 QueueController 判 idle_early 切歌。
    try {
      const { listSoloBridgeRoutes } = await import("../airplay/protocolPlayer.js");
      for (const s of listSoloBridgeRoutes()) {
        wantedDevices.add(s.deviceId);
        wantedTokens.add(`${s.deviceId}:${s.token}`);
      }
    } catch { /* 桥整体关闭/模块不可用 → 沿用原判据,不放大故障 */ }
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
