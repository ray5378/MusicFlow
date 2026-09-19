// ==================== AirPlay 会话运行时(纯推流,零主进程态) ====================
//
// 从 control.ts 的 sessions / startSession / runStream / stopSession / seek 搬来,
// **剥掉了所有主进程态依赖**:DB 设备记录、DLNA 双协议互斥、createCastSession
// (token 化 streamUrl)、peer 注册、QueueController/PlayerController 编排。
//
// 输入只剩「设备连接参数 + 已 token 化的 streamUrl + 元数据」——由主进程取好传进来;
// 输出只剩「会话态快照 + sessionEnded 事件」——主进程据此上报 IDLE、维护 lastCast。
// 于是本模块可以整体跑在 rendererHost 的常驻子进程里:RAOP 的 7.98ms 墙钟节拍
// 不再与 Web 请求、封面渲染、后台批量任务争抢主进程事件循环。
import type { ChildProcessWithoutNullStreams } from "child_process";
import { RaopPlayer, type RaopSession, type RaopRealtimeStats } from "./raop.js";
import { spawnDecoder, makeProducer } from "./decoder.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AIRPLAY");

/** 节拍健康度打点周期;以及「单次发包间隔」告警阈值(节拍 ≈7.98ms,超 50ms 即明显被拖)。 */
const HEALTH_LOG_INTERVAL_MS = 15_000;
const HEALTH_WARN_GAP_MS = 50;

/** 镜像给主进程的会话态(读侧只用这些字段,够 getAirPlayStatus/peerStatus 用)。 */
export interface AirplaySessionMirrorRow {
  deviceId: string;
  playbackState: "playing" | "paused" | "idle";
  positionSec: number;
  durationSec: number;
  ended: boolean;
  title?: string;
  artist?: string;
  album?: string;
  streamUrl: string;
  startedAt: number;
  /** 推流节拍健康度(可观测指标;见 `raop.ts::realtimeStats`)。 */
  stream?: RaopRealtimeStats;
}

export interface AirplayCastArgs {
  deviceId: string;
  host: string;
  port: number;
  pk?: string;
  et?: string;
  /** 主进程用 DLNA createCastSession 取好的 token 化地址(子进程不碰 DB)。 */
  streamUrl: string;
  seekSec?: number;
  title?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
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
  /** 节拍健康度周期打点(仅流存续期间存在)。 */
  healthTimer?: ReturnType<typeof setInterval> | null;
}

export interface AirplayRuntimeHooks {
  /** 会话结束(整首播完 / 失败 / 被 stop):主进程据此上报 IDLE 让队列自动续播。 */
  onSessionEnded?: (deviceId: string) => void;
  /** 任何影响快照的变更(起播 / 暂停 / 恢复 / seek / 结束),用于触发快照推送。 */
  onChanged?: () => void;
}

export class AirplaySessionRuntime {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly hooks: AirplayRuntimeHooks;

  constructor(hooks: AirplayRuntimeHooks = {}) {
    this.hooks = hooks;
  }

  has(deviceId: string): boolean {
    return this.sessions.has(deviceId);
  }

  activeIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** 起一个会话:RTSP 握手 → ffmpeg 解码 → 按墙钟节拍推流。 */
  async cast(a: AirplayCastArgs): Promise<void> {
    await this.stop(a.deviceId); // 幂等:同设备旧会话先拆干净(与原 startSession 一致)
    const player = new RaopPlayer({ host: a.host, port: a.port, pk: a.pk, et: a.et });
    let session: RaopSession;
    try {
      session = await player.connect();
    } catch (e) {
      player.stop().catch(() => {});
      throw e;
    }
    const ff = spawnDecoder(a.streamUrl, a.seekSec);
    const active: ActiveSession = {
      deviceId: a.deviceId,
      player,
      ffmpeg: ff,
      session,
      title: a.title,
      artist: a.artist,
      album: a.album,
      duration: a.durationSec || 0,
      streamUrl: a.streamUrl,
      startedAt: Date.now(),
      ended: false,
    };
    this.sessions.set(a.deviceId, active);
    // ⚠️ 原实现这里先 `makeProducer(ff)` 一次却丢弃(变量未使用)—— 那个 producer 的
    // stdout data 监听器仍在,会把整首歌的 PCM 再缓存一份且无人消费(内存翻倍 + 与
    // 真 producer 争抢 pause/resume 背压)。此处只建一份,交给 runStream 驱动。
    this.runStream(active, session);
    this.hooks.onChanged?.();
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
   *     then tell the host (which reports IDLE to the PlayerController so
   *     QueueController auto-advances without waiting for the 5s fallback poll).
   *   - seekReplace: an in-place seek owns the session; keep it + sockets alive,
   *     kill only the (old) decoder. */
  private runStream(active: ActiveSession, session: RaopSession): void {
    const ff = active.ffmpeg;
    const producer = makeProducer(ff);
    // 节拍健康度周期打点:让 `reanchors` / `maxGap` 的**趋势**在播放过程中就可见
    // (原先只有 stream() 收尾那一行,出问题只能事后归因、也拿不到「何时开始变差」)。
    this.startHealthLog(active);
    const p = active.player.stream(producer, session)
      .catch((e) => {
        log.error("airplay stream failed", { deviceId: active.deviceId, err: (e as Error)?.message || e });
      })
      .finally(() => {
        this.stopHealthLog(active);
        if (active.seekReplace) {
          active.seekReplace = false;
          try { ff.kill(); } catch { /* ignore */ }
          this.hooks.onChanged?.();
          return;
        }
        if (this.sessions.get(active.deviceId) === active) {
          this.sessions.delete(active.deviceId);
        }
        active.ended = true;
        try { ff.kill(); } catch { /* ignore */ }
        // 会话自然结束(整首播完 / 失败)也必须拆掉 RTP socket 并发 TEARDOWN,
        // 否则 socket 泄漏,设备同时维护多个并发会话(多个 timing 循环),互相干扰导致卡顿。
        active.player.stop().catch(() => {});
        this.hooks.onSessionEnded?.(active.deviceId);
        this.hooks.onChanged?.();
      });
    active.streamPromise = p;
  }

  /** 每 15s 打一行节拍健康度(趋势);有补发或明显长间隔就升级为 warn,便于日志过滤。 */
  private startHealthLog(active: ActiveSession): void {
    this.stopHealthLog(active);
    active.healthTimer = setInterval(() => {
      const st = active.player.realtimeStats;
      if (!st) return;
      const line =
        `[${active.deviceId}] ${st.chunks} chunks / ${(st.elapsedMs / 1000).toFixed(0)}s` +
        `, reanchors=${st.reanchors}, maxGap=${st.maxGapMs.toFixed(0)}ms, loss=${st.lossRequests}`;
      if (st.reanchors > 0 || st.maxGapMs > HEALTH_WARN_GAP_MS) {
        log.warn(`airplay 节拍健康度(有抖动): ${line}`);
      } else {
        log.info(`airplay 节拍健康度: ${line}`);
      }
    }, HEALTH_LOG_INTERVAL_MS);
    active.healthTimer.unref?.();
  }

  private stopHealthLog(active: ActiveSession): void {
    if (active.healthTimer) {
      clearInterval(active.healthTimer);
      active.healthTimer = null;
    }
  }

  async stop(deviceId: string): Promise<void> {
    const s = this.sessions.get(deviceId);
    if (!s) return;
    this.sessions.delete(deviceId);
    s.ended = true;
    this.stopHealthLog(s);
    try { s.ffmpeg?.kill(); } catch { /* ignore */ }
    await s.player.stop().catch(() => {});
    this.hooks.onChanged?.();
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      try { await this.stop(id); } catch { /* ignore */ }
    }
  }

  /** 暂停:停掉墙钟节的推进(chunk 不再发出),RTSP 会话保持。 */
  pause(deviceId: string): boolean {
    const s = this.sessions.get(deviceId);
    if (!s) return false;
    s.player.pause();
    this.hooks.onChanged?.();
    return true;
  }

  /** 恢复推流(会话仍在);无会话返回 false,由主进程决定是否重播上一首。 */
  resume(deviceId: string): boolean {
    const s = this.sessions.get(deviceId);
    if (!s) return false;
    s.player.resume();
    this.hooks.onChanged?.();
    return true;
  }

  /** Seek the current track to `seconds`.
   *
   *  While a session is live this is an IN-PLACE seek: the RTSP session and RTP
   *  sockets stay up, the receiver's buffer is flushed (RAOP FLUSH), the RTP
   *  clock is re-anchored on the session base (so the reported position starts
   *  at the seek target and keeps climbing — no snap-back-to-0), and only the
   *  ffmpeg decoder is swapped for one that resumes at `-ss seconds`. The hard
   *  gap is just ffmpeg's seek+decode startup instead of a full TEARDOWN →
   *  ANNOUNCE/SETUP/RECORD round trip.
   *
   *  返回 false 表示没有可原地 seek 的会话(调用方回落到重播路径)。 */
  async seek(deviceId: string, seconds: number): Promise<boolean> {
    const t = Math.max(0, seconds);
    const s = this.sessions.get(deviceId);
    if (!s || s.ended || !s.player.isStreaming) return false;

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

    // The finalizer raced and tore the session down anyway → 交给调用方重播。
    if (this.sessions.get(deviceId) !== s) return false;

    s.ffmpeg = spawnDecoder(s.streamUrl, t);
    this.runStream(s, s.session);
    if (wasPaused) s.player.pause();
    this.hooks.onChanged?.();
    return true;
  }

  /** 应用 RAOP SET_PARAMETER 音量(dB 由主进程算好:DLNA 转发失败时的回落路径)。 */
  setVolumeDb(deviceId: string, db: number): boolean {
    const s = this.sessions.get(deviceId);
    if (!s) return false;
    s.player.setVolumeDb(db);
    return true;
  }

  /** 组装镜像:只有 session 的行(主进程自己还持有 volume/lastCast 等)。 */
  snapshot(): { sessions: AirplaySessionMirrorRow[] } {
    const sessions: AirplaySessionMirrorRow[] = [];
    for (const s of this.sessions.values()) {
      sessions.push({
        deviceId: s.deviceId,
        playbackState: s.ended ? "idle" : s.player.isPaused ? "paused" : "playing",
        positionSec: Math.max(0, s.player.positionSec),
        durationSec: s.duration || s.player.durationSec,
        ended: s.ended,
        title: s.title,
        artist: s.artist,
        album: s.album,
        streamUrl: s.streamUrl,
        startedAt: s.startedAt,
        stream: s.player.realtimeStats ?? undefined,
      });
    }
    return { sessions };
  }
}
