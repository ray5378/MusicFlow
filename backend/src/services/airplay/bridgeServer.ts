// ==================== AirPlay 桥接接收端(airplay 子进程侧)====================
//
// 与 sendspin 子进程的 `bridgeClient` 对应:监听 127.0.0.1 上的临时端口,接收
// pump 的 PCM 帧并写进对应设备的 `BridgeRing`,供 RAOP 的 producer 按墙钟取用。
//
// 为什么监听在本进程:
//   - RAOP 推流会话本来就住在这里(节拍 7.98ms),PCM 直接落本地内存,不再跨进程;
//   - 主进程只做控制面编排(起播/停止/seek/音量),不碰音频流量。
//
// 安全:只 bind 127.0.0.1、端口随机(由内核分配后经 mainReady 上报主进程),
// 不对外暴露;帧协议无鉴权(同机同用户,前提是本机无可信边界外的访问者)。
import * as net from "net";
import { BridgeRing } from "./bridgeRing.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Airplay-bridge");

const TYPE_HELLO = 0;
const TYPE_PCM = 1;
const TYPE_RESET = 2;
const TYPE_STOP = 3;

/** 单条连接允许积压的最大未解析字节(防御性上限,正常只有几十字节)。 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
/** 头部长度:u32 len + u8 type + u64 tsUs。 */
const HEADER_BYTES = 13;

interface ConnState {
  devices: string[];
  pending: Buffer;
}

export class AirplayBridgeServer {
  private server: net.Server | null = null;
  private port = 0;
  private readonly rings = new Map<string, BridgeRing>();
  private readonly conns = new Set<net.Socket>();
  private starting: Promise<number> | null = null;

  /** 端口(未启动为 0)。 */
  get listenPort(): number {
    return this.port;
  }

  /** 取(必要时创建)某设备的环形缓冲。 */
  ringFor(deviceId: string): BridgeRing {
    let r = this.rings.get(deviceId);
    if (!r) {
      r = new BridgeRing(deviceId);
      this.rings.set(deviceId, r);
    }
    return r;
  }

  hasRing(deviceId: string): boolean {
    return this.rings.has(deviceId);
  }

  /** 启动监听(幂等)。返回端口。 */
  async start(): Promise<number> {
    if (this.server) return this.port;
    if (this.starting) return this.starting;
    this.starting = new Promise<number>((resolve, reject) => {
      const srv = net.createServer((sock) => this.onConnection(sock));
      srv.once("error", (e) => {
        this.starting = null;
        reject(e);
      });
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        this.server = srv;
        this.starting = null;
        log.info(`airplay 桥接收听端已启动 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    for (const s of [...this.conns]) {
      try { s.destroy(); } catch { /* ignore */ }
    }
    this.conns.clear();
    const srv = this.server;
    this.server = null;
    this.port = 0;
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      log.info("airplay 桥接收听端已关闭");
    }
  }

  /** 某设备停止桥接:清空环(会话已拆,残留数据不能再播)。 */
  resetRing(deviceId: string): void {
    this.rings.get(deviceId)?.reset();
  }

  private onConnection(sock: net.Socket): void {
    sock.setNoDelay(true);
    const state: ConnState = { devices: [], pending: Buffer.alloc(0) };
    this.conns.add(sock);
    log.info(`airplay 桥接客户端接入 ${sock.remoteAddress}:${sock.remotePort}`);

    sock.on("data", (chunk: Buffer) => {
      if (state.pending.length + chunk.length > MAX_PENDING_BYTES) {
        log.warn(`airplay 桥接积压超限(${state.pending.length + chunk.length}B),断开该连接`);
        sock.destroy();
        return;
      }
      state.pending = state.pending.length === 0 ? chunk : Buffer.concat([state.pending, chunk]);
      this.drain(sock, state);
    });
    sock.on("error", (e) => {
      log.warn(`airplay 桥接连接异常: ${(e as Error)?.message || e}`);
    });
    sock.on("close", () => {
      this.conns.delete(sock);
      log.info(`airplay 桥接客户端断开 devices=${state.devices.join(",") || "-"}`);
      // 连接断开 = 该组不再有 pump 供音频:清空这些设备的环(避免旧内容被继续消费)。
      for (const d of state.devices) this.rings.get(d)?.reset();
    });
  }

  private drain(sock: net.Socket, state: ConnState): void {
    let buf = state.pending;
    while (buf.length >= HEADER_BYTES) {
      const len = buf.readUInt32BE(0);
      if (len < 9 || len > MAX_PENDING_BYTES) {
        log.warn(`airplay 桥接帧长度非法(${len}),断开`);
        sock.destroy();
        return;
      }
      const total = 4 + len;
      if (buf.length < total) break;
      const type = buf.readUInt8(4);
      const tsUs = buf.readBigUInt64BE(5);
      const payload = buf.subarray(HEADER_BYTES, total);
      buf = buf.subarray(total);
      this.handleFrame(type, tsUs, payload, state);
    }
    state.pending = buf;
  }

  private handleFrame(type: number, tsUs: bigint, payload: Buffer, state: ConnState): void {
    switch (type) {
      case TYPE_HELLO: {
        try {
          const hello = JSON.parse(payload.toString("utf8")) as { group?: string; devices?: string[] };
          state.devices = Array.isArray(hello.devices) ? hello.devices.filter((d) => typeof d === "string") : [];
          for (const d of state.devices) this.ringFor(d);
          log.info(`airplay 桥接握手:group=${hello.group ?? "-"} devices=${state.devices.join(",") || "-"}`);
        } catch (e) {
          log.warn(`airplay 桥接握手解析失败: ${(e as Error)?.message || e}`);
        }
        return;
      }
      case TYPE_PCM: {
        for (const d of state.devices) this.ringFor(d).push(tsUs, payload);
        return;
      }
      case TYPE_RESET: {
        for (const d of state.devices) this.rings.get(d)?.reset();
        return;
      }
      case TYPE_STOP: {
        for (const d of state.devices) this.rings.get(d)?.reset();
        return;
      }
      default:
        log.warn(`airplay 桥接未知帧类型 ${type}(忽略)`);
    }
  }
}
