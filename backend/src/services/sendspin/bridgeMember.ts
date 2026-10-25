/** sendspin 侧桥成员(AirPlay 桥接 Phase 2,spec §4.1/§4.2/§4.4)。
 *
 *  职责:持有 BridgeSource(有界队列/水位/退避重连),负责 socket 会合的
 *  CONFIG 握手、心跳、generation 管理与统计。
 *  - 连接建立后发送端先发 CONFIG(§4.1),接收端校验 deviceId/sessionToken;
 *  - generation 变更(组泵 seek/track/rehost,Phase 3 由 streamEngine 通知)时
 *    清旧代次队列并发 BOUNDARY(§4.4);
 *  - 断连重连成功后本地自增 generation 并发 BOUNDARY{rehost}(§4.4「重连成功
 *    发新 generation」,airplay 侧重新锚定);
 *  - 统计 droppedFrames 恒 0 —— 禁止丢最旧帧,宁断不错位。
 *
 *  Phase 2 不接组泵:由测试/soak 脚本直接 pushAudio;Phase 3 由 streamPump 接入。
 */

import net from "node:net";

import {
  FrameSequencer,
  encodeAudio,
  encodeBoundary,
  encodeConfig,
  encodeHeartbeat,
  type BridgeBoundaryReason,
  type BridgeConfigPayload,
} from "../airplay/bridgeChannel.js";
import { BridgeSource, type BridgeLinkState, type BridgeSocketLike } from "../airplay/bridgeSource.js";
import { BRIDGE_HEARTBEAT_INTERVAL_MS, SENDSPIN_RATE, type BridgeProtocol } from "../airplay/rates.js";

export interface BridgeMemberStats {
  state: BridgeLinkState;
  generation: number;
  queuedBytes: number;
  /** 峰值排队毫秒数(48k 口径,MIN-05)。 */
  maxQueueMs: number;
  sentFrames: number;
  /** 恒 0:禁止丢最旧帧(宁断不错位),用例钉住。 */
  droppedFrames: number;
  reconnects: number;
}

export interface BridgeMemberOpts {
  deviceId: string;
  socketPath: string;
  token: string;
  protocol: BridgeProtocol;
  /** 心跳间隔(默认 1s,须显著小于接收端 2s stall 阈值)。 */
  heartbeatMs?: number;
  /** 重连退避注入(测试确定性);缺省 = 5s/30s ±20% 抖动。 */
  backoffDelayMs?: (attempt: number) => number;
  /** 定时器注入(测试)。 */
  schedule?: (fn: () => void, ms: number) => () => void;
  highWaterMs?: number;
  hardCapMs?: number;
  onStateChange?: (state: BridgeLinkState, info?: { reason?: string }) => void;
  onBackpressure?: (queuedMs: number) => void;
  onHardCapStall?: () => void;
  log?: (...args: unknown[]) => void;
}

export class BridgeMember {
  readonly source: BridgeSource;
  private readonly opts: BridgeMemberOpts;
  private readonly seq = new FrameSequencer();
  private readonly heartbeatMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private gen = 0;
  private everConnected = false;

  constructor(opts: BridgeMemberOpts) {
    this.opts = opts;
    this.heartbeatMs = opts.heartbeatMs ?? BRIDGE_HEARTBEAT_INTERVAL_MS;
    this.source = new BridgeSource({
      connect: () => this.connectTcp(),
      onConnected: (sock) => this.onConnected(sock),
      onStateChange: opts.onStateChange,
      onBackpressure: opts.onBackpressure,
      onHardCap: opts.onHardCapStall,
      backoffDelayMs: opts.backoffDelayMs,
      schedule: opts.schedule,
      highWaterMs: opts.highWaterMs,
      hardCapMs: opts.hardCapMs,
      log: opts.log,
    });
  }

  get deviceId(): string {
    return this.opts.deviceId;
  }

  get generation(): number {
    return this.gen;
  }

  /** 启动连接(带退避重连)与心跳。 */
  start(): void {
    this.source.start();
    if (this.heartbeatTimer === null && this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
      this.heartbeatTimer.unref?.();
    }
  }

  /** 停止心跳与连接。 */
  stop(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.source.stop();
  }

  /** 组泵/测试入口:入队一帧 48k s16le/2ch PCM(立即返回,不阻塞泵)。 */
  pushAudio(pcm: Uint8Array, tsUs: bigint): void {
    this.source.enqueue(encodeAudio(this.seq.generation, this.seq.take(), tsUs, pcm));
  }

  /** streamEngine 通知流代次(§4.3,Phase 3 接入):清旧代次队列并发 BOUNDARY。
   *  同值幂等(重锚分支可能对同一 generation 多次触发)。 */
  notifyGeneration(generation: number, reason: BridgeBoundaryReason): void {
    const gen = generation >>> 0;
    if (gen === this.gen) return;
    this.gen = gen;
    this.seq.reset(gen);
    this.source.clearQueue();
    this.source.enqueue(encodeBoundary(gen, this.seq.take(), reason));
  }

  /** 不换代只发 BOUNDARY(clearPlayback → track / finishPlayback → stop,§6.2)。
   *  「BOUNDARY 不拆会话,一次 seek 发两次无害」(§4.3)—— 与 notifyGeneration 并存。 */
  sendBoundary(reason: BridgeBoundaryReason): void {
    this.source.enqueue(encodeBoundary(this.seq.generation, this.seq.take(), reason));
  }

  stats(): BridgeMemberStats {
    const s = this.source.stats();
    return {
      state: s.state,
      generation: this.gen,
      queuedBytes: s.queuedBytes,
      maxQueueMs: s.maxQueueMs,
      sentFrames: s.sentFrames,
      droppedFrames: 0, // 禁止丢最旧帧:实现里不存在丢弃路径,用例钉住
      reconnects: s.reconnects,
    };
  }

  // -------------------------------------------------------------------------

  /** TCP/unix 会合连接(§4.1:airplay listen,sendspin connect)。 */
  private connectTcp(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.opts.socketPath);
      let settled = false;
      // error 监听全程在位:connect 成功前 reject,成功后交给 BridgeSource 处理
      // (保留监听避免"connect 与 destroy 竞态窗口内 error 无监听"炸进程)。
      sock.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(err);
        }
      });
      sock.once("connect", () => {
        settled = true;
        resolve(sock);
      });
    });
  }

  /** 连接就绪:先发 CONFIG(§4.1);重连则发新 generation 的 BOUNDARY{rehost}。 */
  private onConnected(sock: BridgeSocketLike): void {
    const cfg: BridgeConfigPayload = {
      deviceId: this.opts.deviceId,
      protocol: this.opts.protocol,
      rate: SENDSPIN_RATE,
      channels: 2,
      format: "s16le",
      sessionToken: this.opts.token,
    };
    try {
      sock.write(encodeConfig(cfg));
    } catch (err) {
      this.opts.log?.(`bridge config write failed: ${(err as Error).message}`);
      return;
    }
    if (this.everConnected) {
      // §4.4:重连成功发新 generation,airplay 侧重新锚定;断连前的旧帧一并清掉。
      this.gen = (this.gen + 1) >>> 0;
      this.seq.reset(this.gen);
      this.source.clearQueue();
      this.source.enqueue(encodeBoundary(this.gen, this.seq.take(), "rehost"));
      this.opts.log?.(`bridge reconnected, new generation=${this.gen}`);
    }
    this.everConnected = true;
  }

  private sendHeartbeat(): void {
    if (this.source.state !== "live") return;
    this.source.sendNow(encodeHeartbeat(this.seq.generation, this.seq.take()));
  }
}
