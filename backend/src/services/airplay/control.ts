// AirPlay (RAOP) cast/control service.
//
// Orchestrates the two halves of AirPlay playback:
//   - transport: services/airplay/raop.ts — RTSP handshake + encrypted RTP push
//   - audio:     ffmpeg decodes the track URL → PCM → RAW-ALAC on the fly
//
// The DLNA chain stays completely untouched: we only *read* DLNA's exported
// `createCastSession()` (services/dlna/control.ts) to obtain a token-auth-free
// stream URL (`/rest/dlna/stream/:token`) — the same endpoint DLNA renderers
// already pull from — and feed it to ffmpeg. Nothing in services/dlna/* is
// modified.
import { type ChildProcessWithoutNullStreams } from "child_process";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { PlaybackState } from "../player/types.js";
import { RaopPlayer, type RaopSession, type RaopRealtimeStats } from "./raop.js";
import { makeProducer, spawnDecoder, degreesToDb, killDecoder } from "./decoder.js";
import { isAirPlayForkMode } from "./mode.js";
import { airplaySupervisor } from "./supervisor.js";
import { rpcFireAndForget } from "../rendererHost/front.js";
import { getAirPlayDevice, getAirPlayDevices, onAirPlayEvent, startAirPlayDiscovery, stopAirPlayDiscovery, setAirPlayPersist, removeAirPlayDevice, type AirPlayDevice } from "./discovery.js";
import { getBridgeAvShiftUs } from "./bridgeCalib.js";
import { getEffectiveBaseUrl, getCachedDevices, setDeviceVolume, setDeviceMute, stopDevicePlayback, loopbackBase } from "../dlna/control.js";
import { sqlite } from "../../db/index.js";
import { createAirPlaySession } from "./session.js";
import type { AirplaySessionEndInfo } from "./sessionRuntime.js";
import { createLogger } from "../../utils/logger.js";
import { getAirPlayVolumeState, saveAirPlayVolumeState, deleteAirPlayVolumeState, DEFAULT_AIRPLAY_VOLUME } from "./deviceState.js";
import { bridgeSocketPath } from "./bridgeChannel.js";
import type { BridgeProtocol } from "./rates.js";
import { AP2_PAIR_TIMEOUT_MS } from "./rates.js";
import { getSetting, setSetting } from "../settings.js";
import { getHapCredentials } from "./ap2/hapCredentials.js";
import { recordPairSetupSuccess } from "./ap2/pairingContract.js";
import { pairNewDevice, type HapCredsHex } from "./ap2/ap2Session.js";

// 解码/缓冲层(ffmpeg spawn + 有界 PCM 队列 + 音量 dB 换算)已抽到 ./decoder.ts ——
// airplay 子进程要复用同一份实现,但不能经由本模块(会拖进 DB/DLNA/peer 等主进程态)。
// re-export 保持既有引用可见(tests/services/airplayProducer.test.ts 从本模块导入)。
export { makeProducer } from "./decoder.js";
// killDecoder 同样从本模块透出(便于编排层测试与外部收尾路径共用同一份强杀逻辑)。
export { killDecoder };

const log = createLogger("AIRPLAY");

export interface AirPlayCastOptions {
  deviceId: string;
  songId: string;
  title?: string;
  artist?: string;
  album?: string;
  coverArt?: string;
  durationSec?: number;
  streamUrl?: string; // explicit stream URL (defaults to a fresh token URL)
  baseUrl?: string;   // LAN-visible origin for the stream URL
  seekSec?: number;   // start at this offset
}

export interface AirPlayDeviceStatus {
  available: boolean;
  name: string;
  playbackState: PlaybackState;
  position: number;   // seconds
  duration: number;   // seconds
  title?: string;
  artist?: string;
  album?: string;
  volume: number;     // 0-100
  muted: boolean;
  supportsRsa: boolean;
  updatedAt: number;
  /** 推流节拍健康度(可观测指标):`reanchors` 越大 / `maxGapMs` 越接近或超过 ~8ms,
   *  说明推流节拍正被事件循环拖累。无活跃推流时缺省不返回。 */
  stream?: RaopRealtimeStats;
}

interface ActiveSession {
  deviceId: string;
  player: RaopPlayer;
  ffmpeg: ChildProcessWithoutNullStreams;
  session: RaopSession;
  streamPromise?: Promise<unknown>;
  /** Set while an in-place seek swaps the decoder: the old stream's finalizer
   *  must keep the RTSP session + sockets alive instead of tearing down. */
  seekReplace?: boolean;
  title?: string;
  artist?: string;
  album?: string;
  duration: number;
  /** 对外展示/上报用的原始流地址(LAN origin,保持前端可见的 URI 不变)。 */
  streamUrl: string;
  /** 解码器**实际**拉取的地址:本机回环的完整出流管道(见 toLoopbackAirPlayStreamUrl)。 */
  feedUrl: string;
  startedAt: number;
  ended: boolean;
}

// ==================== 进程模型(fork / in-proc) ====================
//
// fork 模式(MUSICFLOW_AIRPLAY_FORK=1)下,推流会话跑在 airplay 子进程里:
//   - 主进程仍持有编排态(volumeState / lastCast / 设备与 peer 注册 / DLNA 互斥);
//   - 真正的推流对象(RaopPlayer / ffmpeg / RTSP 会话)在子进程,主进程读**镜像**;
//   - 命令写一律走 RPC,读状态读镜像(同步,不阻塞调用方)。
// in-proc(默认)下一切照旧 —— 两条路径共用 decoder.ts 与 raop.ts 的同一份实现。
//
// 判活不靠 IPC:镜像里有 sessions 的键集合,`hasActiveSession()` 同步可答。

const sessions = new Map<string, ActiveSession>();
const volumeState = new Map<string, { volume: number; muted: boolean; supportsRsa: boolean }>();

/** 取设备音量状态:**内存优先,缺失时用持久值播种**。
 *
 *  绝不能在这里直接写死缺省 —— 容器重启后 volumeState 为空,直接回 80 会让
 *  客户端把「缺省值」当成权威回推,把设备自身在重启前设好的音量覆盖掉
 *  (2026-10-21 现场:重启后 HiVi 被推成缺省音量)。有持久行就先用持久行,
 *  没有行(从未设置过)才用 DEFAULT_AIRPLAY_VOLUME,与改动前完全一致。 */
/** AirPlay 服务是否在运行(插件启用 = startAirPlayService 已调用)。
 *  停用后保持「内存清空 = 缺省值」的旧语义,不拿库值回填 —— 停用中的设备没有
 *  任何状态出口,回读库只会在插件页制造「关了还显示旧音量」的错觉。
 *  重新启用/容器重启时由 startAirPlayService 置回 true,库值才参与播种。 */
let airPlayServiceActive = false;

function volumeStateOf(deviceId: string, supportsRsa: boolean) {
  const hit = volumeState.get(deviceId);
  if (hit) return hit;
  const saved = airPlayServiceActive ? getAirPlayVolumeState(deviceId) : null;
  const st = {
    volume: saved?.volume ?? DEFAULT_AIRPLAY_VOLUME,
    muted: saved?.muted ?? false,
    supportsRsa,
  };
  volumeState.set(deviceId, st);
  return st;
}
const lastCast = new Map<string, { songId: string; title?: string; artist?: string; album?: string; coverArt?: string; durationSec?: number; streamUrl: string }>();

/**
 * 把 AirPlay 出流地址换成**本机回环**的同一条 URL(只换 origin,路径/token 不动)。
 *
 * 为什么必须回环:解码器输入必须过 SPEC §1.8 合规门(只允许本地路径或回环 URL),
 * 而**不能**走 `resolvePipelineInput` 的 raw 包装 —— 那会把出流退化成 raw 直通,
 * 丢掉整曲内存缓冲与「上游死亡 ⇒ 下游显式错误」契约。2026-10-20 240 现网实测的
 * 两个用户可见症状都由此而来(证据已闭合):
 *   ① 上游 WebDAV 返回 200(不支持 Range)、以干净 EOF 收尾时,ffmpeg exit 0 ⇒
 *      会话在 54s/265s 处报 IDLE ⇒ `idle_early` 放行切歌;
 *   ② 上游以错误收尾时,`-reconnect_streamed 1` 对「无 Content-Length 的 chunked 流」
 *      没有可续接的位置,重连请求恒为 `Range: bytes=0-` ⇒ **从 0 重读** ——
 *      听感就是「播到一半又从头开始」;重连风暴期间 SIGTERM 不生效 ⇒ 每首歌遗留一个
 *      18MB 僵尸解码器(实测容器内累积 12 个)。
 * 走完整管道后:整曲先落 membuf(网络源),或直读本地文件;上游再怎么抖都不影响本首。
 *
 * token 与 host 无关(服务端从 SQLite 解析),故换 origin 是安全的;非
 * `/rest/airplay/stream/` 形态的地址(测试/外部显式传入)原样返回。
 */
export function toLoopbackAirPlayStreamUrl(streamUrl: string): string {
  try {
    const u = new URL(streamUrl);
    if (!u.pathname.startsWith("/rest/airplay/stream/")) return streamUrl;
    return `${loopbackBase()}${u.pathname}${u.search}`;
  } catch {
    return streamUrl;
  }
}

/**
 * 把起播偏移编进**服务端回环流** URL(2026-10-22)。
 *
 * ⚠️ 绝不能让 AirPlay 解码器在 live FLAC 管线上用 `-ss` 做输入定位:
 * 该响应是 chunked、不可寻址的编码流,`-ss` 会落在**帧中间** ——
 * 240 实测同一 token:`-ss 60` 只出 72B 且 `[flac] invalid sync code`,
 * `-ss 200` 为 0B;设备端表现就是「队列/进度都对、但一点声音都没有」,
 * 用户再拖一次进度(重建会话)有时又能响(取决于落点是否恰好对齐帧)。
 *
 * 正确做法:偏移交给 `/rest/airplay/stream/:token?timeOffset=N` 的**服务端管道**,
 * `-ss` 落在可定位的源(本地文件 / WebDAV Range / membuf)上;解码器从 0 开始吃
 * 一条**从一开始就正确**的流。AirPlay 的 seek 重建与起播落位共用这一条。
 */
export function withPlaybackOffset(streamUrl: string, seekSec?: number): string {
  if (seekSec === undefined || !Number.isFinite(seekSec) || seekSec <= 0) return streamUrl;
  try {
    const u = new URL(streamUrl);
    if (!u.pathname.startsWith("/rest/airplay/stream/")) return streamUrl;
    // 保留毫秒精度(流转落点常见 7.702s);服务端 decodeArgs 的 -ss 接受小数。
    u.searchParams.set("timeOffset", String(Math.round(seekSec * 1000) / 1000));
    return u.toString();
  } catch {
    return streamUrl;
  }
}

/**
 * 设备级串行闸(2026-10-21 240 现网「流转 + 拖动进度」卡死根因)。
 *
 * 客户端流转播放与拖动进度的时序是**并发**的:transfer 先 `playFrom`(占住
 * QueueController.advancing),紧接着 seek 走 `transport`(不占 advancing)。
 * 两条链各自对**同一台设备**执行"停旧会话 → 建 RTSP 会话",于是设备端会同时
 * 收到多份 ANNOUNCE/SETUP/RECORD。真机(HiVi H5MKII)的会话表会因此错乱:
 * 后续握手永远等不到 200 → `castToAirPlayDevice` 一直等在 connect 上,
 * QueueController 的 `advancing` 随之被永久占用 ⇒ 用户看到「一直卡在同一首,
 * 点别的歌也没反应」。
 *
 * 正交的 `advancing` 只能串行化"起播"这一条链,管不到 seek/stop/pause;
 * 所以在**会话生命周期**这一层再加一道 per-device 串行闸:同一设备的
 * cast / seek / stop / pause / resume 严格按到达顺序执行,绝不交错。
 *
 * 实现是 promise 链尾追加(`prev.then(fn, fn)`:前一个失败也继续),Map 里始终
 * 只保留"已 settle 的尾",不随操作次数增长。fork 模式同样适用(主进程侧排队,
 * 子进程本就是单线程事件循环)。
 */
const deviceGates = new Map<string, Promise<void>>();
/** 记录「当前异步调用链已持有哪把闸」:同一链内重入必须放行,否则自锁死。
 *  典型重入:seek 持闸执行 prepareSeek → 收尾/测试替身再调 stopAirPlaySession
 *  (同一设备) → 若再排一次队,两者互相等,永久卡住。 */
const gateHeld = new AsyncLocalStorage<ReadonlySet<string>>();

function withDeviceGate<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  if (gateHeld.getStore()?.has(deviceId)) return fn(); // 可重入:同一调用链不再排队
  const prev = deviceGates.get(deviceId) ?? Promise.resolve();
  const queuedAt = Date.now();
  const exec = () => {
    const waited = Date.now() - queuedAt;
    if (waited > 50) log.debug(`[AirPlay][gate] ${deviceId} 排队 ${waited}ms 后开始`);
    const next = new Set(gateHeld.getStore() ?? []);
    next.add(deviceId);
    return gateHeld.run(next, fn);
  };
  const run = prev.then(exec, exec);
  deviceGates.set(deviceId, run.then(() => undefined, () => undefined));
  return run;
}

/** 建会话关键路径上的**清理步骤**硬上限:互斥 DLNA 让位 / 旧会话收尾都是尽力而为,
 *  挂住就必须跳过继续,绝不能把整个 cast 拖到 QueueController 的 30s 硬顶
 *  (2026-10-21 HiVi 现场:每次流转都卡 30s,表现为「流转接续失败」)。 */
const DLNA_YIELD_DEADLINE_MS = 6_000;
/** DLNA 停播后等待设备报 STOPPED 的上限(2026-10-22 同设备切输入)。 */
const DLNA_SETTLE_MAX_MS = 2_500;
/** 报 STOPPED 后再给固件切输入的宽限。 */
const DLNA_SETTLE_GRACE_MS = 300;
/** GetTransportInfo 轮询间隔。 */
const DLNA_SETTLE_POLL_MS = 200;
const STOP_SESSION_DEADLINE_MS = 4_000;

async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  deviceId: string,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`[AirPlay][cast] ${deviceId} ${label} 超过 ${ms}ms 未完成,跳过继续(避免拖死 cast)`);
      resolve(null);
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 该设备是否有活跃推流会话(fork 看子进程镜像的会话表;in-proc 看本地 sessions)。 */
function hasActiveSession(deviceId: string): boolean {
  if (isAirPlayForkMode()) return airplaySupervisor.mirror.sessions.has(deviceId);
  return sessions.has(deviceId);
}

// ==================== Phase 3:桥接路由 flag + session owner(MAJ-06) ====================

/** 桥接路径总开关(§Phase 3):`MUSICFLOW_AIRPLAY_BRIDGE=0` 时整条桥接路径
 *  完全不激活(路由不 prepare、组不挂桥,纯 sendspin 组逐字节同行为)。 */
export function isAirplayBridgeEnabled(): boolean {
  return process.env.MUSICFLOW_AIRPLAY_BRIDGE !== "0";
}

/** 桥会话 owner 登记(deviceId → sessionToken,主进程侧事实)。
 *  语义:owner={kind:"bridge", token} 与 native cast 互斥 —— stop 路径必须跳过
 *  桥占用的设备(MAJ-06,否则 DLNA 互斥等 stop 链路会误杀桥会话),native cast
 *  到桥占用设备直接拒绝。登记点 = bridgePrepareDevice 成功后;清除点 = bridgeStopDevice。 */
const bridgeOwners = new Map<string, { token: string; groupId: string | null }>();

/** 登记桥会话 owner;v4.9.3 起携带归属组 id(null = 无组上下文),供同 host DLNA
 *  互斥区分「活跃组桥会话(豁免,接管语义)」与「孤儿桥会话(可回收)」。 */
export function registerBridgeOwner(deviceId: string, token: string, groupId?: string | null): void {
  bridgeOwners.set(deviceId, { token, groupId: groupId ?? null });
}

/** 桥会话归属组 id(未登记/无组上下文 = null)。 */
export function bridgeOwnerGroupOf(deviceId: string): string | null {
  return bridgeOwners.get(deviceId)?.groupId ?? null;
}

export function clearBridgeOwner(deviceId: string): void {
  bridgeOwners.delete(deviceId);
}

/** 该设备是否被桥会话占用(owner.kind === "bridge")。 */
export function isBridgeOwned(deviceId: string): boolean {
  return bridgeOwners.has(deviceId);
}

/** 主进程编排:对一台 AirPlay 设备做 bridgePrepare(§4.1 顺序 ①)。
 *  生成 socket 路径(sha1 前 11 位 base36,<100B 断言)→ RPC 到 airplay 子进程
 *  (RTSP 握手 + MFAB listener)→ 成功后登记 owner。 */
export async function bridgePrepareDevice(
  deviceId: string,
  token: string,
  protocol: BridgeProtocol,
  /** 所属用户组 id:用于取**按组**的 A/V 延迟补偿(正数=AirPlay更晚出声)。
   *  缺省(null/undefined)= 无组上下文,回落到旧的全局 bridge.avShiftMs。 */
  groupId?: string | null,
  /** v4.9.3(§音量语义):桥会话初始音量(0-100,player_groups 落库值,调用方算好)。
   *  undefined = 无组上下文,桥侧回落设备落库值(旧行为)。 */
  opts?: { initialVolume?: number },
): Promise<{ listening: true; socketPath: string }> {
  const dev = getAirPlayDevice(deviceId);
  if (!dev) throw new Error(`AirPlay 设备不存在: ${deviceId}`);
  const socketPath = bridgeSocketPath(deviceId, token);
  const r = await airplaySupervisor.rpc<{ listening: true; socketPath: string }>("bridgePrepare", {
    deviceId,
    socketPath,
    token,
    protocol,
    host: dev.host,
    port: dev.port,
    pk: (dev as { pk?: string }).pk,
    et: (dev as { et?: string }).et,
    // A/V 标定位移:HiVi 不回报 Audio-Latency ⇒ L_true 不可知,靠该值补齐常量差。
    // **正数 = 内容落点整体后移 = AirPlay 更晚出声;负数 = 更早**。
    // 有组上下文一律取按组值(用户可在播放器里逐组调);无组上下文回落全局旧值。
    // **延迟补偿的唯一落点 = 投递时戳**(sendspin/server.ts 的 ts' = ts − ahead + shift,
    // 按成员协议动态读对应格子)。这里必须恒 0:锚点若也平移,桥内 anchorUs = 投递时戳
    // + 锚点平移 = 双份 shift ⇒ 对齐器把多出的那份判「内容超前」整段裁掉
    // (2026-10-27 双加实锤:切歌被吞 2 秒、净补偿归零)。
    anchorShiftUs: 0,
    // v4.9.3(§音量语义):桥会话初始音量(0-100,player_groups 落库值);子进程不碰 DB。
    initialVolume: opts?.initialVolume,
    // AP2 realtime:建链载荷(controllerId + 已切分凭据)。**只在协议确为 AP2 时下发** ——
    // RAOP 载荷逐字节不变(未配对导致 undefined 时桥侧按「AP2 载荷缺失」快速失败,
    // 主进程按 MAJ-07 回落该设备本流 solo cast,不会静默无声)。
    ap2: isAp2BridgeProtocol(protocol) ? buildAp2BridgePayload(deviceId) : undefined,
  });
  registerBridgeOwner(deviceId, token, groupId ?? null);
  return r;
}

/** 主进程编排:按 token 拆桥会话(bridgeStop)并清 owner。deviceId 供清 owner,可省。 */
export async function bridgeStopDevice(token: string, deviceId?: string): Promise<void> {
  if (deviceId) bridgeOwners.delete(deviceId);
  if (airplaySupervisor.isRunning()) {
    await airplaySupervisor.rpc("bridgeStop", { token }).catch(() => { /* 子进程没跑 → 无会话 */ });
  }
}

/** 停止一个会话:fork 走 RPC(子进程内 TEARDOWN + kill ffmpeg);in-proc 就地停。 */
async function stopSession(deviceId: string): Promise<void> {
  if (isAirPlayForkMode()) {
    try {
      await airplaySupervisor.rpc("stopSession", { deviceId });
    } catch { /* 子进程没跑 → 本来就没有会话 */ }
    return;
  }
  const s = sessions.get(deviceId);
  if (!s) return;
  log.debug(`[AirPlay][cast] stopSession: 收尾旧会话 ${deviceId}`);
  sessions.delete(deviceId);
  s.ended = true;
  try { killDecoder(s.ffmpeg); } catch { /* ignore */ }
  await s.player.stop().catch(() => {});
}

/** 双协议互斥(反向守卫):指定 host 上是否仍有活跃的 AirPlay 推流会话。
 *
 *  用于 DLNA 侧「停止/重置」前的判定 —— 同一台 Linkplay/HiVi 设备的 DLNA Stop
 *  会**连带停掉 AirPlay 输出**(2026-10-22 真机:流转到 HiVi 后客户端 reset 源端
 *  DLNA,设备立刻静音,而服务端 AirPlay 进度继续走)。此时只能清本地队列,
 *  绝不能再向设备下发 DLNA Stop。 */
export function hasActiveAirPlaySessionForHost(host: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  for (const d of getAirPlayDevices()) {
    if (d.host && d.host.toLowerCase() === h && hasActiveSession(d.id)) return true;
  }
  return false;
}

/** 双协议互斥:停止与指定 host 同址的 AirPlay 会话(RAOP TEARDOWN)。
 *  DLNA cast 前调用——Linkplay/HiVi 类设备音频输入互斥,残留 AirPlay 会话
 *  会占用音频通道导致 DLNA 无声。返回被停止的会话 deviceId 列表。
 *
 *  ⚠️ 必须**先冻结 AirPlay 队列,再停会话**(与 yieldSiblingDlnaForAirPlay 对称)。
 *  只停会话时:设备回 IDLE ⇒ 该端 tracker 判成「这首自然放完」⇒ advance ⇒ 重新
 *  castToAirPlayDevice,把刚建立的 DLNA 会话又反杀 —— 用户可见 =「流转到主卧后
 *  一直 0 秒不出声,HiVi 反而又播起来了」(2026-10-21 真机复现)。 */
export async function stopAirPlaySessionsForHost(host: string): Promise<string[]> {
  const stopped: string[] = [];
  if (!host) return stopped;
  const h = host.toLowerCase();
  for (const d of getAirPlayDevices()) {
    if (d.host && d.host.toLowerCase() === h && hasActiveSession(d.id)) {
      // MAJ-06:桥会话(owner=bridge)不归 DLNA 互斥管 —— 误杀会让整组桥静默。
      // v4.9.3(§互斥豁免):owner 带组归属后细化 —— 组仍存在且设备仍是成员(含
      // bridgePrepare 进行中窗口,activeBridgeRoutes 尚未登记)⇒ 豁免(接管语义:
      // 组内出声由方向 A 的组桥路由承担);组已解散/设备已移出 ⇒ 孤儿桥会话,走桥
      // 回收原语拆掉,不再永久挡同 host DLNA cast。无组上下文守旧豁免(防御)。
      if (isBridgeOwned(d.id)) {
        const gid = bridgeOwnerGroupOf(d.id);
        if (gid) {
          const { isGroupBridgeSessionAttached } = await import("../group/protocolPlayer.js");
          if (isGroupBridgeSessionAttached(gid, d.id)) {
            log.debug(`双协议互斥:豁免活跃组桥会话(group=${gid}) ${d.id}`);
            continue;
          }
          log.info(`双协议互斥:回收孤儿桥会话(group=${gid} 已不存在/设备已移出) ${d.id}`);
          await bridgeStopDevice(bridgeOwners.get(d.id)!.token, d.id);
          stopped.push(d.id);
          continue;
        }
        log.debug(`双协议互斥:跳过桥占用设备(owner=bridge) ${d.id}`);
        continue;
      }
      // ① 先冻结队列:挡住 IDLE → advance → 重新 cast 的二阶反杀。
      try {
        const { getQueueController } = await import("../player/index.js");
        getQueueController().stopPlayback(`airplay:${d.id}`);
      } catch (e: any) {
        log.warn("双协议互斥:冻结同 host AirPlay 队列失败(忽略)", { deviceId: d.id, err: e?.message || e });
      }
      // ② 再停会话(TEARDOWN + kill ffmpeg)。
      await stopAirPlaySession(d.id);
      stopped.push(d.id);
    }
  }
  if (stopped.length) {
    log.info("双协议互斥:DLNA 播放前停止同 host AirPlay 会话", { host: h, stopped });
  }
  return stopped;
}

/** Stop an active AirPlay session (used by device management: delete/disable).
 *  MAJ-06:桥占用设备(owner=bridge)不走此路径 —— 桥会话由编排侧 bridgeStop 显式回收。 */
export async function stopAirPlaySession(deviceId: string): Promise<void> {
  if (isBridgeOwned(deviceId)) {
    log.debug(`stopAirPlaySession: 跳过桥占用设备(owner=bridge) ${deviceId}`);
    return;
  }
  await withDeviceGate(deviceId, () => stopSession(deviceId));
}

/** 双协议互斥:让同一物理设备(同 host)的 DLNA 通道彻底让出音频输入。
 *
 *  必须做**两件事**,只做第一件会触发「二阶反杀」:
 *    ① 对同 host 的 DLNA renderer 下发 SOAP Stop + 清内存媒体态(设备停止出流);
 *    ② **冻结该 DLNA 队列的自动推进**(QueueController.stopPlayback)。
 *
 *  为什么 ② 不能省(2026-10-20 实测):只做 ① 时,设备 Stop 后经 GENA 上报 IDLE,
 *  而 DLNA 队列仍是 active,PlaybackTracker 会把它判成「这首自然放完」→ advance →
 *  重新 castToDevice;castToDevice 的双协议互斥再 TEARDOWN 掉刚建立的 AirPlay 会话。
 *  用户可见症状 =「AirPlay 刚出声约 1 秒就被切走/断开」(实测 HiVi H5MKII:
 *  首轮 AirPlay 仅 129 chunks / 1.0s 后即触发 `双协议互斥:DLNA 播放前停止同 host AirPlay 会话`)。
 *
 *  ② 必须**先于** ①:SOAP Stop 的 GENA 事件是异步回投的,先把队列冻结(并清 tracker
 *  的 prev 状态,见 QueueController.stopPlayback),事件到达时才不会被误判成自然结束。
 *  冻结而非 clear:队列内容保留,用户之后投回 DLNA 仍可原地续播,不丢歌单。
 *
 *  复用已有 dlnaPeerOfAirPlay(同 host 优先带 RenderingControl 的 DLNA renderer);
 *  动态 import QueueController,避开 airplay↔player↔dlna 的静态循环依赖
 *  (与同文件 reportAirPlayIdle / stopAirPlayService 同款姿势)。
 */
async function yieldSiblingDlnaForAirPlay(deviceId: string): Promise<void> {
  const dlnaPeer = dlnaPeerOfAirPlay(deviceId);
  log.debug(`[AirPlay][cast] 互斥:开始 device=${deviceId} dlnaPeer=${dlnaPeer ?? "-"}`);
  if (!dlnaPeer) return;
  // 停之前先记住 DLNA 队列是否在播:只有真的在播才需要等设备切输入,
  // 普通「客户端→HiVi」起播(DLNA 没在播)不能被这段等待拖慢。
  let wasActive = false;
  try {
    const { getQueueController } = await import("../player/index.js");
    const qc = getQueueController();
    // 读快照只用于「是否需要等停稳」,读不到不能阻断下面的冻结 ——
    // snapshot 缺失/异常时按「未激活」处理,freeze 必须照发。
    try { wasActive = qc.snapshot?.(`dlna:${dlnaPeer}`)?.isActive === true; } catch { wasActive = false; }
    // ⚠️ 必须以 `getQueueController().stopPlayback(...)` 的**字面形态**出现:
    //   双协议互斥守卫 check-airplay-dlna-mutex.mjs 用该字符串钉死「助手内确实冻结
    //   队列」。改用局部变量 qc.stopPlayback(...) 会让静态守卫失明(4.6.68 CI 红)。
    getQueueController().stopPlayback(`dlna:${dlnaPeer}`);
  } catch (e) {
    log.warn("双协议互斥:冻结同 host DLNA 队列失败(忽略)", { deviceId, dlnaPeer, err: (e as Error)?.message || e });
  }
  try {
    const t = Date.now();
    // 互斥是**尽力而为**,必须有硬上限:它在 cast 的关键路径上,SOAP/事件侧一旦挂住
    // 就会把整个 cast 拖死(2026-10-21 现场:HiVi 每次流转都卡到 30s 硬顶)。
    await withDeadline(stopDevicePlayback(dlnaPeer), DLNA_YIELD_DEADLINE_MS, "互斥 DLNA 让位", deviceId);
    log.info("双协议互斥:AirPlay 起播前停止同 host DLNA 播放并冻结其队列", { deviceId, dlnaPeer, ms: Date.now() - t });
  } catch (e) {
    log.warn("双协议互斥:停止同 host DLNA 播放失败(忽略)", { deviceId, dlnaPeer, err: (e as Error)?.message || e });
  }

  // ★ 2026-10-22:DLNA 侧 SOAP Stop 返回 ≠ 设备已经切走输入。
  //   Linkplay/HiVi 同一台设备同时暴露 DLNA + AirPlay:刚 Stop 的瞬间设备仍在
  //   DLNA 通道/正在切输入,此时建立的 AirPlay RAOP 会话**RTP 在发、设备不响**;
  //   用户几秒后手动拖一下进度(重建会话)反而有声 —— 现场日志与此完全吻合。
  //   这里在 DLNA **确实在播**时,等它报 STOPPED(轮询 GetTransportInfo,2.5s 上限)
  //   再给 300ms 让固件切完输入,然后才建 AirPlay 会话。
  if (wasActive) {
    const t0 = Date.now();
    let state: string | null = null;
    try {
      const { getTransportState } = await import("../dlna/control.js");
      while (Date.now() - t0 < DLNA_SETTLE_MAX_MS) {
        state = await getTransportState(dlnaPeer);
        if (state === null || state === "STOPPED") break;
        await new Promise((r) => setTimeout(r, DLNA_SETTLE_POLL_MS));
      }
    } catch { /* 读不到状态就不等,下面仍有 grace */ }
    await new Promise((r) => setTimeout(r, DLNA_SETTLE_GRACE_MS));
    log.info("双协议互斥:DLNA 已停稳,开始建 AirPlay 会话", {
      deviceId,
      dlnaPeer,
      state: state ?? "-",
      ms: Date.now() - t0,
    });
  }
}

async function startSession(opts: AirPlayCastOptions, seekSec?: number): Promise<void> {
  const dev = getAirPlayDevice(opts.deviceId);
  if (!dev) throw new Error("AirPlay 设备不在线或未发现");
  log.info(`[AirPlay][cast] 开始建会话 device=${opts.deviceId} host=${dev.host}:${dev.port} seek=${seekSec ?? 0}s`);

  // ===== 双协议互斥(同 host 的 DLNA 播放先行停止并冻结其队列) =====
  // Linkplay/HiVi 类设备同时暴露 DLNA + AirPlay,音频输入互斥:若 DLNA 正在播放,
  // AirPlay RAOP 起播会被设备输入抢占逻辑干扰(或设备停在 DLNA 通道 → 无声);
  // 且仅 SOAP Stop 不够——DLNA 队列会自动续播反杀,详见 yieldSiblingDlnaForAirPlay。
  // ⚠️ 互斥是**尽力而为**,必须有硬上限:它在 cast 的关键路径上,一旦 SOAP/事件
  // 侧挂住就会把整个 cast 拖死(2026-10-21 现场:HiVi 每次流转都卡到 30s 硬顶)。
  const tDlna = Date.now();
  await yieldSiblingDlnaForAirPlay(opts.deviceId);
  const dlnaMs = Date.now() - tDlna;

  // 旧会话收尾同样封顶:TEARDOWN 已在 raop 侧限 2.5s,这里再兜一层总预算。
  const tStop = Date.now();
  await withDeadline(stopSession(opts.deviceId), STOP_SESSION_DEADLINE_MS, "旧 AirPlay 会话收尾", opts.deviceId);
  const stopMs = Date.now() - tStop;

  const baseUrl = opts.baseUrl || getEffectiveBaseUrl();
  if (!baseUrl) throw new Error("未确定播放流地址(DLNA_BASE_URL 或先进行一次投屏)");
  const streamUrl = opts.streamUrl || createAirPlaySession(opts.songId, opts.deviceId, baseUrl).streamUrl;
  // 解码器吃**回环管道**(整曲缓冲 + 上游死亡⇒显式错误),不吃 raw 直通:见 toLoopbackAirPlayStreamUrl。
  // ★ 起播偏移编进 URL(`?timeOffset=N`),由**服务端管道**做 -ss —— 绝不让解码器
  //   在 live FLAC 流上用 -ss(帧中间起读 ⇒ invalid sync code、无声;见 withPlaybackOffset)。
  const feedUrl = toLoopbackAirPlayStreamUrl(withPlaybackOffset(streamUrl, seekSec));

  const player = new RaopPlayer({ host: dev.host, port: dev.port, pk: dev.pk, et: dev.et });
  let session: RaopSession;
  const tConn = Date.now();
  try {
    session = await player.connect();
  } catch (e) {
    player.stop().catch(() => {});
    throw e;
  }
  const connMs = Date.now() - tConn;
  // 分段耗时是「流转接续失败」的第一手证据:互斥(DLNA Stop)/旧会话 TEARDOWN/握手
  // 三步各自都可能挂住,合起来超过 QueueController 的 30s cast 硬顶。
  log.info(
    `AirPlay 起播分段耗时: 互斥DLNA=${dlnaMs}ms 旧会话TEARDOWN=${stopMs}ms RAOP握手=${connMs}ms (host=${dev.host})`,
    { deviceId: opts.deviceId },
  );

  // Fix-1: 会话建立(RECORD 完成)后主动推一次初始音量 —— 此前只在音量**变更**
  // 事件时才发 SET_PARAMETER(applyVolumeDb),起播会话从不推,接收端只能落在
  // 自己的默认初始音量上(shairport-sync 为 -18dB,软件衰减后 loopback 实测
  // -50.8dB 峰值,近乎无声)。音量取 volumeState 现值(0-100 标尺 → -30..0dB)。
  // 与 M54 守卫同口径:Linkplay 等 DLNA 同 host 设备的音量走 RenderingControl
  // 通道,SET_PARAMETER 被接收端忽略 —— 有 DLNA 同伴时绝不顺手再写一条
  // (controlOrchestration 两条守卫用例钉的就是这个不变量)。
  const st0 = volumeStateOf(opts.deviceId, false);
  const initialDb = st0.muted || st0.volume === 0 ? -144 : degreesToDb(st0.volume);
  if (dlnaPeerOfAirPlay(opts.deviceId)) {
    log.info(`initial volume via DLNA peer, skip SET_PARAMETER push (vol=${st0.volume}%)`,
      { deviceId: opts.deviceId });
  } else {
    player.setVolumeDb(initialDb);
    log.info(`push initial volume: ${initialDb.toFixed(2)}dB (vol=${st0.volume}%)`,
      { deviceId: opts.deviceId });
  }

  // 重播输入同样走回环管道(同上:raw 直通会假 EOF/从头重连);回环地址幂等直通。
  // seek 走**完整重建**时,新会话的 RTP 时间线要按目标秒重锚(否则上报位置从 0 起算)。
  if (seekSec !== undefined && Number.isFinite(seekSec) && seekSec > 0) {
    player.setStartPosition(seekSec);
  }
  const ff = spawnDecoder(feedUrl, undefined, {
    rowId: opts.songId,
  });
  // ⚠️ 这里**不要**再 makeProducer(ff):runStream 内部会建唯一一份 producer。
  // 旧实现先建一份又丢弃(变量未使用),但那个 producer 的 stdout data 监听器仍在,
  // 会把整首歌的 PCM 再缓存一份且无人消费(内存翻倍),还会与真 producer 争抢
  // pause/resume 背压 → 间歇性卡顿。
  const active: ActiveSession = {
    deviceId: opts.deviceId,
    player,
    ffmpeg: ff,
    session,
    title: opts.title,
    artist: opts.artist,
    album: opts.album,
    duration: opts.durationSec || 0,
    streamUrl,
    feedUrl,
    startedAt: Date.now(),
    ended: false,
  };
  sessions.set(opts.deviceId, active);
  lastCast.set(opts.deviceId, {
    songId: opts.songId,
    title: opts.title,
    artist: opts.artist,
    album: opts.album,
    coverArt: opts.coverArt,
    durationSec: opts.durationSec,
    streamUrl,
  });

  runStream(active, session);
}

/** Drive the session's current decoder into the RAOP sender and attach its
 *  lifecycle finalizer. Reused by the in-place seek path to attach a brand-new
 *  ffmpeg/producer to the SAME RTSP session.
 *
 *  Finalizer semantics:
 *   - Normal end (whole track played / stream failed / stopped): remove the
 *     session, kill the decoder, TEARDOWN the RTSP session and close the RTP
 *     sockets — otherwise the socket leaks and the device keeps serving
 *     concurrent sessions (multiple timing loops) that interfere and stutter.
 *     Then report IDLE **only if this session is still the device's current
 *     session** (stillCurrent): a superseded session's IDLE belongs to the
 *     *previous* track and would make the tracker treat the freshly cast track
 *     as "already ended" (切歌刚下去就被切走 / 曲目乱跳). The IDLE carries the
 *     real end position/duration so QueueController auto-advances without
 *     waiting for the 5s fallback poll.
 *   - seekReplace: an in-place seek owns the session; keep it + sockets alive,
 *     kill only the (old) decoder. */
function runStream(active: ActiveSession, session: RaopSession): void {
  const ff = active.ffmpeg;
  const producer = makeProducer(ff);
  const p = active.player.stream(producer, session)
    .catch((e) => {
      log.error("airplay stream failed", { deviceId: active.deviceId, err: (e as Error)?.message || e });
    })
    .finally(() => {
      if (active.seekReplace) {
        active.seekReplace = false;
        killDecoder(ff);
        return;
      }
      // ⚠️ 必须在 delete **之前**判定,且这是整个收尾的关键一步(2026-10-20 现网定位):
      // 被「新起播」(startSession → stopSession → 新会话入表)或「显式 stop」取代后,
      // 旧会话的 finalizer 仍会跑到这里。若照旧无条件上报 IDLE,这条 IDLE 属于**上一首**,
      // 与刚建立的新会话共用同一个 playerId `airplay:<deviceId>` → tracker 会把新曲
      // 判成「已结束」→ 误切歌/刚切过去就被切走(用户观感「切歌无效 / 曲目乱跳」)。
      // stillCurrent=false 时只做资源收尾,上报交给新会话。
      const stillCurrent = sessions.get(active.deviceId) === active;
      if (stillCurrent) {
        sessions.delete(active.deviceId);
      }
      try { killDecoder(ff); } catch { /* ignore */ }
      // 会话自然结束(整首播完 / 失败)也必须拆掉 RTP socket 并发 TEARDOWN,
      // 否则 socket 泄漏,设备同时维护多个并发会话(多个 timing 循环),互相干扰导致卡顿。
      active.player.stop().catch(() => {});
      // 会话结束(整首播完 / 中途失败 / 被 stop)统一走 handleAirplaySessionEnded:
      // 由它上报 IDLE(等效 DLNA 的 GENA —— 让 QueueController 无需等下一次 5s fallback
      // poll 就能自动切下一首)+ 落 P0-4 响度。这里**不再**另发一条 IDLE:
      // 旧实现既在 finalizer 内联上报、又在 handleAirplaySessionEnded 里再上报一次;
      // 更糟的是内联那条把 position 写死 0 —— tracker 的结束判据要靠真实落点
      // (位置 ≥ 时长−容差)才判 advance,写死 0 时末次 5s 轮询一旦错过就退化成 idle_early。
      // seek 原地换解码器不走这里(上面 seekReplace 分支已提前 return)。
      const endPos = Math.max(0, Number(active.player.positionSec) || 0);
      const endDur = active.duration || Math.max(0, Number(active.player.durationSec) || 0);
      void handleAirplaySessionEnded(
        active.deviceId,
        (active.ffmpeg as any)?.stderrText?.() ?? "",
        undefined,
        { current: stillCurrent, positionSec: endPos, durationSec: endDur },
      );
    });
  active.streamPromise = p;
  // 会话一建立(RTSP RECORD 已完成、解码器已起、节拍开始)就**主动**上报 PLAYING,
  // 不等下一次 5s 兜底轮询 —— 见 reportAirPlayPlaying 的完整论证。
  reportAirPlayPlaying(active.deviceId, active.streamUrl, active.player.positionSec,
    active.duration || active.player.durationSec);
}

// ==================== 设备持久化(airplay_devices) ====================
// AirPlay 设备也持久化到 DB(对齐 dlna_devices):alias/disabled 跨重启保留,
// 离线设备不删除,供「播放器」页管理(重命名/删除)。发现流程只更新在线字段,
// 不覆盖 alias / disabled / first_seen。

function isoNow(): string { return new Date().toISOString(); }

function upsertAirPlayDeviceRow(d: AirPlayDevice, online: boolean): AirPlayDevice {
  const now = isoNow();
  const existing = sqlite.prepare("SELECT alias, first_seen, disabled FROM airplay_devices WHERE id = ?").get(d.id) as any;
  const alias = existing?.alias || d.alias || "";
  const firstSeen = existing?.first_seen || now;
  sqlite.prepare(`
    INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      last_seen = excluded.last_seen,
      available = excluded.available,
      updated_at = excluded.updated_at
  `).run(d.id, d.name, alias, firstSeen, now, online ? 1 : 0, now);
  // Re-attach preserved alias + disabled to the in-memory device (discovery keeps
  // the user's rename/disable across restarts and re-discovery).
  d.alias = alias || undefined;
  d.disabled = !!existing?.disabled;
  return d;
}

function markAirPlayDeviceOfflineInDb(deviceId: string): void {
  sqlite.prepare("UPDATE airplay_devices SET available = 0, updated_at = ? WHERE id = ?").run(isoNow(), deviceId);
}

/** 持久化 hook 注册:发现流程每次 alive 时把设备写库(保留 alias/disabled)。 */
export function wireAirPlayPersistence(): void {
  setAirPlayPersist(upsertAirPlayDeviceRow);
}

/** 启动时从 DB 恢复持久化 AirPlay 设备(离线设备也在列表中可管理)。
 *  之前的 mDNS 设备仍在内存 map 中则不动;否则以离线态入列,等 mDNS alive 后置在线。 */
export function loadPersistedAirPlayDevices(): void {
  const rows = sqlite.prepare(
    "SELECT id, name, alias, last_seen, disabled FROM airplay_devices"
  ).all() as any[];
  for (const r of rows) {
    if (getAirPlayDevice(r.id)) continue;
    upsertFromDb(r);
  }
}

function upsertFromDb(r: any): void {
  const dev: AirPlayDevice = {
    id: r.id,
    name: r.name || "未知 AirPlay 设备",
    alias: r.alias || undefined,
    disabled: !!r.disabled,
    host: "",
    port: 0,
    supportsRsa: false,
    supportsAp2: false, // 持久化行不含能力:mDNS 的 `_airplay` 记录到了才标
    lastSeen: r.last_seen ? Date.parse(r.last_seen) || 0 : 0,
    available: false,
  };
  // Push into the device map so the peer list / manage page see it.
  import("./discovery.js").then(({ addPersistedAirPlayDevice }) => {
    addPersistedAirPlayDevice(dev);
  }).catch((e) => {
    log.error("恢复持久化 AirPlay 设备失败", { deviceId: dev.id, err: (e as Error)?.message || e });
  });
}

/** 设置用户自定义显示名(alias)。空串 = 恢复原始名。同步 DB + 内存缓存,并立即
 *  触发 airplay peer reconcile(播放控件 / HA 卡片显示名更新)。返回更新后设备。 */
export function setAirPlayAlias(deviceId: string, alias: string): AirPlayDevice | undefined {
  const d = getAirPlayDevice(deviceId);
  const inDb = !!sqlite.prepare("SELECT 1 FROM airplay_devices WHERE id = ?").get(deviceId);
  if (!d && !inDb) return undefined;
  sqlite.prepare("UPDATE airplay_devices SET alias = ?, updated_at = ? WHERE id = ?")
    .run(alias, isoNow(), deviceId);
  if (d) d.alias = alias || undefined;
  // 动态 import 避免循环依赖(renderers/airplay → control → peer → dlna/...)。
  import("../peer.js").then(({ getPeerManager }) => {
    getPeerManager().reconcileAirPlayPeers();
  }).catch((e) => {
    log.error("重命名后 AirPlay peer reconcile 失败", { deviceId, err: (e as Error)?.message || e });
  });
  return d;
}

/** 禁用/启用 AirPlay 设备:写 DB + 内存缓存,并重新 reconcile peer(禁用 → 移除 peer,
 *  启用 → 重新注册)。停止播放/清队列由路由层处理。返回更新后设备。 */
export function setAirPlayDisabled(deviceId: string, disabled: boolean): AirPlayDevice | undefined {
  const d = getAirPlayDevice(deviceId);
  const inDb = !!sqlite.prepare("SELECT 1 FROM airplay_devices WHERE id = ?").get(deviceId);
  if (!d && !inDb) return undefined;
  const now = isoNow();
  sqlite.prepare(`
    INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, disabled, updated_at)
    VALUES (?, '', '', ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET disabled = excluded.disabled, updated_at = excluded.updated_at
  `).run(deviceId, now, now, disabled ? 1 : 0, now);
  if (d) d.disabled = disabled;
  import("../peer.js").then(({ getPeerManager }) => {
    getPeerManager().reconcileAirPlayPeers();
  }).catch((e) => {
    log.error("禁用/启用后 AirPlay peer reconcile 失败", { deviceId, err: (e as Error)?.message || e });
  });
  return d;
}

/** 彻底删除 AirPlay 设备:DB 行 + 内存缓存。队列 / peer 由路由层处理。 */
export function deleteAirPlayDeviceRecord(deviceId: string): boolean {
  const existed = !!getAirPlayDevice(deviceId) ||
    !!sqlite.prepare("SELECT 1 FROM airplay_devices WHERE id = ?").get(deviceId);
  sqlite.prepare("DELETE FROM airplay_devices WHERE id = ?").run(deviceId);
  // 清理该设备的内存态(音量/最近一次投屏),防止只增不删(内存红线)。
  volumeState.delete(deviceId);
  // 永久删除 = 这台设备从没配置过:持久音量/静音一并清掉,避免设备重新被发现时
  // 带着旧设置"复活"(与 sendspin 解绑清整行同语义)。
  deleteAirPlayVolumeState(deviceId);
  // Phase 6a 凭据契约:hap_credentials 是 airplay_devices 的列,随本行 DELETE
  // 一并消失 —— 设备被删除即自动「清凭据回到配对窗」,无需额外清理;6a 的
  // pairingContract 只负责另一条失效路径(verify 连续失败 N 次)。
  lastCast.delete(deviceId);
  import("./discovery.js").then(({ removeAirPlayDevice }) => {
    removeAirPlayDevice(deviceId);
  }).catch((e) => {
    log.error("删除 AirPlay 设备内存缓存失败", { deviceId, err: (e as Error)?.message || e });
  });
  return existed;
}

/** AirPlay 设备是否被禁用(内存优先,DB 兜底 —— 用于 cast / 控制链路防绕过校验)。 */
export function isAirPlayDeviceDisabled(deviceId: string): boolean {
  const d = getAirPlayDevice(deviceId);
  if (d) return !!d.disabled;
  const row = sqlite.prepare("SELECT disabled FROM airplay_devices WHERE id = ?").get(deviceId) as any;
  return !!row?.disabled;
}

// ==================== AP2 配对链路(controller id / PIN 配对 / 可选判据)====================
//
// 用户规则(2026-10-27 拍板,不得更改):
//   1. **未配对的 AP2 设备:不得加入群组、不得出现在「可选择播放器」**;
//   2. **凭据失效不摘出已有的组**:播放回落 AP1 并标「需重新配对」;只有「新加入」严格禁止;
//   3. AP1-only 设备(`supportsAp2=false`,例如 HiVi)**完全不受影响**;
//   4. 群组允许 airplay(AP1) + airplay(AP2) + sendspin 混合 —— 协议**逐成员**选,不是组级;
//   5. 不新增 `ap2:` 命名空间(成员 id 仍是 `airplay:<deviceId>`)。
//
// 本段的三个出口:
//   - getAirPlayControllerId:HAP 控制端 pairing id(写 settings,首次生成后稳定);
//   - pairAirPlayDevice:播放器页「配对」按钮的唯一实现(PIN = 设备屏幕 4 位码);
//   - isAirPlayMemberSelectable:「可选」判据的**唯一出口**(选择器候选 / 群组准入 / cast 准入)。

/** settings 键:AP2 controller pairing id(HAP 控制端标识)。 */
export const AP2_CONTROLLER_ID_SETTING_KEY = "airplay.controllerId";

/** 合法形态:16 位**大写** hex(HAP deviceid 口径)。 */
const AP2_CONTROLLER_ID_RE = /^[0-9A-F]{16}$/;

/** PIN 位数:设备屏幕上显示的 4 位码。 */
export const AP2_PAIR_PIN_LENGTH = 4;

/** 严格 4 位数字(PIN 只认这个形态,不做宽松解析)。 */
const AP2_PIN_RE = new RegExp(`^\\d{${AP2_PAIR_PIN_LENGTH}}$`);

/** controller pairing id 的进程内缓存(settings 读失败时的兜底,也是热路径快照)。 */
let cachedControllerId: string | null = null;

/** 生成一个新的 16 位大写 hex pairing id。 */
function generateControllerId(): string {
  return randomBytes(8).toString("hex").toUpperCase();
}

/**
 * 取 AP2 controller pairing id(16 位大写 hex);首次调用生成并写库。
 *
 * ⚠️ **pairing id 一变,库里 hap_credentials 全失效** —— HAP 长期密钥是
 * (controller pairing id, accessory) 绑定的:换 id 等同于换了一个控制端,
 * 所有已配对设备都必须重新走 PIN 配对。所以这个值一旦生成就必须稳定持久,
 * **不得**随进程重启 / 设备重扫重新生成;非法值(被手改坏/长度不对)才重新生成。
 *
 * 失败策略(**绝不向上抛**):settings 读抛异常 ⇒ 用进程内临时 id 并 warn。
 * 宁可本进程这轮配对在重启后重来,也不能因为一个设置项读失败就让设备列表/配对按钮 500。
 */
export function getAirPlayControllerId(): string {
  if (cachedControllerId) return cachedControllerId;
  let stored = "";
  try {
    stored = getSetting(AP2_CONTROLLER_ID_SETTING_KEY, "");
  } catch (e: any) {
    // getSetting 自身已吞数据库错误,这里兜的是更外层的意外(例如实现变更)。
    log.warn(`[ap2] 读 ${AP2_CONTROLLER_ID_SETTING_KEY} 失败,本轮用进程内临时 id: ${e?.message || e}`);
    cachedControllerId = generateControllerId();
    return cachedControllerId;
  }
  const normalized = (stored || "").trim().toUpperCase();
  if (AP2_CONTROLLER_ID_RE.test(normalized)) {
    cachedControllerId = normalized;
    return cachedControllerId;
  }
  if (normalized) {
    // 不打印原值(可能是被误写到该键的别的配置),只报长度便于排障。
    log.warn(`[ap2] ${AP2_CONTROLLER_ID_SETTING_KEY} 格式非法(长度 ${normalized.length},应为 16 位 hex),重新生成`);
  }
  const next = generateControllerId();
  try {
    setSetting(AP2_CONTROLLER_ID_SETTING_KEY, next);
  } catch (e: any) {
    log.warn(`[ap2] 写 ${AP2_CONTROLLER_ID_SETTING_KEY} 失败(本次仅进程内生效): ${e?.message || e}`);
  }
  cachedControllerId = next;
  return cachedControllerId;
}

/** Test-only:清 pairing id 进程内缓存(用例间隔离,避免顺序耦合)。 */
export function _resetAirPlayControllerIdCacheForTest(): void {
  cachedControllerId = null;
}

/** 「可选」判据的**唯一定义处**(全仓只此一份,禁止另写一套):
 *  - 禁用设备永远不可选(与既有 disabled 语义一致);
 *  - AP2 capable 设备**必须已完成配对**(库里有 hap_credentials)才可选;
 *  - AP1-only 设备(`supportsAp2=false`)不受影响 —— 这就是「AP1 设备完全不改行为」的落点。
 *
 *  消费方:`listAirPlayDevices`(设备视图的 `selectable` 字段)、`isAirPlayMemberSelectable`
 *  (群组准入 / cast 准入 / 前端选择器过滤的唯一后端判据)。 */
function selectableOf(disabled: boolean, ap2Capable: boolean, ap2Paired: boolean): boolean {
  return !disabled && (!ap2Capable || ap2Paired);
}

/** 该 AirPlay 设备当前是否「可选」(能进组、能出现在「可选择播放器」里)。
 *  未配对 AP2 ⇒ false;AP1-only 或已配对 AP2 ⇒ 取决于 disabled。 */
export function isAirPlayMemberSelectable(deviceId: string): boolean {
  const d = getAirPlayDevice(deviceId);
  if (!d) return false;
  const ap2Capable = !!d.supportsAp2;
  // 只有 AP2 capable 才查凭据列:AP1-only 设备(绝大多数)不付出任何额外 DB 查询。
  return selectableOf(!!d.disabled, ap2Capable, ap2Capable && getHapCredentials(deviceId) !== null);
}

// ==================== 桥协议选择(唯一落点,Phase 6b · T01) ====================

/** 桥协议总闸:只有**显式** `MUSICFLOW_AIRPLAY_AP2=0` 才关(默认开)。
 *  关掉 = 全仓回到 AP1/RAOP 逐字节旧行为(排障/回滚开关)。 */
const AP2_BRIDGE_FLAG_KEY = "MUSICFLOW_AIRPLAY_AP2";

/** 该设备这次进桥该用哪个协议(`raop` / `ap2-realtime`)——**唯一选择点**。
 *
 *  判据(按序短路,只用有实测支撑的事实,**绝不**猜测设备能力):
 *   ① 旗标 `MUSICFLOW_AIRPLAY_AP2=0` ⇒ raop;
 *   ② 设备不存在 / `supportsAp2 !== true` ⇒ raop
 *      (`supportsAp2` = 同时广播 `_airplay._tcp` 且 **`protovers ≥ 1.1`** —— 这是本仓
 *       唯一有真机实测支撑的 AP2 能力判据);
 *   ③ `getHapCredentials(deviceId) === null`(未配对)⇒ raop
 *      (没有 pair-verify 凭据就建不了加密 RTSP,AP2 realtime 无从谈起);
 *   ④ 否则 ⇒ `ap2-realtime`(48k 直通 + ChaCha,`PROTOCOL_CAPS` 同源)。
 *
 *  **为什么不看 features / et / 设备类型**:`features` 是位图,各家实现报得极不一致
 *  (缺失位并不代表不支持,报了位也不代表这条路走得通),`et` 只说明 RAOP 是否
 *  RSA 加密,`am`/model 是厂商字符串 —— 三者在本仓都没有任何实测样本支撑,
 *  按它们分流等于拿用户设备试错。`protovers ≥ 1.1` 已被发现层与配对链路消化过一圈
 *  (设备视图 ap2Capable / 未配对禁止入组),信噪比最高。
 *
 *  **为什么禁选 ap2-compat**:它(`PROTOCOL_CAPS`)与 `raop` 逐字段相同
 *  (rate 44100 / ntp / none / streamType 96)⇒ 只会诱出两条一模一样的代码路径,
 *  出问题时无法从日志区分走了哪条;要 AP1 就直说 `raop`。
 *  **为什么禁选 ap2-buffered**:仓内**没有**它的实现(streamType 103 + PTP 时钟),
 *  选中即无声。
 *
 *  契约:**纯查表、无副作用、绝不抛异常**(任何异常一律回落 `raop`);
 *  调用点只有桥路由(`group/protocolPlayer.ts` 的 prepareBridgeRoute / bridgeJoinMember)
 *  与 `bridgePrepareDevice` 的载荷组装 —— 设备逐成员选协议,不是组级。
 */
export function selectAirPlayBridgeProtocol(deviceId: string): BridgeProtocol {
  try {
    if (process.env[AP2_BRIDGE_FLAG_KEY] === "0") return "raop";
    const dev = getAirPlayDevice(deviceId);
    if (!dev || dev.supportsAp2 !== true) return "raop";
    if (getHapCredentials(deviceId) === null) return "raop";
    return "ap2-realtime";
  } catch (e: any) {
    // 选择器不能成为新的故障面:DB/发现层任何异常 ⇒ 退回原来的 AP1 行为。
    log.warn(`[ap2] 协议选择失败,回落 raop(device=${deviceId}): ${e?.message || e}`);
    return "raop";
  }
}

/** 桥协议是否为 AP2 realtime(载荷/出口分支的唯一判据,避免各处 startsWith 散落)。 */
export function isAp2BridgeProtocol(protocol: BridgeProtocol): boolean {
  return protocol.startsWith("ap2-");
}

/** AP2 realtime 桥载荷(建链所需,子进程无 DB 故在此组装):
 *  controllerId 取 settings 稳定值,credsHex 取已切分的库内凭据(未配对 ⇒ undefined)。
 *  `latencyMin` 不下发 ⇒ 子进程按 `AP2_DEFAULT_LATENCY_FRAMES` 声明。 */
function buildAp2BridgePayload(deviceId: string): {
  controllerId: string;
  credsHex?: { accessoryLTPK: string; controllerLTSK: string };
} | undefined {
  const creds = getHapCredentials(deviceId);
  if (!creds) return undefined;
  return { controllerId: getAirPlayControllerId(), credsHex: creds };
}

/** AP2 PIN 配对失败的分类码(路由层按它映射 HTTP 状态)。 */
export type AirPlayPairErrorCode =
  | "ap2-unsupported"
  | "ap2-pin"
  | "ap2-timeout"
  | "ap2-persist"
  | "ap2-fail";

/** 配对结果:**成功不自动起播**(配对是设备管理动作,不是播放动作)。 */
export type AirPlayPairResult = { ok: true } | { ok: false; code: AirPlayPairErrorCode; message: string };

/** 面向用户的配对文案(可直接展示;路由层原样回传,无需新增 i18n key)。 */
export const AP2_PAIR_MESSAGES = {
  /** 设备不存在(可能已被删除 / 还没被 mDNS 发现)。 */
  unknownDevice: "设备不存在或已被移除,请刷新设备列表后重试",
  /** 不支持 AP2(AP1-only 设备无需配对)。 */
  unsupported: "该设备不支持 AirPlay 2(未广播 _airplay._tcp),无需配对",
  /** PIN 形态非法(不是 4 位数字)。 */
  pinInvalid: "PIN 必须是设备屏幕上显示的 4 位数字",
  /** PIN 错误(M4 server proof / M6 签名校验失败)。 */
  pinWrong: "PIN 不正确,请重新输入设备屏幕上显示的 4 位码",
  /** 超时(设备不响应 / 没进配对态)。 */
  timeout: "设备配对超时,请确认设备屏幕上正显示 4 位码(重新进入配对状态)后重试",
  /** 配对通过但凭据写库失败 —— 不得宣称成功。 */
  persist: "配对已通过但凭据写入失败,该设备仍需重新配对,请检查存储空间后重试",
  /** 其他失败(协议异常 / 网络不可达 / 设备拒绝)。 */
  fail: "AirPlay 2 配对失败,请重试或重启设备",
} as const;

/** PIN 是否为合法 4 位数字(路由层入参校验与配对主流程共用同一判据)。 */
export function isValidAirPlayPin(pin: unknown): pin is string {
  return typeof pin === "string" && AP2_PIN_RE.test(pin.trim());
}

/** 把底层异常分类成对用户有意义的配对错误码。
 *  - `HapPairingError.kind === "auth"`:M4 server proof / M6 签名校验失败 ⇒ PIN 错;
 *  - 超时(`RtspError` 的「超时」文案 / Node `ETIMEDOUT`) ⇒ ap2-timeout;
 *  - 其余(协议异常 / ECONNREFUSED / 设备拒绝) ⇒ ap2-fail。
 *  ⚠️ 只做分类,不把异常原文透给用户(可能含内部细节),原文只进日志。 */
function classifyPairError(e: unknown): AirPlayPairErrorCode {
  const err = e as { message?: unknown; name?: unknown; kind?: unknown; code?: unknown } | null;
  const message = typeof err?.message === "string" ? err.message : String(e ?? "");
  const name = typeof err?.name === "string" ? err.name : "";
  const code = typeof err?.code === "string" ? err.code : "";
  if (err?.kind === "auth") return "ap2-pin";
  if (code === "ETIMEDOUT" || name === "TimeoutError" || /超时|timeout|timed out/i.test(message)) {
    return "ap2-timeout";
  }
  return "ap2-fail";
}

/** 错误码 → 用户文案。 */
function pairMessageOf(code: AirPlayPairErrorCode): string {
  switch (code) {
    case "ap2-unsupported":
      return AP2_PAIR_MESSAGES.unsupported;
    case "ap2-pin":
      return AP2_PAIR_MESSAGES.pinWrong;
    case "ap2-timeout":
      return AP2_PAIR_MESSAGES.timeout;
    case "ap2-persist":
      return AP2_PAIR_MESSAGES.persist;
    default:
      return AP2_PAIR_MESSAGES.fail;
  }
}

/**
 * 走 PIN 配对窗把一台 AP2 设备配上(`/pair-pin-start` → pair-setup M1-M6)。
 *
 * 流程与契约:
 *   1. 前置:设备存在、`supportsAp2=true`、host/port 已发现;PIN 必须是 4 位数字;
 *   2. 调 `pairNewDevice`(6b 会话编排),seed 回调里登记「本次新生成了 controller seed」;
 *   3. 成功返回后立刻经 `recordPairSetupSuccess` 走**唯一写入口**落库
 *      (写库失败 ⇒ `ap2-persist`,**绝不**向调用方宣称成功);
 *   4. 成功**不自动起播** —— 起播由用户/队列另行发起。
 *
 * ⚠️ PIN 只在本次调用内存在:**不落库、不进日志**(日志只记失败分类与设备 id)。
 * ⚠️ seed 回调只携带 controllerSeed(32B),而落库需要 accessoryLTPK + controllerLTSK
 *    这组完整凭据(M4 之后才齐),所以写库紧跟在 `pairNewDevice` 返回之后、同一个
 *    调用栈内完成 —— 语义仍是「seed 新生成 ⇒ 必须持久化,失败即配对失败」。
 */
export async function pairAirPlayDevice(deviceId: string, pin: string): Promise<AirPlayPairResult> {
  const dev = getAirPlayDevice(deviceId);
  if (!dev) {
    return { ok: false, code: "ap2-unsupported", message: AP2_PAIR_MESSAGES.unknownDevice };
  }
  if (!dev.supportsAp2) {
    return { ok: false, code: "ap2-unsupported", message: AP2_PAIR_MESSAGES.unsupported };
  }
  const pinText = typeof pin === "string" ? pin.trim() : "";
  if (!isValidAirPlayPin(pinText)) {
    return { ok: false, code: "ap2-pin", message: AP2_PAIR_MESSAGES.pinInvalid };
  }
  if (!dev.host || !dev.port) {
    return { ok: false, code: "ap2-fail", message: "设备地址未知(等 mDNS 发现完成后再试)" };
  }
  // seed 回调:登记「本次确实新生成 controller seed」(配对成功必须以它为前提)。
  let seedSeen = false;
  let creds: HapCredsHex;
  try {
    creds = await pairNewDevice({
      host: dev.host,
      port: dev.port,
      controllerId: getAirPlayControllerId(),
      pin: pinText,
      timeoutMs: AP2_PAIR_TIMEOUT_MS,
      onNewControllerSeed: () => {
        seedSeen = true;
      },
    });
  } catch (e: any) {
    const code = classifyPairError(e);
    log.warn(`[ap2-pair] 设备 ${deviceId} 配对失败(${code}): ${e?.message || e}`);
    return { ok: false, code, message: pairMessageOf(code) };
  }
  if (!seedSeen) {
    // 理论上不会发生(无新 seed 就没有 6a 凭据);保守按失败处理,避免写入半截凭据。
    log.error(`[ap2-pair] 设备 ${deviceId} 配对未产生 controller seed,视为失败`);
    return { ok: false, code: "ap2-fail", message: AP2_PAIR_MESSAGES.fail };
  }
  // 唯一写入口:写库失败 ⇒ 配对失败(6a 契约:不得向对端/用户宣称成功)。
  const persisted = recordPairSetupSuccess(deviceId, creds.accessoryLTPK, creds.controllerLTSK);
  if (!persisted) {
    log.error(`[ap2-pair] 设备 ${deviceId} 凭据写库失败,配对未生效`);
    return { ok: false, code: "ap2-persist", message: AP2_PAIR_MESSAGES.persist };
  }
  log.info(`[ap2-pair] 设备 ${deviceId} 配对成功,凭据已入库(重启免 PIN)`);
  return { ok: true };
}

/**
 * cast 准入判定(**导出供单测**):返回需要提示的文案,null = 放行。
 *
 * 规则:
 *   - 未配对 AP2(`supportsAp2 && 无凭据`)且**不是既有群组成员** ⇒ 拒绝,文案要求先配对
 *     (**不静默回落 AP1** —— 否则用户以为在放 AP2);
 *   - 已经在该设备所属群组里播放的成员**放行**(用户规则 2:凭据失效不摘组,播放回落 AP1,
 *     由设备视图 `ap2Paired=false` 标「需重新配对」);
 *   - AP1-only / 已配对 / 未知设备 ⇒ 放行(未知设备交给后续「设备不存在」错误,不误伤)。
 */
export async function getAirPlayCastGateError(deviceId: string): Promise<string | null> {
  const dev = getAirPlayDevice(deviceId);
  if (!dev || !dev.supportsAp2) return null;
  if (getHapCredentials(deviceId)) return null;
  if (await isAirPlayGroupMember(deviceId)) return null;
  const name = (dev.alias || dev.name || deviceId).trim();
  return `AirPlay 设备 ${name} 需要先在播放器页完成 AirPlay 2 配对后才能播放`;
}

/** 该设备当前是否是某个群组的成员(cast 准入用:既有成员允许 AP1 回落)。
 *  动态 import 避免群组服务 ↔ airplay control 的静态循环依赖;查询失败按「非成员」处理。 */
async function isAirPlayGroupMember(deviceId: string): Promise<boolean> {
  try {
    const { getGroupManager } = await import("../group/index.js");
    return getGroupManager().groupsOfDevice(deviceId).length > 0;
  } catch (e: any) {
    log.warn(`[ap2] 查询设备 ${deviceId} 的群组归属失败(按非成员处理): ${e?.message || e}`);
    return false;
  }
}

// ==================== Public API ====================

export function listAirPlayDevices(): {
  id: string; name: string; alias: string; displayName: string;
  available: boolean; disabled: boolean; supportsRsa: boolean; am?: string; host: string; port: number;
  /** AP2 能力标记(E2):仅当设备同时广播 `_airplay._tcp` 且 protovers ≥ 1.1。
   *  **不改变投屏路径** —— E3~E5 落地前仍一律走 AP1。 */
  supportsAp2: boolean;
  /** AP2 能力标记的显式别名(选择器/群组候选读它,语义比 supportsAp2 更直白)。 */
  ap2Capable: boolean;
  /** AP2 凭据是否已入库(未配对 ⇒ false;AP1-only 设备恒 false,无意义)。 */
  ap2Paired: boolean;
  /** 能否被选进「可选择播放器」/ 群组成员候选 —— 判据唯一出处是 selectableOf。
   *  **选择器与群组候选必须过滤 `selectable === true`**;未配对的 AP2 设备
   *  仍然出现在列表里(带 ap2Paired=false),以便用户在播放器页发起配对。 */
  selectable: boolean;
  /** AP2 TXT 原始能力(features/srcvers/protovers/gid/flags),供 E3 握手/加密读取。 */
  ap2?: { features?: string; srcvers?: string; protovers?: string; gid?: string; flags?: string; model?: string };
}[] {
  return getAirPlayDevices().map((d) => {
    const ap2Capable = !!d.supportsAp2;
    // 只有 AP2 capable 才查凭据列:纯 AP1 部署(绝大多数)零额外查询。
    const ap2Paired = ap2Capable && getHapCredentials(d.id) !== null;
    return {
      id: d.id, name: d.name, alias: d.alias || "",
      displayName: (d.alias || d.name).trim(),
      available: d.available, disabled: !!d.disabled,
      supportsRsa: d.supportsRsa, am: d.am, host: d.host, port: d.port,
      supportsAp2: !!d.supportsAp2, // 与 ap2Capable 同值(守卫钉住这一行,勿改表达式形态)
      ap2Capable,
      ap2Paired,
      selectable: selectableOf(!!d.disabled, ap2Capable, ap2Paired),
      ap2: d.ap2
        ? { features: d.ap2.features, srcvers: d.ap2.srcvers, protovers: d.ap2.protovers, gid: d.ap2.gid, flags: d.ap2.flags, model: d.ap2.model }
        : undefined,
    };
  });
}

export function hasAirPlayDevice(deviceId: string): boolean {
  return !!getAirPlayDevice(deviceId);
}

/** Cast a track to an AirPlay device and start playing it. */
export async function castToAirPlayDevice(opts: AirPlayCastOptions): Promise<{ mediaUri: string }> {
  // 设备级串行:与 seek/stop 按到达顺序执行(见 withDeviceGate 的事故说明)。
  return withDeviceGate(opts.deviceId, () => castUnlocked(opts));
}

/** cast 的实际实现(**不再加闸**,供 seekAirPlay 等已在闸内的调用方直调,避免自锁死)。 */
async function castUnlocked(opts: AirPlayCastOptions): Promise<{ mediaUri: string }> {
  if (isAirPlayDeviceDisabled(opts.deviceId)) {
    throw new Error("该 AirPlay 设备已被禁用");
  }
  // AP2 未配对准入(用户规则 1/2):直接投屏到未配对的 AP2 设备一律**报错并要求先配对**,
  // 不静默回落 AP1(**否则用户以为在放 AP2**)。已经是某个群组成员时放行 —— 既有组内的
  // 成员凭据失效只让播放回落 AP1(不摘组、不阻断群组播放),由设备视图标「需重新配对」。
  const ap2Gate = await getAirPlayCastGateError(opts.deviceId);
  if (ap2Gate) {
    throw new Error(ap2Gate);
  }
  // Phase 3 互斥(owner=bridge):桥会话占用期间拒绝 native cast(与 §5.5 owner token 一致)。
  if (isBridgeOwned(opts.deviceId)) {
    throw new Error("该设备由桥接会话占用(owner=bridge),native cast 与 bridge 互斥");
  }
  if (isAirPlayForkMode()) {
    await castViaChild(opts);
    return { mediaUri: opts.streamUrl || "" };
  }
  await startSession(opts, opts.seekSec);
  return { mediaUri: opts.streamUrl || "" };
}

// ==================== fork 模式:主进程侧前戏 + 子进程推流 ====================
//
// 「建会话前必须发生在主进程」的四件事(与 in-proc 路径同语义,顺序也一致):
//   1) 设备解析(getAirPlayDevice → host/port/pk/et 来自 mDNS 发现);
//   2) 双协议互斥(同 host 的 DLNA 播放先停,否则 Linkplay/HiVi 类设备音频输入互斥);
//   3) token 化 streamUrl(createCastSession 会写 token 会话 → 属主进程 DB 职责);
//   4) lastCast 登记(供 peerStatus.media 与「无会话时重播上一首」)。
// 之后 host/streamUrl 一并交给子进程,由它做 RTSP 握手与 7.98ms 节拍推流。

let hostStarting: Promise<void> | null = null;

/** 会话结束后向 PlayerController 上报 IDLE(等价 DLNA 的 GENA 事件):
 *  让 QueueController 不必等下一次 5s fallback poll 就能感知"这首已结束"并自动续播。
 *  fork 模式下由子进程的 sessionEnded 事件触发。
 *
 *  positionSec/durationSec 必须是**真实落点** —— 写死 0 会让 tracker 的结束判据
 *  (位置 ≥ 时长−容差 → advance)只能靠"末次轮询恰好落在结尾附近"才能成立。 */
function reportAirPlayIdle(deviceId: string, positionSec = 0, durationSec = 0): void {  // ===== 注意用动态 import 避免静态循环依赖 =====
  import("../player/index.js").then(({ getPlayerController }) => {
    getPlayerController().reportState({
      playerId: `airplay:${deviceId}`,
      playbackState: PlaybackState.IDLE,
      position: Math.max(0, positionSec),
      duration: Math.max(0, durationSec),
      updatedAt: Date.now(),
    });
  }).catch((e) => {
    log.error("reportState IDLE 上报失败", { deviceId, err: (e as Error)?.message || e });
  });
}

/** 会话**建立**(RTSP RECORD 完成、解码器已起、节拍开始)后立即主动上报 PLAYING。
 *
 *  ── 为什么必须主动上报,而不是等 5s 兜底轮询(2026-10-20 现网定位,一次修掉三条现象) ──
 *  AirPlay 的 PLAYING 只有两个可能来源:① 本函数(会话建立时);② QueueController 的
 *  5s 兜底轮询(dlna/control.ts/createAirPlayProtocolPlayer.pollState)。而轮询在
 *  `advancing` 期间被 `pollAllDevices` 整台跳过,cast 返回后
 *  `resetTracker/armOptimisticTimeout` 与下一次轮询之间又可能跨过整整一个 5s 周期。
 *  于是乐观窗口(PlayerController.armOptimisticTimeout:只由一条 PLAYING 关闭)
 *  常常先超时,连锁出三条用户可见缺陷:
 *    ① 窗口 5s 未关 → 直接判 `stalled` → QueueController 重投**当前曲**(从头再来)
 *       ⇒「同一首没播完就从头循环 / 重复播放同一首」;
 *    ② 自然结束的 IDLE 上报被**仍开着**的乐观窗口吞掉
 *       (PlayerController.reportState 的 `窗口内忽略 IDLE(等待 PLAYING 确认)`)
 *       ⇒「当前曲放完不自动下一首」;
 *    ③ 反复的 5s stalled 重投会长期占用 QueueController 的 `advancing` 闸,期间
 *       外部切歌(next / play-from)被 `if (advancing.has(id)) return` 静默吞掉
 *       ⇒「不接受外部切歌指令(客户端/网页切歌无效)」。
 *  mediaUri 一并上报(与 DLNA pollState 的 TrackURI 对齐):tracker 的
 *  「PLAYING 且 uri 变 = 换歌」判据对 AirPlay 才**可达**,不再是恒不可达的死判据。
 *
 *  时序:本函数在 runStream 挂载推流后**同步**调用;playCurrent 随后还会
 *  resetTracker —— 传进来的这条 PLAYING 与上一首 token 不同,可能被判 track_changed,
 *  但紧接着的 resetTracker 会 clearPending 把它清掉,不会误切歌(见 playCurrent 注释)。 */
function reportAirPlayPlaying(deviceId: string, streamUrl: string, positionSec: number, durationSec: number): void {
  // ===== 动态 import 避免静态循环依赖(与 reportAirPlayIdle 同款姿势) =====
  import("../player/index.js").then(({ getPlayerController }) => {
    getPlayerController().reportState({
      playerId: `airplay:${deviceId}`,
      playbackState: PlaybackState.PLAYING,
      position: Math.max(0, positionSec),
      duration: Math.max(0, durationSec),
      mediaUri: streamUrl,
      updatedAt: Date.now(),
    });
  }).catch((e) => {
    log.error("reportState PLAYING 上报失败", { deviceId, err: (e as Error)?.message || e });
  });
}

/** 当前曲的取流地址(供 protocolPlayer.pollState 的 mediaUri 用)。
 *  与 DLNA `pollState().mediaUri = GetPositionInfo.TrackURI` 对齐;取自 lastCast
 *  (同一 (songId, deviceId) 的 token 复用,见 session.ts —— 同曲 seek 重投地址不变,
 *  不会误判 track_changed;真换歌 token 必变)。 */
export function getAirPlayMediaUri(deviceId: string): string | undefined {
  return lastCast.get(deviceId)?.streamUrl;
}

/**
 * AirPlay 会话结束统一出口(P0-4 落点,导出供单测):
 * 1) 上报 IDLE(带真实落点,让队列自动续播)—— 仅当该会话**仍是当前会话**;
 * 2) 按 lastCast 取 songId,用解码器 stderr 交 reportPlaybackLoudness
 *    (本地/WebDAV 行入库,网络行丢弃;无 JSON/无曲均为 false)。
 * in-proc 由 runStream finally 调;fork 由子进程 sessionEnded 事件调。
 *
 *  endInfo.current === false(会话已被新起播/显式 stop 取代)→ **抑制**这条过期 IDLE:
 *  它属于上一首,却与新会话共用同一个 playerId,会把刚建立的新曲判成"已结束"。
 */
export async function handleAirplaySessionEnded(
  deviceId: string,
  loudnessStderr = "",
  songIdHint?: string,
  endInfo?: AirplaySessionEndInfo,
): Promise<void> {
  if (endInfo && endInfo.current === false) {
    log.info("airplay 会话已被新会话/显式 stop 取代,抑制过期 IDLE(不上报状态)", { deviceId });
  } else {
    reportAirPlayIdle(deviceId, endInfo?.positionSec ?? 0, endInfo?.durationSec ?? 0);
  }
  try {
    const songId = songIdHint ?? lastCast.get(deviceId)?.songId;
    if (!songId || !loudnessStderr) return;
    const { reportPlaybackLoudness } = await import("../audio/analysisStore.js");
    reportPlaybackLoudness(songId, loudnessStderr);
  } catch { /* 入库失败不影响续播 */ }
}

/** 确保 airplay 子进程在跑(fork 模式)。懒启动兜底:服务启动时的 start 是 fire-and-forget;
 *  in-flight 去重,避免并发投屏各 fork 一个。 */
async function ensureAirplayHost(): Promise<void> {
  if (airplaySupervisor.isRunning()) return;
  hostStarting ??= (async () => {
    airplaySupervisor.setHooks({
      // 子进程把 sessionEnded 的落点与「是否仍是当前会话」一并带回来:current=false
      // 时由 handleAirplaySessionEnded 抑制过期 IDLE(见其注释)。
      onSessionEnded: (deviceId, info) =>
        void handleAirplaySessionEnded(deviceId, info?.loudnessStderr ?? "", undefined, info),
      // Phase 5(§5.2):子进程崩溃重启成功后重建桥路由(原 token 重发 bridgePrepare,
      // 泵侧 BridgeMember 退避重连同 socketPath 即接上,BOUNDARY{rehost} 新 generation)。
      onBridgeChildRestarted: () =>
        void import("../group/protocolPlayer.js")
          .then((m) => m.rebuildBridgeRoutes())
          .catch((err) => log.warn("桥路由重建失败(忽略)", { err: (err as Error)?.message || err })),
    });
    await airplaySupervisor.start();
  })().finally(() => { hostStarting = null; });
  await hostStarting;
}

async function castViaChild(opts: AirPlayCastOptions): Promise<void> {
  const dev = getAirPlayDevice(opts.deviceId);
  if (!dev) throw new Error("AirPlay 设备不在线或未发现");

  // 与 in-proc 起播同一互斥口径(停 SOAP + 冻结 DLNA 队列),见 yieldSiblingDlnaForAirPlay。
  await yieldSiblingDlnaForAirPlay(opts.deviceId);

  const baseUrl = opts.baseUrl || getEffectiveBaseUrl();
  if (!baseUrl) throw new Error("未确定播放流地址(DLNA_BASE_URL 或先进行一次投屏)");
  const streamUrl = opts.streamUrl || createAirPlaySession(opts.songId, opts.deviceId, baseUrl).streamUrl;

  await ensureAirplayHost();
  // 子进程的解码器同样吃**回环管道**(见 toLoopbackAirPlayStreamUrl):子进程不碰 DB,
  // 所以 URL 必须在主进程先换成回环形态。
  const compliantUrl = toLoopbackAirPlayStreamUrl(streamUrl);
  await airplaySupervisor.rpc("cast", {
    deviceId: opts.deviceId,
    host: dev.host,
    port: dev.port,
    pk: dev.pk,
    et: dev.et,
    streamUrl: compliantUrl,
    songId: opts.songId,
    seekSec: opts.seekSec,
    title: opts.title,
    artist: opts.artist,
    album: opts.album,
    durationSec: opts.durationSec,
  });
  lastCast.set(opts.deviceId, {
    songId: opts.songId,
    title: opts.title,
    artist: opts.artist,
    album: opts.album,
    coverArt: opts.coverArt,
    durationSec: opts.durationSec,
    streamUrl,
  });
  // fork 路径同样要**主动**上报 PLAYING:子进程里会话已建立(cast RPC 返回 = RTSP
  // RECORD 完成),但主进程侧会话表是空的 —— 5s 兜底轮询此刻只会读到 IDLE。
  // 与 in-proc 的 runStream 上报同语义,见 reportAirPlayPlaying 的论证。
  reportAirPlayPlaying(opts.deviceId, streamUrl, opts.seekSec ?? 0, opts.durationSec ?? 0);
}

export async function pauseAirPlay(deviceId: string): Promise<void> {
  return withDeviceGate(deviceId, async () => {
    if (isAirPlayForkMode()) {
      try { await airplaySupervisor.rpc("pause", { deviceId }); } catch { /* 子进程没跑 → 无会话 */ }
      return;
    }
    const s = sessions.get(deviceId);
    if (!s) return;
    s.player.pause();
  });
}

export async function resumeAirPlay(deviceId: string): Promise<void> {
  return withDeviceGate(deviceId, async () => {
    if (isAirPlayForkMode()) {
      // 子进程里会话还在(暂停态)→ 直接恢复推进;否则回落到「重播上一首」。
      const resumed = airplaySupervisor.isRunning()
        ? await airplaySupervisor.rpc<boolean>("resume", { deviceId }).catch(() => false)
        : false;
      if (resumed) return;
      const last = lastCast.get(deviceId);
      if (last) await castUnlocked({ ...last, deviceId });
      return;
    }
    const s = sessions.get(deviceId);
    if (s) {
      // Session alive (paused): simply resume pushing chunks.
      s.player.resume();
      return;
    }
    // No session (stopped): replay the last track from the start — mirrors how a
    // DLNA device that was stopped still has a loaded URI and Play restarts it.
    const last = lastCast.get(deviceId);
    if (last) await startSession({ ...last, deviceId }, 0);
  });
}

export async function stopAirPlay(deviceId: string): Promise<void> {
  await withDeviceGate(deviceId, () => stopSession(deviceId));
}

/** Seek the current track to `seconds`.
 *
 *  While a session is live this is an IN-PLACE seek: the RTSP session and RTP
 *  sockets stay up, the receiver's buffer is flushed (RAOP FLUSH), the RTP
 *  clock is re-anchored on the session base (so the reported position starts
 *  at the seek target and keeps climbing — no snap-back-to-0), and only the
 *  ffmpeg decoder is swapped for one that resumes at `-ss seconds`. The hard
 *  gap is just ffmpeg's seek+decode startup instead of a full TEARDOWN →
 *  ANNOUNCE/SETUP/RECORD round trip. No live session → fall back to the old
 *  restart path (e.g. a raw api.seek right after stop). */
export async function seekAirPlay(deviceId: string, seconds: number): Promise<void> {
  // 与 cast/stop 串行:流转刚起播时立刻拖动,seek 必须排在 cast 之后,
  // 而不是与它并发再建一条 RTSP 会话(见 withDeviceGate)。
  return withDeviceGate(deviceId, () => seekUnlocked(deviceId, seconds));
}

async function seekUnlocked(deviceId: string, seconds: number): Promise<void> {
  const t = Math.max(0, seconds);
  // ⚠️ 默认走**完整重建**(2026-10-21 HiVi 真机:原地 seek 的 FLUSH 重锚后设备持续
  // 认为缺包、时间线不推进 ⇒ 拖动后彻底无声)。重建 = TEARDOWN → 新 ANNOUNCE/SETUP/
  // RECORD → 新 seq/rtptime/SSRC,设备行为确定;代价是 ~1.5s 静音。
  // 原地 seek 保留为实验开关(AIRPLAY_SEEK_INPLACE=1),默认不走。
  if (process.env.AIRPLAY_SEEK_INPLACE !== "1") {
    if (isAirPlayForkMode()) {
      const last = lastCast.get(deviceId);
      if (last) await castUnlocked({ ...last, deviceId, seekSec: t });
      return;
    }
    const last = lastCast.get(deviceId);
    if (!last) return;
    await startSession({ ...last, deviceId, seekSec: t }, t);
    return;
  }
  if (isAirPlayForkMode()) {
    // 子进程内原地 seek(RTSP 会话与 RTP socket 不动,只换 decoder);拿不到可原地
    // seek 的会话(无会话 / 已被拆)则回落到「带 seekSec 重投」。
    const inPlace = airplaySupervisor.isRunning()
      ? await airplaySupervisor.rpc<boolean>("seek", { deviceId, seconds: t }).catch(() => false)
      : false;
    if (inPlace) return;
    const last = lastCast.get(deviceId);
    if (last) await castUnlocked({ ...last, deviceId, seekSec: t });
    return;
  }
  const s = sessions.get(deviceId);
  if (!s || s.ended || !s.player.isStreaming) {
    const last = lastCast.get(deviceId);
    if (!last) return;
    await startSession({ ...last, deviceId, seekSec: t }, t);
    return;
  }

  const wasPaused = s.player.isPaused;
  const oldStream = s.streamPromise;

  // Suppress the old stream's finalizer so the RTSP session survives the swap.
  s.seekReplace = true;
  // Stop the old decoder NOW: makes the old producer's waitData unblock so the
  // old stream loop exits promptly instead of waiting out its 30s timeout.
  try {
    killDecoder(s.ffmpeg);
    s.ffmpeg.stdout?.destroy();
    s.ffmpeg.stderr?.destroy();
  } catch { /* ignore */ }

  await s.player.prepareSeek(t).catch(() => {});
  // Wait for the old loop + finalizer (which now runs the seekReplace branch).
  await (oldStream || Promise.resolve()).catch(() => {});

  // The finalizer raced and tore the session down anyway → full restart.
  if (sessions.get(deviceId) !== s) {
    const last = lastCast.get(deviceId);
    if (last) await startSession({ ...last, deviceId, seekSec: t }, t);
    return;
  }

  // 重播输入同样走回环管道(同上:raw 直通会假 EOF/从头重连);回环地址幂等直通。
  // 原地 seek 也要把偏移编进 feed URL(服务端 -ss),绝不在 live FLAC 流上做 -ss。
  s.feedUrl = toLoopbackAirPlayStreamUrl(withPlaybackOffset(s.streamUrl, t));
  s.ffmpeg = spawnDecoder(s.feedUrl, undefined, {
    rowId: lastCast.get(deviceId)?.songId,
  });
  runStream(s, s.session);
  if (wasPaused) s.player.pause();
}

/** Best-effort: find the DLNA device that lives on the same host as an AirPlay
 *  device (HiVi H5MKII is a Linkplay device — it exposes BOTH AirPlay and
 *  DLNA, but its AirPlay RAOP implementation ignores SET_PARAMETER volume while
 *  its DLNA RenderingControl SetVolume works). Returns the DLNA device id when
 *  found on the same IP, preferring one that actually supports volume control
 *  (same IP may host several UPnP devices, e.g. media servers without a
 *  RenderingControl service). */
function dlnaPeerOfAirPlay(deviceId: string): string | undefined {
  const ap = getAirPlayDevice(deviceId);
  if (!ap?.host) return undefined;
  const apHost = ap.host.toLowerCase();
  const sameHost = (d: { location: string }): boolean => {
    try {
      const dHost = new URL(d.location).hostname.toLowerCase();
      return dHost === apHost;
    } catch {
      return false;
    }
  };
  let fallback: string | undefined;
  for (const d of getCachedDevices()) {
    if (!sameHost(d)) continue;
    // Prefer a renderer with an actual volume-control endpoint.
    if (d.renderingControlUrl) return d.id;
    if (!fallback) fallback = d.id;
  }
  return fallback;
}

export async function setAirPlayVolume(deviceId: string, volume: number): Promise<void> {
  const vol = Math.max(0, Math.min(100, Math.round(volume)));
  const st = volumeStateOf(deviceId, false);
  st.volume = vol;
  volumeState.set(deviceId, st);
  // 先落库再下发:即使设备侧转发失败(离线/超时),用户这次设置也不会丢,
  // 重启后仍按这个值回吐,不会被缺省值顶掉。
  saveAirPlayVolumeState(deviceId, { volume: vol });

  // Linkplay receivers ignore AirPlay SET_PARAMETER volume; forward through the
  // sibling DLNA RenderingControl channel (same physical device) which applies
  // real volume. Fall back to RAOP SET_PARAMETER when no DLNA peer is found.
  const dlnaPeer = dlnaPeerOfAirPlay(deviceId);
  if (dlnaPeer) {
    try {
      await setDeviceVolume(dlnaPeer, vol);
      log.info(`volume ${vol} forwarded to DLNA device ${dlnaPeer} (same host)`);
      return;
    } catch (e) {
      log.warn(`DLNA volume forward failed (${(e as Error)?.message}), falling back to SET_PARAMETER`);
    }
  }

  const dev = getAirPlayDevice(deviceId);
  if (dev) st.supportsRsa = dev.supportsRsa;
  applyVolumeDb(deviceId, st.muted || st.volume === 0 ? -144 : degreesToDb(st.volume));
}

export async function setAirPlayMuted(deviceId: string, muted: boolean): Promise<void> {
  const st = volumeStateOf(deviceId, false);
  st.muted = muted;
  volumeState.set(deviceId, st);
  // 只写 muted:volume 字段保持原值 —— 取消静音必须恢复静音前的音量,而不是 0。
  saveAirPlayVolumeState(deviceId, { muted });
  const dlnaPeer = dlnaPeerOfAirPlay(deviceId);
  if (dlnaPeer) {
    try {
      await setDeviceMute(dlnaPeer, muted);
      log.info(`mute=${muted} forwarded to DLNA device ${dlnaPeer}`);
      return;
    } catch (e) {
      log.warn(`DLNA mute forward failed (${(e as Error)?.message}), falling back to SET_PARAMETER`);
    }
  }
  applyVolumeDb(deviceId, muted || st.volume === 0 ? -144 : degreesToDb(st.volume));
}

/** RAOP SET_PARAMETER 音量回落:fork 走 RPC(子进程内写自己的 RaopPlayer);
 *  in-proc 直接写本地会话。DLNA 同 host 转发成功时不会走到这里。 */
function applyVolumeDb(deviceId: string, db: number): void {
  if (isAirPlayForkMode()) {
    if (airplaySupervisor.isRunning()) rpcFireAndForget(airplaySupervisor, "setVolumeDb", { deviceId, db });
    return;
  }
  const s = sessions.get(deviceId);
  if (s) s.player.setVolumeDb(db);
}

/** 会话态的统一读取视图:in-proc 读本地会话对象;fork 读子进程镜像。
 *  **同步**可读 —— getAirPlayStatus 会被 QC 每 5s、DLNA announce 每 500ms 调用,
 *  绝不能每次都打一次 IPC。 */
interface SessionView {
  ended: boolean;
  paused: boolean;
  positionSec: number;
  durationSec: number;
  title?: string;
  artist?: string;
  album?: string;
  stream?: RaopRealtimeStats;
}

function sessionView(deviceId: string): SessionView | null {
  if (isAirPlayForkMode()) {
    const r = airplaySupervisor.mirror.sessions.get(deviceId);
    if (!r) return null;
    return {
      ended: r.ended,
      paused: r.playbackState === "paused",
      positionSec: r.positionSec,
      durationSec: r.durationSec,
      title: r.title,
      artist: r.artist,
      album: r.album,
      stream: r.stream,
    };
  }
  const s = sessions.get(deviceId);
  if (!s) return null;
  return {
    ended: s.ended,
    paused: s.player.isPaused,
    positionSec: Math.max(0, s.player.positionSec),
    durationSec: s.duration || s.player.durationSec,
    title: s.title,
    artist: s.artist,
    album: s.album,
    stream: s.player.realtimeStats ?? undefined,
  };
}

export function getAirPlayStatus(deviceId: string): AirPlayDeviceStatus {
  const dev = getAirPlayDevice(deviceId);
  const s = sessionView(deviceId);
  // 重启后 volumeState 为空:这里必须回持久值(而不是写死 80),否则 /status
  // 会把缺省音量当成权威告诉所有客户端,重连回推就变成「强制音量」。
  const vol = volumeStateOf(deviceId, !!dev?.supportsRsa);
  if (!s || s.ended) {
    return {
      available: !!dev?.available,
      name: dev?.name || deviceId,
      playbackState: PlaybackState.IDLE,
      position: 0,
      duration: 0,
      title: lastCast.get(deviceId)?.title,
      artist: lastCast.get(deviceId)?.artist,
      album: lastCast.get(deviceId)?.album,
      volume: vol.volume,
      muted: vol.muted,
      supportsRsa: !!dev?.supportsRsa,
      updatedAt: Date.now(),
    };
  }
  const state = s.paused ? PlaybackState.PAUSED : PlaybackState.PLAYING;
  return {
    available: !!dev?.available,
    name: dev?.name || deviceId,
    playbackState: state,
    position: s.positionSec,
    duration: s.durationSec,
    title: s.title,
    artist: s.artist,
    album: s.album,
    volume: vol.volume,
    muted: vol.muted,
    supportsRsa: !!dev?.supportsRsa,
    updatedAt: Date.now(),
    // 可观测指标:播放中随时可读,不必等 stream() 收尾那一行日志。
    stream: s.stream,
  };
}

/** Status in the unified peer-status shape (used by GET /v1/peers/:peerId/status).
 *  Every field the Web client / HA reads for dlna peers is mirrored here. */
export function getAirPlayPeerStatus(deviceId: string): {
  state: string; position: number; duration: number; volume: number; muted: boolean;
  updatedAt: number; trackUri: string;
  media?: { songId: string; title?: string; artist?: string; album?: string; coverArt?: string };
  /** 推流节拍健康度(可观测指标);无活跃推流时不返回。 */
  stream?: RaopRealtimeStats;
} {
  const s = getAirPlayStatus(deviceId);
  const last = lastCast.get(deviceId);
  return {
    state: s.playbackState,
    position: s.position,
    duration: s.duration,
    volume: s.volume,
    muted: s.muted,
    updatedAt: Date.now(),
    trackUri: last?.streamUrl || "",
    stream: s.stream,
    media: last ? {
      songId: last.songId,
      title: last.title,
      artist: last.artist,
      album: last.album,
      coverArt: last.coverArt,
    } : undefined,
  };
}

/** Start discovery + device event wiring. Call once at boot (or when the
 *  AirPlay renderer plugin is toggled on). Idempotent. */
export function startAirPlayService(): void {
  airPlayServiceActive = true;
  startAirPlayDiscovery();
  onAirPlayEvent((e) => {
    if (e.type === "byebye") {
      // Phase 5(§5.2 桥设备离线):桥占用设备**不等重连** —— 立刻从全部活跃桥
      // 路由摘除(bridgeStop + 清 owner,标 offline);设备重新上线按「加入」处理。
      if (isBridgeOwned(e.id)) {
        void import("../group/protocolPlayer.js")
          .then((m) => m.notifyAirplayDeviceOffline(e.id))
          .catch((err) => log.warn("桥设备离线摘除失败(忽略)", { deviceId: e.id, err: (err as Error)?.message || err }));
        return;
      }
      // Device vanished → force-stop any active session.
      if (hasActiveSession(e.id)) void stopAirPlaySession(e.id);
    }
  });
  // 主进程重启残留清理(§5.2):清扫无 listener 的陈旧 mfab socket(fire-and-forget)。
  void import("./bridgeChannel.js")
    .then((m) => m.cleanupStaleBridgeSockets())
    .then((n) => { if (n > 0) log.info(`mfab 残留 socket 清理: ${n} 个`); })
    .catch(() => { /* 清理失败不拖垮启动 */ });
  // fork 模式:顺带把推流子进程拉起来(不阻塞启动流程;投屏时还有懒启动兜底)。
  if (isAirPlayForkMode()) {
    void ensureAirplayHost().catch((err) => log.error("airplay 子进程启动失败", { err: (err as Error)?.message || err }));
  }
}

/** AirPlay renderer 插件是否启用(plugins 表 airplay-renderer 行)。 */
export function isAirPlayEnabled(): boolean {
  try {
    const row = sqlite.prepare("SELECT enabled FROM plugins WHERE name = 'airplay-renderer'").get() as any;
    return !!row?.enabled;
  } catch {
    return false;
  }
}

/** 关闭 AirPlay:停 mDNS + 停全部会话 + 清内存态 + 移除 peer + 注销 player。
 *  目标是零常驻资源(无网络监听/无定时器/无会话/无 peer/无 player 注册)。幂等。
 *  由插件管理页关闭 airplay-renderer 或启动时未启用时调用。 */
export async function stopAirPlayService(): Promise<void> {
  // 0. fork 模式:先停推流子进程(其 stop 语义 = 停全部会话 + TEARDOWN + kill ffmpeg;
  //    子进程 onStop 亦会停全部桥会话)。owner 登记一并清空(服务级终态)。
  if (isAirPlayForkMode()) {
    try { await airplaySupervisor.stop(); } catch { /* ignore */ }
  }
  bridgeOwners.clear();
  // 1. 停掉全部活跃会话(RAOP TEARDOWN + ffmpeg kill),释放音频资源。
  const activeIds = Array.from(sessions.keys());
  for (const id of activeIds) {
    try { await stopAirPlaySession(id); } catch { /* ignore */ }
  }
  // 2. 清内存态(音量/最近投屏/设备列表)。库值**保留**:重新启用后仍恢复到
  //    用户上次设置;停用期间 volumeStateOf 不读库,读取回落到缺省值。
  airPlayServiceActive = false;
  volumeState.clear();
  lastCast.clear();
  // 3. 移除 peer(动态 import 避免循环依赖: peer → airplay/control)。
  try {
    const { getPeerManager } = await import("../peer.js");
    getPeerManager().removeAirPlayPeers();
  } catch { /* ignore */ }
  // 4. 注销 QueueController 的 airplay player 与队列。
  try {
    const { getQueueController } = await import("../player/index.js");
    getQueueController().unregisterAirPlayDevices();
  } catch { /* ignore */ }
  // 5. 停 mDNS(释放 socket + 定时器)并清空设备内存列表。
  stopAirPlayDiscovery();
  for (const d of Array.from(getAirPlayDevices())) {
    try { removeAirPlayDevice(d.id); } catch { /* ignore */ }
  }
  log.info("AirPlay 服务已关闭(零常驻资源)");
}