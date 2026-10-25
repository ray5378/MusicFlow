/** 桥会话(Phase 3 出声中间态,spec §4.5/Phase 3):bridgeServer 收到 48k s16le PCM
 *  → 147/160 重采样(AP1 协商 44.1k;48k 协商直通)→ RaopPlayer 按墙钟节拍出声。
 *
 *  ⚠️ 中间态口径(Phase 4 接管):
 *  - 节拍复用 RaopPlayer.stream() 的**旧墙钟驱动**(drift-corrected accumulator),
 *    不做锚点/时间线映射(四字段/tSync 是 Phase 4);
 *  - producer 欠料时补**静音块**保持 RTP 时钟连续(宁出静音不断流);
 *  - warm/cold 一律按 cold 保守上报(R2:未收到 CONFIG 回执前不作 warm 假设)。
 *
 *  硬约束:纯数据面 —— 本文件不做任何选歌/预取逻辑。
 */

import { BridgeServer, type BridgeServerHandlers } from "./bridgeServer.js";
import { bridgeSocketPath } from "./bridgeChannel.js";
import { PROTOCOL_CAPS, SENDSPIN_RATE, type BridgeProtocol } from "./rates.js";
import { PolyphaseResampler, floatToPcmS16, pcmS16ToFloat } from "./resampler.js";
import { RaopPlayer, CHUNK_LEN, type RaopSession } from "./raop.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AirPlay");

export interface BridgeSessionOpts {
  deviceId: string;
  token: string;
  protocol: BridgeProtocol;
  /** 会合 socket 路径(主进程按 bridgeSocketPath() 计算后下发)。 */
  socketPath: string;
  /** RAOP 目标(旧墙钟出声);dry 模式可缺省。 */
  host?: string;
  port?: number;
  pk?: string;
  et?: string;
  /** 测试/落盘干跑:不做 RTSP 握手,只起 listener 验证 48k→44.1k 生产管线。 */
  dry?: boolean;
  /** producer 等料超时(ms),超时补静音块。默认 1000。 */
  waitDataMs?: number;
}

export interface BridgeSessionStats {
  framesIn: number;
  chunksOut: number;
  silenceChunks: number;
}

export class BridgeSession {
  readonly deviceId: string;
  readonly token: string;
  readonly opts: BridgeSessionOpts;

  private player: RaopPlayer | null = null;
  private raopSession: RaopSession | null = null;
  private server: BridgeServer | null = null;
  private closed = false;
  private readonly waitDataMs: number;
  /** 48k 协商直通时为 null。 */
  private readonly resampler: PolyphaseResampler | null;

  /** 48k s16le 入队(桥帧 payload 原样)。 */
  private inQueue: Buffer[] = [];
  private inBytes = 0;
  /** 44.1k s16le 出缓冲(producer 逐 352 帧切割)。 */
  private outBuf: Buffer = Buffer.alloc(0);
  readonly stats: BridgeSessionStats = { framesIn: 0, chunksOut: 0, silenceChunks: 0 };
  private streamPromise: Promise<void> | null = null;

  constructor(opts: BridgeSessionOpts) {
    this.opts = opts;
    this.deviceId = opts.deviceId;
    this.token = opts.token;
    this.waitDataMs = opts.waitDataMs ?? 1000;
    const outRate = PROTOCOL_CAPS[opts.protocol].rate;
    this.resampler = outRate === SENDSPIN_RATE ? null : new PolyphaseResampler(SENDSPIN_RATE, outRate, 2);
  }

  get listeningOn(): string | null {
    return this.server?.listeningOn ?? null;
  }

  /** 起 listener(+ 非 dry 时 RAOP 握手并进入推流循环)。 */
  async start(): Promise<void> {
    const handlers: BridgeServerHandlers = {
      onAudio: (a) => this.ingest(a.payload),
      onSession: (ev) => {
        if (!ev.connected) log.warn(`bridge session 断开: device=${this.deviceId} reason=${ev.reason ?? "-"}`);
      },
      onOverflow: (ms) => log.warn(`bridge overflow: device=${this.deviceId} backlog=${Math.round(ms)}ms`),
      log: (...args: unknown[]) => log.info(args.map((a) => String(a)).join(" ")),
    };
    const server = new BridgeServer(
      { deviceId: this.opts.deviceId, token: this.opts.token, protocol: this.opts.protocol },
      handlers,
    );
    await server.listen(this.opts.socketPath);
    this.server = server;
    if (this.opts.dry) return;
    const player = new RaopPlayer({
      host: this.opts.host ?? "",
      port: this.opts.port ?? 5000,
      pk: this.opts.pk,
      et: this.opts.et,
    });
    let session: RaopSession;
    try {
      session = await player.connect();
    } catch (e) {
      await server.close();
      throw e;
    }
    this.raopSession = session;
    this.player = player;
    this.streamPromise = player.stream(() => this.pullChunk(), session).catch((e) => {
      log.warn(`bridge raop stream ended: device=${this.deviceId} err=${(e as Error)?.message || e}`);
    });
  }

  /** 48k s16le 入队(bridgeServer AUDIO 回调)。 */
  private ingest(payload: Uint8Array): void {
    if (this.closed) return;
    const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    this.inQueue.push(buf);
    this.inBytes += buf.length;
    this.stats.framesIn += buf.length >> 2;
  }

  /** RAOP producer:凑满一个 352 帧 chunk(44.1k/s16le/2ch = 1408B)。
   *  欠料等待 waitDataMs,超时补静音(旧墙钟中间态:保持 RTP 时钟连续)。
   *  返回 null = 会话已停止(结束 stream 循环)。 */
  private async pullChunk(): Promise<Buffer | null> {
    if (this.closed) return null;
    const need = CHUNK_LEN * 4;
    const deadline = Date.now() + this.waitDataMs;
    while (this.outBuf.length < need) {
      const next = this.inQueue.shift();
      if (next !== undefined) {
        this.inBytes -= next.length;
        // 48k s16le → Float32 →(147/160)→ 44.1k Float32 → s16le 追加
        const s16 = new Int16Array(next.buffer, next.byteOffset, next.length >> 1);
        const f32 = pcmS16ToFloat(s16);
        const out = this.resampler ? this.resampler.process(f32) : f32;
        const s16out = floatToPcmS16(out);
        const piece = Buffer.from(s16out.buffer, s16out.byteOffset, s16out.byteLength);
        this.outBuf = this.outBuf.length === 0 ? piece : Buffer.concat([this.outBuf, piece]);
        continue;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    if (this.outBuf.length < need) {
      // 欠料:可用部分 + 静音补齐;未凑满的余料留在 outBuf 下一轮先用。
      const silence = Buffer.alloc(need);
      this.outBuf.copy(silence, 0);
      this.outBuf = Buffer.alloc(0);
      this.stats.silenceChunks++;
      return silence;
    }
    const chunk = Buffer.from(this.outBuf.subarray(0, need));
    this.outBuf = Buffer.from(this.outBuf.subarray(need));
    this.stats.chunksOut++;
    return chunk;
  }

  /** 停止:断 listener + TEARDOWN RAOP。幂等。 */
  async stop(): Promise<void> {
    this.closed = true;
    const server = this.server;
    this.server = null;
    if (server) await server.close();
    this.inQueue = [];
    this.inBytes = 0;
    this.outBuf = Buffer.alloc(0);
    const player = this.player;
    this.player = null;
    if (player) {
      try { await player.stop(); } catch { /* ignore */ }
    }
  }

  /** 诊断快照(bridgeStatus op 用)。 */
  snapshot(): { deviceId: string; token: string; socketPath: string | null; streaming: boolean; stats: BridgeSessionStats } {
    return {
      deviceId: this.deviceId,
      token: this.token,
      socketPath: this.listeningOn,
      streaming: this.player?.isStreaming ?? false,
      stats: { ...this.stats },
    };
  }
}

/** 子进程侧桥会话表(按 sessionToken 索引;同 deviceId 新 prepare 拆旧)。 */
export class BridgeSessionManager {
  private readonly sessions = new Map<string, BridgeSession>();

  list(): Array<ReturnType<BridgeSession["snapshot"]>> {
    return [...this.sessions.values()].map((s) => s.snapshot());
  }

  has(deviceId: string): boolean {
    for (const s of this.sessions.values()) if (s.deviceId === deviceId) return true;
    return false;
  }

  /** 起一座桥会话(同 deviceId 旧会话先拆 = 新流语义)。 */
  async prepare(opts: BridgeSessionOpts): Promise<{ listening: true; socketPath: string }> {
    for (const [token, s] of [...this.sessions]) {
      if (s.deviceId === opts.deviceId) {
        this.sessions.delete(token);
        await s.stop().catch(() => {});
      }
    }
    const session = new BridgeSession(opts);
    await session.start();
    this.sessions.set(opts.token, session);
    return { listening: true, socketPath: session.listeningOn ?? opts.socketPath };
  }

  async stop(token: string): Promise<void> {
    const s = this.sessions.get(token);
    if (!s) return;
    this.sessions.delete(token);
    await s.stop().catch(() => {});
  }

  async stopAll(): Promise<void> {
    for (const [token, s] of [...this.sessions]) {
      this.sessions.delete(token);
      await s.stop().catch(() => {});
    }
  }
}

// 供编排侧(主进程)复用的纯函数重导出:socket 路径计算必须同一处实现。
export { bridgeSocketPath };
