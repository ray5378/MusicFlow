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
import { PlaybackState } from "../player/types.js";
import { RaopPlayer, type RaopSession, type RaopRealtimeStats } from "./raop.js";
import { makeProducer, spawnDecoder, degreesToDb } from "./decoder.js";
import { isAirPlayForkMode } from "./mode.js";
import { airplaySupervisor } from "./supervisor.js";
import { rpcFireAndForget } from "../rendererHost/front.js";
import { getAirPlayDevice, getAirPlayDevices, onAirPlayEvent, startAirPlayDiscovery, stopAirPlayDiscovery, setAirPlayPersist, removeAirPlayDevice, type AirPlayDevice } from "./discovery.js";
import { createCastSession, getEffectiveBaseUrl, getCachedDevices, setDeviceVolume, setDeviceMute, stopDevicePlayback } from "../dlna/control.js";
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";

// 解码/缓冲层(ffmpeg spawn + 有界 PCM 队列 + 音量 dB 换算)已抽到 ./decoder.ts ——
// airplay 子进程要复用同一份实现,但不能经由本模块(会拖进 DB/DLNA/peer 等主进程态)。
// re-export 保持既有引用可见(tests/services/airplayProducer.test.ts 从本模块导入)。
export { makeProducer } from "./decoder.js";

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
  streamUrl: string;
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
const lastCast = new Map<string, { songId: string; title?: string; artist?: string; album?: string; coverArt?: string; durationSec?: number; streamUrl: string }>();

/** 该设备是否有活跃推流会话(fork 看子进程镜像的会话表;in-proc 看本地 sessions)。 */
function hasActiveSession(deviceId: string): boolean {
  if (isAirPlayForkMode()) return airplaySupervisor.mirror.sessions.has(deviceId);
  return sessions.has(deviceId);
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
  sessions.delete(deviceId);
  s.ended = true;
  try { s.ffmpeg?.kill(); } catch { /* ignore */ }
  await s.player.stop().catch(() => {});
}

/** 双协议互斥:停止与指定 host 同址的 AirPlay 会话(RAOP TEARDOWN)。
 *  DLNA cast 前调用——Linkplay/HiVi 类设备音频输入互斥,残留 AirPlay 会话
 *  会占用音频通道导致 DLNA 无声。返回被停止的会话 deviceId 列表。 */
export async function stopAirPlaySessionsForHost(host: string): Promise<string[]> {
  const stopped: string[] = [];
  if (!host) return stopped;
  const h = host.toLowerCase();
  for (const d of getAirPlayDevices()) {
    if (d.host && d.host.toLowerCase() === h && hasActiveSession(d.id)) {
      await stopSession(d.id);
      stopped.push(d.id);
    }
  }
  if (stopped.length) {
    log.info("双协议互斥:DLNA 播放前停止同 host AirPlay 会话", { host: h, stopped });
  }
  return stopped;
}

/** Stop an active AirPlay session (used by device management: delete/disable). */
export async function stopAirPlaySession(deviceId: string): Promise<void> {
  await stopSession(deviceId);
}

async function startSession(opts: AirPlayCastOptions, seekSec?: number): Promise<void> {
  const dev = getAirPlayDevice(opts.deviceId);
  if (!dev) throw new Error("AirPlay 设备不在线或未发现");

  // ===== 双协议互斥(同 host 的 DLNA 播放先行停止) =====
  // Linkplay/HiVi 类设备同时暴露 DLNA + AirPlay,音频输入互斥:若 DLNA 正在播放,
  // AirPlay RAOP 起播会被设备输入抢占逻辑干扰(或设备停在 DLNA 通道 → 无声)。
  // 复用已有 dlnaPeerOfAirPlay(同 host 优先带 RenderingControl 的 DLNA renderer)。
  const dlnaPeer = dlnaPeerOfAirPlay(opts.deviceId);
  if (dlnaPeer) {
    try {
      await stopDevicePlayback(dlnaPeer);
      log.info("双协议互斥:AirPlay 起播前停止同 host DLNA 播放", { deviceId: opts.deviceId, dlnaPeer });
    } catch (e) {
      log.warn("双协议互斥:停止同 host DLNA 播放失败(忽略)", { deviceId: opts.deviceId, err: (e as Error)?.message || e });
    }
  }

  await stopSession(opts.deviceId);

  const baseUrl = opts.baseUrl || getEffectiveBaseUrl();
  if (!baseUrl) throw new Error("未确定播放流地址(DLNA_BASE_URL 或先进行一次投屏)");
  const streamUrl = opts.streamUrl || createCastSession(opts.songId, opts.deviceId, baseUrl).streamUrl;

  const player = new RaopPlayer({ host: dev.host, port: dev.port, pk: dev.pk, et: dev.et });
  let session: RaopSession;
  try {
    session = await player.connect();
  } catch (e) {
    player.stop().catch(() => {});
    throw e;
  }

  const ff = spawnDecoder(streamUrl, seekSec);
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
 *     concurrent sessions (multiple timing loops) that interfere and stutter —
 *     then report IDLE to the PlayerController so QueueController auto-advances
 *     without waiting for the 5s fallback poll. The single IDLE is fine: a
 *     stop by QueueController resets tracker first, so no false ended.
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
        try { ff.kill(); } catch { /* ignore */ }
        return;
      }
      if (sessions.get(active.deviceId) === active) {
        sessions.delete(active.deviceId);
      }
      try { ff.kill(); } catch { /* ignore */ }
      // 会话自然结束(整首播完 / 失败)也必须拆掉 RTP socket 并发 TEARDOWN,
      // 否则 socket 泄漏,设备同时维护多个并发会话(多个 timing 循环),互相干扰导致卡顿。
      active.player.stop().catch(() => {});
      // 会话结束(整首播完 / 中途失败 / 被 stop):立即向 PlayerController 上报 IDLE。
      // 等效于 DLNA 的 GENA 事件 —— 让 QueueController 无需等下一次 5s fallback poll
      // 就能感知"这首已结束"并自动切下一首(接近无缝续播)。
      // ===== 注意用动态 import 避免静态循环依赖 =====
      import("../player/index.js").then(({ getPlayerController }) => {
        getPlayerController().reportState({
          playerId: `airplay:${active.deviceId}`,
          playbackState: PlaybackState.IDLE,
          position: 0,
          duration: 0,
          updatedAt: Date.now(),
        });
      }).catch((e) => {
        log.error("reportState IDLE 上报失败", { deviceId: active.deviceId, err: (e as Error)?.message || e });
      });
    });
  active.streamPromise = p;
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

// ==================== Public API ====================

export function listAirPlayDevices(): {
  id: string; name: string; alias: string; displayName: string;
  available: boolean; disabled: boolean; supportsRsa: boolean; am?: string; host: string; port: number;
}[] {
  return getAirPlayDevices().map((d) => ({
    id: d.id, name: d.name, alias: d.alias || "",
    displayName: (d.alias || d.name).trim(),
    available: d.available, disabled: !!d.disabled,
    supportsRsa: d.supportsRsa, am: d.am, host: d.host, port: d.port,
  }));
}

export function hasAirPlayDevice(deviceId: string): boolean {
  return !!getAirPlayDevice(deviceId);
}

/** Cast a track to an AirPlay device and start playing it. */
export async function castToAirPlayDevice(opts: AirPlayCastOptions): Promise<{ mediaUri: string }> {
  if (isAirPlayDeviceDisabled(opts.deviceId)) {
    throw new Error("该 AirPlay 设备已被禁用");
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
 *  fork 模式下由子进程的 sessionEnded 事件触发。 */
function reportAirPlayIdle(deviceId: string): void {
  // ===== 注意用动态 import 避免静态循环依赖 =====
  import("../player/index.js").then(({ getPlayerController }) => {
    getPlayerController().reportState({
      playerId: `airplay:${deviceId}`,
      playbackState: PlaybackState.IDLE,
      position: 0,
      duration: 0,
      updatedAt: Date.now(),
    });
  }).catch((e) => {
    log.error("reportState IDLE 上报失败", { deviceId, err: (e as Error)?.message || e });
  });
}

/** 确保 airplay 子进程在跑(fork 模式)。懒启动兜底:服务启动时的 start 是 fire-and-forget;
 *  in-flight 去重,避免并发投屏各 fork 一个。 */
async function ensureAirplayHost(): Promise<void> {
  if (airplaySupervisor.isRunning()) return;
  hostStarting ??= (async () => {
    airplaySupervisor.setHooks({
      onSessionEnded: (deviceId) => reportAirPlayIdle(deviceId),
    });
    await airplaySupervisor.start();
  })().finally(() => { hostStarting = null; });
  await hostStarting;
}

async function castViaChild(opts: AirPlayCastOptions): Promise<void> {
  const dev = getAirPlayDevice(opts.deviceId);
  if (!dev) throw new Error("AirPlay 设备不在线或未发现");

  const dlnaPeer = dlnaPeerOfAirPlay(opts.deviceId);
  if (dlnaPeer) {
    try {
      await stopDevicePlayback(dlnaPeer);
      log.info("双协议互斥:AirPlay 起播前停止同 host DLNA 播放", { deviceId: opts.deviceId, dlnaPeer });
    } catch (e) {
      log.warn("双协议互斥:停止同 host DLNA 播放失败(忽略)", { deviceId: opts.deviceId, err: (e as Error)?.message || e });
    }
  }

  const baseUrl = opts.baseUrl || getEffectiveBaseUrl();
  if (!baseUrl) throw new Error("未确定播放流地址(DLNA_BASE_URL 或先进行一次投屏)");
  const streamUrl = opts.streamUrl || createCastSession(opts.songId, opts.deviceId, baseUrl).streamUrl;

  await ensureAirplayHost();
  await airplaySupervisor.rpc("cast", {
    deviceId: opts.deviceId,
    host: dev.host,
    port: dev.port,
    pk: dev.pk,
    et: dev.et,
    streamUrl,
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
}

export async function pauseAirPlay(deviceId: string): Promise<void> {
  if (isAirPlayForkMode()) {
    try { await airplaySupervisor.rpc("pause", { deviceId }); } catch { /* 子进程没跑 → 无会话 */ }
    return;
  }
  const s = sessions.get(deviceId);
  if (!s) return;
  s.player.pause();
}

export async function resumeAirPlay(deviceId: string): Promise<void> {
  if (isAirPlayForkMode()) {
    // 子进程里会话还在(暂停态)→ 直接恢复推进;否则回落到「重播上一首」。
    const resumed = airplaySupervisor.isRunning()
      ? await airplaySupervisor.rpc<boolean>("resume", { deviceId }).catch(() => false)
      : false;
    if (resumed) return;
    const last = lastCast.get(deviceId);
    if (last) await castToAirPlayDevice({ ...last, deviceId });
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
}

export async function stopAirPlay(deviceId: string): Promise<void> {
  await stopSession(deviceId);
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
  const t = Math.max(0, seconds);
  if (isAirPlayForkMode()) {
    // 子进程内原地 seek(RTSP 会话与 RTP socket 不动,只换 decoder);拿不到可原地
    // seek 的会话(无会话 / 已被拆)则回落到「带 seekSec 重投」。
    const inPlace = airplaySupervisor.isRunning()
      ? await airplaySupervisor.rpc<boolean>("seek", { deviceId, seconds: t }).catch(() => false)
      : false;
    if (inPlace) return;
    const last = lastCast.get(deviceId);
    if (last) await castToAirPlayDevice({ ...last, deviceId, seekSec: t });
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
    s.ffmpeg.kill();
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

  s.ffmpeg = spawnDecoder(s.streamUrl, t);
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
  const st = volumeState.get(deviceId) || { volume: 80, muted: false, supportsRsa: false };
  st.volume = vol;
  volumeState.set(deviceId, st);

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
  const st = volumeState.get(deviceId) || { volume: 80, muted: false, supportsRsa: false };
  st.muted = muted;
  volumeState.set(deviceId, st);
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
  const vol = volumeState.get(deviceId) || { volume: 80, muted: false, supportsRsa: !!dev?.supportsRsa };
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
  startAirPlayDiscovery();
  onAirPlayEvent((e) => {
    if (e.type === "byebye") {
      // Device vanished → force-stop any active session.
      if (hasActiveSession(e.id)) void stopSession(e.id);
    }
  });
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
  // 0. fork 模式:先停推流子进程(其 stop 语义 = 停全部会话 + TEARDOWN + kill ffmpeg)。
  if (isAirPlayForkMode()) {
    try { await airplaySupervisor.stop(); } catch { /* ignore */ }
  }
  // 1. 停掉全部活跃会话(RAOP TEARDOWN + ffmpeg kill),释放音频资源。
  const activeIds = Array.from(sessions.keys());
  for (const id of activeIds) {
    try { await stopSession(id); } catch { /* ignore */ }
  }
  // 2. 清内存态(音量/最近投屏/设备列表)。
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