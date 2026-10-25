/** airplay 侧 bridge listener(AirPlay 桥接 Phase 2,spec §4.1/§4.2/§4.4)。
 *
 *  每连接(每设备每流一个 socket):
 *  - 首帧必须 CONFIG,校验 deviceId/sessionToken,不匹配立即断连;
 *  - AUDIO → handlers.onAudio(实现方返回当前 PCM backlog ms;> 8s 触发
 *    overflow 断连,让发送侧重连 —— §4.4,48k 口径 MIN-05);
 *  - BOUNDARY / HEARTBEAT → 对应回调;2s 未收到任何帧 → onStall(Phase 2 只判定
 *    与上报,复杂恢复从简);
 *  - 非法帧流(解码器抛错)立即断连,不错位续读。
 *
 *  落盘模式(Phase 2 出口判据 ④):未提供 onAudio 且 dumpPath 存在时,48k s16le
 *  PCM 按 protocol 速率重采样(raop/ap2-compat → 44.1k;48k 直通)后写 s16le 文件。
 *  可被独立进程启动:runBridgeServerMain()(scripts/bridge-soak-child.ts / 手工)。
 */

import { createWriteStream, mkdirSync, unlinkSync, type WriteStream } from "node:fs";
import net from "node:net";
import path from "node:path";

import { nowUs } from "../../utils/hostClock.js";
import {
  FrameDecoder,
  bridgeSocketPath,
  decodeBoundaryReason,
  decodeConfigPayload,
  FRAME_FLAG_PAUSED,
  FRAME_HEADER_SIZE,
  FRAME_TYPE,
  type BridgeFrame,
} from "./bridgeChannel.js";
import { PROTOCOL_CAPS, BRIDGE_RECEIVE_OVERFLOW_MS, BRIDGE_STALL_NO_FRAME_MS, SENDSPIN_RATE, type BridgeProtocol } from "./rates.js";
import { PolyphaseResampler, floatToPcmS16, pcmS16ToFloat } from "./resampler.js";

export interface BridgeServerOpts {
  deviceId: string;
  token: string;
  protocol: BridgeProtocol;
  /** 落盘模式输出文件(s16le,重采样后速率);缺省不落盘。 */
  dumpPath?: string;
  /** stall 判定阈值(默认 2000ms,§4.2)。 */
  stallAfterMs?: number;
  /** stall 轮询周期(默认 500ms)。 */
  checkIntervalMs?: number;
  /** CONFIG 握手超时(默认 5000ms):超时未发 CONFIG 断连。 */
  configTimeoutMs?: number;
  /** 接收侧 PCM 积压上限(默认 8000ms,§4.4)。 */
  overflowMs?: number;
}

export interface BridgeAudioEvent {
  tsUs: bigint;
  generation: number;
  sequence: number;
  /** s16le/48000/2ch 原始 PCM(48k 口径,MIN-05)。 */
  payload: Uint8Array;
}

export interface BridgeSessionEvent {
  connected: boolean;
  reason?: string;
}

export interface BridgeServerHandlers {
  /** 返回当前 PCM backlog(ms);> overflowMs 时服务器断连该会话。 */
  onAudio?: (audio: BridgeAudioEvent) => number | void;
  onBoundary?: (generation: number, reason: string) => void;
  /** paused = HEARTBEAT flags bit1(§5.4 组泵暂停指示;Phase 5)。 */
  onHeartbeat?: (generation: number, sequence: number, paused?: boolean) => void;
  onSession?: (ev: BridgeSessionEvent) => void;
  onStall?: () => void;
  onOverflow?: (backlogMs: number) => void;
  log?: (...args: unknown[]) => void;
}

export interface BridgeServerStats {
  /** 通过 CONFIG 校验的连接数。 */
  sessionsAccepted: number;
  /** 被拒绝/协议违例断连的连接数。 */
  rejected: number;
  stalls: number;
  overflows: number;
  framesReceived: number;
  bytesReceived: number;
  /** sequence 不连续次数(诊断)。 */
  seqGaps: number;
}

interface BridgeSession {
  socket: net.Socket;
  decoder: FrameDecoder;
  configOk: boolean;
  lastFrameUs: bigint;
  stallActive: boolean;
  configTimer: NodeJS.Timeout | null;
  lastSeq: number;
  lastSeqGen: number;
}

export class BridgeServer {
  readonly opts: BridgeServerOpts;
  readonly handlers: BridgeServerHandlers;

  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private readonly sessions = new Set<BridgeSession>();
  private checkTimer: NodeJS.Timeout | null = null;
  private dumpStream: WriteStream | null = null;
  /** undefined = 未初始化;null = 直通(48k 协商);实例 = 44.1k 重采样。 */
  private dumpResampler: PolyphaseResampler | null | undefined = undefined;

  private stats_: BridgeServerStats = {
    sessionsAccepted: 0, rejected: 0, stalls: 0, overflows: 0,
    framesReceived: 0, bytesReceived: 0, seqGaps: 0,
  };

  constructor(opts: BridgeServerOpts, handlers: BridgeServerHandlers = {}) {
    this.opts = opts;
    this.handlers = handlers;
  }

  /** 当前监听路径(未监听为 null;测试/子进程管理用)。 */
  get listeningOn(): string | null {
    return this.socketPath;
  }

  stats(): BridgeServerStats {
    return { ...this.stats_ };
  }

  /** 启动监听(unix socket / 命名管道;先清理残留文件,§4.1)。 */
  async listen(socketPath: string): Promise<void> {
    if (this.server) throw new Error("bridge server already listening");
    if (process.platform !== "win32") {
      mkdirSync(path.dirname(socketPath), { recursive: true });
      try { unlinkSync(socketPath); } catch { /* 不存在即可 */ }
    }
    if (this.opts.dumpPath) {
      const ds = createWriteStream(this.opts.dumpPath, { flags: "w" });
      ds.on("error", (err) => this.log(`bridge dump write error: ${err.message}`));
      this.dumpStream = ds;
    }
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer((sock) => this.onConnection(sock));
      srv.once("error", reject);
      srv.listen(socketPath, () => {
        this.server = srv;
        this.socketPath = socketPath;
        resolve();
      });
    });
    this.checkTimer = setInterval(() => this.checkStalls(), this.opts.checkIntervalMs ?? 500);
    this.checkTimer.unref?.();
    this.log(`listening on ${socketPath} (protocol=${this.opts.protocol}, dump=${this.opts.dumpPath ?? "-"})`);
  }

  /** 停止:断开全部会话、关监听、清 socket 文件、排空落盘流。 */
  async close(): Promise<void> {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    for (const s of [...this.sessions]) {
      s.configTimer !== null && clearTimeout(s.configTimer);
      s.socket.destroy();
    }
    this.sessions.clear();
    const srv = this.server;
    this.server = null;
    if (srv) await new Promise<void>((res) => srv.close(() => res()));
    const p = this.socketPath;
    this.socketPath = null;
    if (p && process.platform !== "win32") {
      try { unlinkSync(p); } catch { /* 已被并发清理 */ }
    }
    const ds = this.dumpStream;
    this.dumpStream = null;
    this.dumpResampler = undefined;
    if (ds) await new Promise<void>((res) => ds.end(() => res()));
  }

  /** 强制断开全部会话(测试/soak:模拟对端被 kill 由本端观察重连)。 */
  destroySessions(): void {
    for (const s of [...this.sessions]) s.socket.destroy();
  }

  // -------------------------------------------------------------------------

  private log(...args: unknown[]): void {
    this.handlers.log?.(`[bridge-server]`, ...args);
  }

  private onConnection(sock: net.Socket): void {
    const session: BridgeSession = {
      socket: sock,
      decoder: new FrameDecoder(),
      configOk: false,
      lastFrameUs: nowUs(),
      stallActive: false,
      configTimer: null,
      lastSeq: 0,
      lastSeqGen: 0,
    };
    this.sessions.add(session);
    session.configTimer = setTimeout(() => {
      if (!session.configOk) this.rejectSession(session, "config timeout");
    }, this.opts.configTimeoutMs ?? 5000);
    session.configTimer.unref?.();
    sock.on("data", (chunk: Buffer) => this.onData(session, chunk));
    sock.on("error", (err: Error) => this.log(`session error: ${err.message}`));
    sock.on("close", () => this.onSessionClose(session));
  }

  private onData(session: BridgeSession, chunk: Buffer): void {
    let frames: BridgeFrame[];
    try {
      frames = session.decoder.push(chunk);
    } catch (err) {
      this.rejectSession(session, `protocol: ${(err as Error).message}`);
      return;
    }
    for (const f of frames) this.handleFrame(session, f);
  }

  private handleFrame(session: BridgeSession, frame: BridgeFrame): void {
    this.stats_.framesReceived++;
    this.stats_.bytesReceived += FRAME_HEADER_SIZE + frame.payload.byteLength;
    session.lastFrameUs = nowUs();
    session.stallActive = false;

    if (!session.configOk) {
      if (frame.type !== FRAME_TYPE.CONFIG) {
        this.rejectSession(session, "first frame not CONFIG");
        return;
      }
      let cfg;
      try {
        cfg = decodeConfigPayload(frame);
      } catch (err) {
        this.rejectSession(session, `config invalid: ${(err as Error).message}`);
        return;
      }
      if (cfg.deviceId !== this.opts.deviceId) {
        this.rejectSession(session, "deviceId mismatch");
        return;
      }
      if (cfg.sessionToken !== this.opts.token) {
        this.rejectSession(session, "sessionToken mismatch");
        return;
      }
      if (session.configTimer !== null) {
        clearTimeout(session.configTimer);
        session.configTimer = null;
      }
      session.configOk = true;
      this.stats_.sessionsAccepted++;
      this.log(`session accepted (deviceId=${cfg.deviceId}, protocol=${cfg.protocol})`);
      this.handlers.onSession?.({ connected: true });
      return;
    }

    // sequence 连续性诊断(同 generation 内应逐帧 +1)
    if (frame.generation === session.lastSeqGen && session.lastSeq > 0 &&
        frame.sequence !== ((session.lastSeq + 1) >>> 0)) {
      this.stats_.seqGaps++;
      this.log(`seq gap: gen=${frame.generation} ${session.lastSeq} -> ${frame.sequence}`);
    }
    session.lastSeq = frame.sequence;
    session.lastSeqGen = frame.generation;

    switch (frame.type) {
      case FRAME_TYPE.AUDIO: {
        const backlog = this.dispatchAudio(frame);
        if (typeof backlog === "number" && backlog > (this.opts.overflowMs ?? BRIDGE_RECEIVE_OVERFLOW_MS)) {
          // §4.4:接收侧 PCM 积压超 8s → 断连报 overflow,让发送侧重连。
          this.stats_.overflows++;
          this.log(`overflow: backlog=${Math.round(backlog)}ms`);
          this.handlers.onOverflow?.(backlog);
          session.socket.destroy();
        }
        return;
      }
      case FRAME_TYPE.BOUNDARY: {
        let reason: string;
        try {
          reason = decodeBoundaryReason(frame);
        } catch (err) {
          this.rejectSession(session, `boundary invalid: ${(err as Error).message}`);
          return;
        }
        this.handlers.onBoundary?.(frame.generation, reason);
        return;
      }
      case FRAME_TYPE.HEARTBEAT:
        this.handlers.onHeartbeat?.(frame.generation, frame.sequence, (frame.flags & FRAME_FLAG_PAUSED) !== 0);
        return;
      case FRAME_TYPE.STATS:
        return; // Phase 2 只透传计数,不解析
      default:
        this.rejectSession(session, `unknown frame type ${frame.type}`);
    }
  }

  /** AUDIO 分发:优先外部 onAudio;否则落盘模式;两者皆无则计数丢弃。 */
  private dispatchAudio(frame: BridgeFrame): number | void {
    if (this.handlers.onAudio) {
      return this.handlers.onAudio({
        tsUs: frame.tsUs,
        generation: frame.generation,
        sequence: frame.sequence,
        payload: frame.payload,
      });
    }
    if (this.dumpStream) return this.dumpPipeline(frame);
    return 0;
  }

  /** 落盘模式:48k s16le →(按协议速率)重采样 → s16le 追加写文件。 */
  private dumpPipeline(frame: BridgeFrame): number {
    if (this.dumpResampler === undefined) {
      const outRate = PROTOCOL_CAPS[this.opts.protocol].rate;
      this.dumpResampler = outRate === SENDSPIN_RATE
        ? null
        : new PolyphaseResampler(SENDSPIN_RATE, outRate, 2);
    }
    const s16 = new Int16Array(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength >> 1);
    const f32 = pcmS16ToFloat(s16);
    const out = this.dumpResampler ? this.dumpResampler.process(f32) : f32;
    const outS16 = floatToPcmS16(out);
    if (outS16.length > 0) {
      this.dumpStream?.write(Buffer.from(outS16.buffer, outS16.byteOffset, outS16.byteLength));
    }
    return 0; // 落盘不积压
  }

  private checkStalls(): void {
    const thresholdUs = BigInt(this.opts.stallAfterMs ?? BRIDGE_STALL_NO_FRAME_MS) * 1000n;
    const now = nowUs();
    for (const s of this.sessions) {
      if (!s.configOk || s.stallActive) continue;
      if (now - s.lastFrameUs > thresholdUs) {
        s.stallActive = true;
        this.stats_.stalls++;
        this.log(`stall: no frame for ${this.opts.stallAfterMs ?? BRIDGE_STALL_NO_FRAME_MS}ms`);
        this.handlers.onStall?.();
      }
    }
  }

  private rejectSession(session: BridgeSession, reason: string): void {
    this.stats_.rejected++;
    this.log(`session rejected: ${reason}`);
    this.handlers.onSession?.({ connected: false, reason });
    if (session.configTimer !== null) {
      clearTimeout(session.configTimer);
      session.configTimer = null;
    }
    session.socket.destroy();
  }

  private onSessionClose(session: BridgeSession): void {
    if (session.configTimer !== null) {
      clearTimeout(session.configTimer);
      session.configTimer = null;
    }
    this.sessions.delete(session);
    if (session.configOk) this.handlers.onSession?.({ connected: false, reason: "closed" });
  }
}

// ---------------------------------------------------------------------------
// 独立进程入口(手工/soak;env 见 scripts/bridge-soak-child.ts)
// ---------------------------------------------------------------------------

/** 以环境变量启动 bridge server:MFAB_DEVICE_ID / MFAB_TOKEN / MFAB_SOCKET_PATH /
 *  MFAB_PROTOCOL / MFAB_DUMP_PATH。SIGINT/SIGTERM 优雅退出。 */
export async function runBridgeServerMain(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const deviceId = env.MFAB_DEVICE_ID ?? "";
  const token = env.MFAB_TOKEN ?? "";
  const protocol = (env.MFAB_PROTOCOL ?? "raop") as BridgeProtocol;
  const socketPath = env.MFAB_SOCKET_PATH || bridgeSocketPath(deviceId, token);
  const server = new BridgeServer(
    { deviceId, token, protocol, dumpPath: env.MFAB_DUMP_PATH || undefined },
    {
      log: (...args: unknown[]) => console.log(...args),
      onSession: (ev) => console.log(`[bridge-server] session ${ev.connected ? "connected" : "disconnected"}${ev.reason ? ` (${ev.reason})` : ""}`),
      onStall: () => console.log(`[bridge-server] stall detected`),
      onOverflow: (ms) => console.log(`[bridge-server] overflow ${Math.round(ms)}ms`),
    },
  );
  await server.listen(socketPath);
  console.log(`[bridge-server] ready socket=${socketPath} protocol=${protocol} dump=${env.MFAB_DUMP_PATH ?? "-"}`);
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
