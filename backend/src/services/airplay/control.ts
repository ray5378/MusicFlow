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
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createRequire } from "module";
import { PlaybackState } from "../player/types.js";
import { RaopPlayer, type RaopSession, PCM_BYTES_PER_CHUNK, SAMPLE_RATE } from "./raop.js";
import { getAirPlayDevice, getAirPlayDevices, onAirPlayEvent, startAirPlayDiscovery, setAirPlayPersist, type AirPlayDevice } from "./discovery.js";
import { createCastSession, getEffectiveBaseUrl, getCachedDevices, setDeviceVolume, setDeviceMute, stopDevicePlayback } from "../dlna/control.js";
import { sqlite } from "../../db/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AIRPLAY");

// Jitter buffer (Music Assistant style): decode as fast as possible into a
// buffer, then let the RAOP sender pull *paced* chunks on a real-time clock.
// The prefill guarantees a few seconds of audio ahead of the sender, so short
// decode/network stalls (cloud WebDAV, ffmpeg startup) never starve the
// receiver's ~250ms RAOP buffer. The old loop (`sleep(7ms)` per 7.98ms chunk
// inside the producer) had NO read-ahead and ran slightly slower than realtime
// → the device buffer slowly drained → audible stutter.
const PREFILL_MS = 1500; // target decoded-audio lead before the first packet
const PREFILL_BYTES = Math.round((PREFILL_MS / 1000) * SAMPLE_RATE * 2 * 2); // 44100×16bit stereo

// Upper bound for the decoded-PCM read-ahead queue. ffmpeg decodes at max
// speed, so WITHOUT a cap the producer buffers the ENTIRE track in memory
// (34MB for a 193s song, ~1.2GB for a 2h one) and plays it out over minutes.
// Instead we apply backpressure: once buffered PCM crosses MAX_BUFFER_BYTES we
// pause ffmpeg's stdout (it then blocks inside the pipe write), and resume as
// soon as it drains below the low-water mark. Cap ≈ 10s of audio (176.4KB/s),
// which still rides out long stalls without stutter while keeping memory small.
const MAX_BUFFER_MS = 10_000;
const MAX_BUFFER_BYTES = Math.round((MAX_BUFFER_MS / 1000) * SAMPLE_RATE * 2 * 2); // 176400 B/s × 10s
const RESUME_BUFFER_BYTES = Math.round(MAX_BUFFER_BYTES / 2);

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

const sessions = new Map<string, ActiveSession>();
const volumeState = new Map<string, { volume: number; muted: boolean; supportsRsa: boolean }>();
const lastCast = new Map<string, { songId: string; title?: string; artist?: string; album?: string; coverArt?: string; durationSec?: number; streamUrl: string }>();

function degreesToDb(volume: number): number {
  const v = Math.max(0, Math.min(100, volume));
  if (v <= 0) return -144;
  return -30 + (v / 100) * 30; // 0→-30dB … 100→0dB
}

const require_ = createRequire(import.meta.url);

function ffmpegBin(): string {
  try {
    const p = require_("ffmpeg-static") as string | undefined;
    if (p) return p;
  } catch {
    /* not installed — fall back to PATH */
  }
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/** Spawn ffmpeg decoding `url` to raw stereo s16le 44100 PCM on stdout. */
function spawnDecoder(url: string, seekSec?: number): ChildProcessWithoutNullStreams {
  const args = ["-loglevel", "error", "-hide_banner"];
  if (seekSec && seekSec > 0) args.push("-ss", String(seekSec));
  args.push("-i", url, "-f", "s16le", "-ac", "2", "-ar", String(SAMPLE_RATE), "pipe:1");
  const ff = spawn(ffmpegBin(), args);
  let errBuf = "";
  ff.stderr.on("data", (d: Buffer) => {
    errBuf += d.toString();
    if (errBuf.length > 4096) errBuf = errBuf.slice(-4096);
  });
  ff.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      log.info(`ffmpeg exit code=${code} signal=${signal} stderr=${errBuf.slice(0, 800)}`);
    }
  });
  return ff;
}

/** Build a buffered PCM producer around an ffmpeg decoder.
 *
 *  The producer is *not* paced: it decodes as fast as ffmpeg can and returns a
 *  1408-byte chunk as soon as one is available (resolving on the next stdout
 *  data event, not an 8ms poll). Real-time pacing happens in RaopPlayer.stream()
 *  against the wall clock; the `PREFILL_MS` lead is what absorbs jitter.
 *
 *  Buffering uses an efficient chunk queue: stdout is sliced into fixed
 *  1408-byte chunks right away (O(1) subarray + one small copy each) and pulled
 *  from the front. A single growing `Buffer.concat` accumulator would re-copy
 *  the entire buffered PCM on *every* data event — once decode blasts ahead of
 *  realtime (a fast cloud source decodes a whole track in seconds) that turns
 *  into dozens of MB of copies per second and multi-hundred-ms GC pauses that
 *  stall the sender and make the receiver stutter. */
export function makeProducer(ff: ChildProcessWithoutNullStreams): () => Promise<Buffer | null> {
  const ready: Buffer[] = [];
  let carry = Buffer.alloc(0); // <1408B remainder awaiting the next data event
  let readIdx = 0;
  let ended = false;
  let done = false;
  let prefilled = false;
  let wake: (() => void) | null = null;
  let totalBytes = 0;

  const bufferedBytes = (): number =>
    (ready.length - readIdx) * PCM_BYTES_PER_CHUNK + carry.length;

  ff.stdout.on("data", (d0: Buffer) => {
    totalBytes += d0.length;
    let d = d0;
    if (carry.length) {
      const need = PCM_BYTES_PER_CHUNK - carry.length;
      if (d.length >= need) {
        ready.push(Buffer.from(Buffer.concat([carry, d.subarray(0, need)])));
        d = d.subarray(need);
        carry = Buffer.alloc(0);
      } else {
        carry = Buffer.concat([carry, d]);
        d = Buffer.alloc(0);
      }
    }
    while (d.length >= PCM_BYTES_PER_CHUNK) {
      ready.push(Buffer.from(d.subarray(0, PCM_BYTES_PER_CHUNK)));
      d = d.subarray(PCM_BYTES_PER_CHUNK);
    }
    if ((d as Buffer).length) carry = Buffer.from(d as Buffer);
    if (wake) { const w = wake; wake = null; w(); }
    // Backpressure: stop pulling from ffmpeg before the buffered PCM grows past
    // MAX_BUFFER_BYTES. pause() stops our 'data' events, the pipe fills up and
    // ffmpeg blocks on its write — zero data lost, no audio skipped, and memory
    // stays bounded to ~10s instead of an entire track.
    if (!ended && bufferedBytes() >= MAX_BUFFER_BYTES) ff.stdout.pause();
  });
  ff.stdout.on("end", () => { ended = true; log.info(`producer stdout end: totalBytes=${totalBytes} (${(totalBytes / (SAMPLE_RATE * 4)).toFixed(1)}s audio)`); if (wake) { const w = wake; wake = null; w(); } });
  ff.on("exit", (code, signal) => { ended = true; log.info(`producer ffmpeg exit code=${code} signal=${signal} totalBytes=${totalBytes}`); if (wake) { const w = wake; wake = null; w(); } });

  const waitData = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      // Only resolve on the next stdout chunk (or stream end). Early-resolving
      // on buffer fullness here would busy-spin the prefill loop (every call
      // returns immediately once ≥1 chunk is buffered, before ffmpeg's data
      // events ever get a chance to run → 100% CPU stall).
      if (ended) return resolve(true);
      const t = setTimeout(() => { wake = null; resolve(false); }, timeoutMs);
      wake = () => { clearTimeout(t); resolve(true); };
    });

  const nextChunk = (): Buffer | null => {
    if (readIdx < ready.length) {
      const c = ready[readIdx];
      ready[readIdx] = (null as unknown) as Buffer;
      readIdx++;
      // Compact the consumed head periodically to avoid an ever-growing array.
      if (readIdx > 2048 && readIdx * 2 > ready.length) {
        ready.splice(0, readIdx);
        readIdx = 0;
      }
      return c;
    }
    // consume the partial tail only when the stream has ended
    if (ended && carry.length) {
      const tail = carry;
      carry = Buffer.alloc(0);
      return tail;
    }
    return null;
  };

  // Resume ffmpeg once the buffered PCM has drained below the low-water mark
  // (half the cap). Called on every pull so backpressure never dead-locks: pause
  // only kicks in while the queue is at/above the cap, and every consumed chunk
  // is an opportunity to restart the pipe.
  const maybeResume = (): void => {
    if (ff.stdout.isPaused() && bufferedBytes() <= RESUME_BUFFER_BYTES) ff.stdout.resume();
  };

  return async (): Promise<Buffer | null> => {
    if (done) return null;
    maybeResume();
    if (!prefilled) {
      // First pull: wait until enough decoded audio is buffered to ride out
      // short stalls (decode start, WebDAV hiccup) without an audible gap.
      while (!ended && bufferedBytes() < PREFILL_BYTES) {
        const ok = await waitData(30000);
        if (!ok) { done = true; return null; }
      }
      prefilled = true;
    }
    const c = nextChunk();
    if (c) return c;
    if (!ended) {
      if (!(await waitData(30000))) { done = true; return null; }
      maybeResume();
      const c2 = nextChunk();
      if (c2) return c2;
    }
    done = true;
    return null;
  };
}

async function stopSession(deviceId: string): Promise<void> {
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
    if (d.host && d.host.toLowerCase() === h && sessions.has(d.id)) {
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
  const producer = makeProducer(ff);
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
  await startSession(opts, opts.seekSec);
  return { mediaUri: opts.streamUrl || "" };
}

export async function pauseAirPlay(deviceId: string): Promise<void> {
  const s = sessions.get(deviceId);
  if (!s) return;
  s.player.pause();
}

export async function resumeAirPlay(deviceId: string): Promise<void> {
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
  const s = sessions.get(deviceId);
  if (s) {
    const db = st.muted || st.volume === 0 ? -144 : degreesToDb(st.volume);
    s.player.setVolumeDb(db);
  }
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
  const s = sessions.get(deviceId);
  if (s) {
    const db = muted || st.volume === 0 ? -144 : degreesToDb(st.volume);
    s.player.setVolumeDb(db);
  }
}

export function getAirPlayStatus(deviceId: string): AirPlayDeviceStatus {
  const dev = getAirPlayDevice(deviceId);
  const s = sessions.get(deviceId);
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
  const state = s.player.isPaused ? PlaybackState.PAUSED : PlaybackState.PLAYING;
  return {
    available: !!dev?.available,
    name: dev?.name || deviceId,
    playbackState: state,
    position: Math.max(0, s.player.positionSec),
    duration: s.duration || s.player.durationSec,
    title: s.title,
    artist: s.artist,
    album: s.album,
    volume: vol.volume,
    muted: vol.muted,
    supportsRsa: !!dev?.supportsRsa,
    updatedAt: Date.now(),
  };
}

/** Status in the unified peer-status shape (used by GET /v1/peers/:peerId/status).
 *  Every field the Web client / HA reads for dlna peers is mirrored here. */
export function getAirPlayPeerStatus(deviceId: string): {
  state: string; position: number; duration: number; volume: number; muted: boolean;
  updatedAt: number; trackUri: string;
  media?: { songId: string; title?: string; artist?: string; album?: string; coverArt?: string };
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
    media: last ? {
      songId: last.songId,
      title: last.title,
      artist: last.artist,
      album: last.album,
      coverArt: last.coverArt,
    } : undefined,
  };
}

/** Start discovery + device event wiring. Call once at boot. */
export function startAirPlayService(): void {
  startAirPlayDiscovery();
  onAirPlayEvent((e) => {
    if (e.type === "byebye") {
      // Device vanished → force-stop any active session.
      const s = sessions.get(e.id);
      if (s) void stopSession(e.id);
    }
  });
}