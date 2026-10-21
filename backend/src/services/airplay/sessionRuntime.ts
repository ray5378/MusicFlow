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
import { spawnDecoder, makeProducer, killDecoder } from "./decoder.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AIRPLAY");

/** 节拍健康度打点周期;以及「单次发包间隔」告警阈值(节拍 ≈7.98ms,超 50ms 即明显被拖)。 */
const HEALTH_LOG_INTERVAL_MS = 15_000;
const HEALTH_WARN_GAP_MS = 50;

/** 单会话收尾(RTSP TEARDOWN + 关 socket)的硬上限。
 *
 *  为什么子进程必须自己有上限:主进程 in-proc 路径用 `withDeadline(4s)` 包住旧会话
 *  收尾;子进程的 `cast` RPC 若直接 `await player.stop()`,一旦设备/连接卡住,RPC
 *  就永远不回 → 主进程序列闸被占满 ⇒ 后续 seek/stop 全部 `rpc 超时`(2026-10-22 真机)。
 *  超时后强制关传输,保住 RPC 应答。 */
const STOP_DEADLINE_MS = 4_000;

function stopDeadlineMs(): number {
  const v = Number(process.env.AIRPLAY_STOP_DEADLINE_MS);
  return Number.isFinite(v) && v > 0 ? v : STOP_DEADLINE_MS;
}

/** 把起播/seek 偏移编进服务端回环流(与主进程 `withPlaybackOffset` 同口径)。
 *  子进程不能 import control.ts(会拖进 DB/DLNA/peer),故在这里做同一件事:
 *  解码器吃一条**从头就正确**的流,绝不对 live FLAC 做 `-ss`(残帧 ⇒ 无声)。 */
function withOffset(url: string, seekSec?: number): string {
  if (seekSec === undefined || !Number.isFinite(seekSec) || seekSec <= 0) return url;
  try {
    const u = new URL(url);
    if (!u.pathname.startsWith("/rest/airplay/stream/")) return url;
    u.searchParams.set("timeOffset", String(Math.round(seekSec * 1000) / 1000));
    return u.toString();
  } catch {
    return url;
  }
}

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
  /** 分析行 id(= songs.id):供解码 af 选静态增益;缺省走实时 loudnorm。 */
  songId?: string;
  title?: string;  artist?: string;
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
  /** 分析行 id(随 cast 透传,供 seek 重建解码器时保持响度决策一致)。 */
  songId?: string;
  startedAt: number;
  ended: boolean;
  /** 节拍健康度周期打点(仅流存续期间存在)。 */
  healthTimer?: ReturnType<typeof setInterval> | null;
}

/** 会话结束信息(子进程 finalizer → hooks → 主进程上报链路共用)。
 *
 *  为什么必须带 `current`(2026-10-20 现网定位):会话被「新起播」或「显式 stop」
 *  取代后,旧会话的 finalizer 仍会跑到收尾分支。它上报的 IDLE 属于**上一首**,
 *  却与新会话共用同一个 `airplay:<deviceId>` playerId → tracker 会把刚建立的新曲
 *  判成「已结束」→ 误切歌 / 刚切过去就被切走。主进程据此**抑制**过期 IDLE。
 *  positionSec/durationSec 是结束时的**真实落点**:IDLE 必须携带它,否则
 *  QueueController 的结束判据(位置 ≥ 时长−容差)只能靠"末次 5s 轮询恰好在结尾附近"
 *  才成立,漏一拍就退化成 idle_early。 */
export interface AirplaySessionEndInfo {
  /** 是否仍是该设备的当前会话(未被子进程侧新起播 / stop 取代)。 */
  current: boolean;
  /** 结束时的内容落点(秒)。 */
  positionSec: number;
  /** 该曲已知时长(秒;未知为 0)。 */
  durationSec: number;
  /** 解码器 stderr 全量(尾部,上限 64KB;P0-4 解析 loudnorm 用);无则省略。 */
  loudnessStderr?: string;
}

export interface AirplayRuntimeHooks {
  /** 会话结束(整首播完 / 失败 / 被 stop):主进程据此上报 IDLE 让队列自动续播。
   *  info.current=false 表示会话已被取代 → 主进程必须抑制过期 IDLE。 */
  onSessionEnded?: (deviceId: string, info: AirplaySessionEndInfo) => void;
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
    // seek 走完整重建时,新会话的 RTP 时间线按目标秒重锚(否则上报位置从 0 起算)。
    if (a.seekSec !== undefined && Number.isFinite(a.seekSec) && a.seekSec > 0) {
      player.setStartPosition(a.seekSec);
    }
    // 偏移编进**服务端回环流**(与主进程 withPlaybackOffset 同口径):解码器吃一条
    // 从头就正确的流,绝不对 live FLAC 做 `-ss`(残帧 ⇒ invalid sync code / 无声)。
    const ff = spawnDecoder(withOffset(a.streamUrl, a.seekSec), undefined, { rowId: a.songId });
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
      songId: a.songId,
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
          killDecoder(ff);
          this.hooks.onChanged?.();
          return;
        }
        // ⚠️ 必须在 delete **之前**判定「本会话是否仍是该设备的当前会话」(与 in-proc
        // 的 runStream finalizer 同口径):被新起播/显式 stop 取代的旧会话,其
        // sessionEnded 属于**上一首**;主进程若照旧上报 IDLE,会把刚建立的新曲
        // 判成"已结束"→ 误切歌 / 刚切过去就被切走。
        const stillCurrent = this.sessions.get(active.deviceId) === active;
        if (stillCurrent) {
          this.sessions.delete(active.deviceId);
        }
        active.ended = true;
        killDecoder(ff);
        // 会话自然结束(整首播完 / 失败)也必须拆掉 RTP socket 并发 TEARDOWN,
        // 否则 socket 泄漏,设备同时维护多个并发会话(多个 timing 循环),互相干扰导致卡顿。
        // 收尾同样走上限:finalizer 本身不等它,但绝不能让半死连接长期占着 RTP 端口。
        void this.stopPlayerBounded(active);
        // P0-4:把解码器 stderr 带给主进程解析 loudnorm(子进程不碰 DB)。
        // 被 stop/失败时无 JSON,主进程侧解析失败即 false,不影响续播。
        const loudnessStderr = (ff as any)?.stderrText?.() ?? "";
        this.hooks.onSessionEnded?.(active.deviceId, {
          current: stillCurrent,
          positionSec: Math.max(0, Number(active.player.positionSec) || 0),
          durationSec: active.duration || Math.max(0, Number(active.player.durationSec) || 0),
          ...(loudnessStderr ? { loudnessStderr } : {}),
        });
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
    try { killDecoder(s.ffmpeg); } catch { /* ignore */ }
    await this.stopPlayerBounded(s);
    this.hooks.onChanged?.();
  }

  /** 有上限的会话收尾:TEARDOWN 卡住时强制关传输,保证 RPC 一定回包。
   *  返回 true 表示正常收尾,false 表示超时后强制关闭。 */
  private async stopPlayerBounded(s: ActiveSession): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), stopDeadlineMs());
      timer.unref?.();
    });
    try {
      const r = await Promise.race([s.player.stop().catch(() => null), timeout]);
      if (r === null) {
        log.warn(`airplay 会话收尾超时(${stopDeadlineMs()}ms),强制关闭传输`, { deviceId: s.deviceId });
        s.player.forceClose();
        return false;
      }
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
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
      killDecoder(s.ffmpeg);
      s.ffmpeg.stdout?.destroy();
      s.ffmpeg.stderr?.destroy();
    } catch { /* ignore */ }

    await s.player.prepareSeek(t).catch(() => {});
    // Wait for the old loop + finalizer (which now runs the seekReplace branch).
    await (oldStream || Promise.resolve()).catch(() => {});

    // The finalizer raced and tore the session down anyway → 交给调用方重播。
    if (this.sessions.get(deviceId) !== s) return false;

    s.ffmpeg = spawnDecoder(withOffset(s.streamUrl, t), undefined, { rowId: s.songId });
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
