// ==================== AirPlay 桥接 sink(sendspin 子进程侧)====================
//
// pump 每 25ms 产出一帧 Float32 PCM,本 sink 立刻转成 s16 交错字节,经
// **127.0.0.1 上的单条 TCP 长连接**送到 airplay 子进程(那边是 RAOP 推流的宿主)。
//
// 为什么用直连 TCP 而不是「子进程 → 主进程 → 子进程」两跳 RPC:
//   - 音频面是 172KB/s/设备的稳态流量(48k/2ch/s16),经主进程 JSON+base64 转发
//     要多两次序列化、还要主进程事件循环陪着走,和「把重负载搬出主进程」的初衷相反;
//   - TCP 直连天然有背压(socket.writableLength),两跳 RPC 只能靠丢帧;
//   - 控制面(起播/停止/seek/音量)仍走既有 supervisor RPC,音频面独立成管道。
//
// 帧格式(小端无关,统一大端定长头,便于对端零歧义解析):
//   [u32 len][u8 type][u64 tsUs][payload]
//   len = 1 + 8 + payload.length
//   type 0 HELLO:payload = UTF-8 JSON {group, devices, rate, channels, bits}
//   type 1 PCM  :tsUs = 该帧起始时刻(pump 时间线),payload = s16le 交错
//   type 2 RESET:payload = UTF-8 JSON {positionMs}(seek / 切歌重新锚定)
//   type 3 STOP :无 payload
import * as net from "net";
import { CHANNELS, SAMPLE_RATE } from "./encoding.js";
import type { PumpSink } from "./sink.js";

const TYPE_HELLO = 0;
const TYPE_PCM = 1;
const TYPE_RESET = 2;
const TYPE_STOP = 3;

/** 背压阈值:未写出字节超过该值就丢帧(音频是**可丢**的:airplay 侧按墙钟取内容,
 *  丢掉的帧只会让该设备的缓冲浅一点,不会造成时间线漂移)。 */
const MAX_INFLIGHT_BYTES = 1_000_000;
/** 重连退避。 */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5_000;

export interface AirPlayBridgeSinkOptions {
  /** pump 组名(`ug:<groupId>`)。 */
  group: string;
  /** 本次要喂的 airplay 设备(裸 deviceId)。 */
  devices: string[];
  host: string;
  port: number;
  onLog?: (level: "info" | "warn" | "error", msg: string) => void;
}

export class AirPlayBridgeSink implements PumpSink {
  readonly id = "airplay";
  private readonly opts: AirPlayBridgeSinkOptions;
  private socket: net.Socket | null = null;
  private connected = false;
  /** 已连接过一次(用于 hello 重放:重连后对端不认识本组)。 */
  private helloSent = false;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private dropped = 0;
  private droppedLoggedAt = 0;

  constructor(opts: AirPlayBridgeSinkOptions) {
    this.opts = opts;
    this.connect();
  }

  /** 建立(或重建)到 airplay 子进程的连接。 */
  private connect(): void {
    if (this.stopped) return;
    const sock = net.connect({ host: this.opts.host, port: this.opts.port });
    sock.setNoDelay(true); // 25ms 级音频帧不能等 Nagle 合包
    this.socket = sock;
    sock.on("connect", () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.helloSent = true;
      this.sendFrame(TYPE_HELLO, 0n, Buffer.from(JSON.stringify({
        group: this.opts.group,
        devices: this.opts.devices,
        rate: SAMPLE_RATE,
        channels: CHANNELS,
        bits: 16,
      })));
      this.log("info", `airplay 桥接已连接 ${this.opts.host}:${this.opts.port} group=${this.opts.group} devices=${this.opts.devices.join(",")}`);
    });
    sock.on("error", (e) => {
      // 对端未起 / 被重启:交给 close 统一退避重连,这里只记一次(避免刷屏)。
      this.connected = false;
      if (this.reconnectTimer === null) {
        this.log("warn", `airplay 桥接连接异常: ${(e as Error)?.message || e}`);
      }
    });
    sock.on("close", () => {
      this.connected = false;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(this.reconnectDelay * 2));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private sendFrame(type: number, tsUs: bigint, payload: Buffer): void {
    const sock = this.socket;
    if (!sock || !this.connected || sock.destroyed) return;
    if (sock.writableLength > MAX_INFLIGHT_BYTES) {
      this.dropped++;
      const now = Date.now();
      if (now - this.droppedLoggedAt > 5_000) {
        this.droppedLoggedAt = now;
        this.log("warn", `airplay 桥接背压丢帧 ${this.dropped} 帧(未写出 ${sock.writableLength}B)`);
        this.dropped = 0;
      }
      return;
    }
    const head = Buffer.allocUnsafe(13);
    head.writeUInt32BE(1 + 8 + payload.length, 0);
    head.writeUInt8(type, 4);
    head.writeBigUInt64BE(tsUs < 0n ? 0n : tsUs, 5);
    try {
      sock.write(head);
      if (payload.length > 0) sock.write(payload);
    } catch (e) {
      this.log("warn", `airplay 桥接写入失败: ${(e as Error)?.message || e}`);
    }
  }

  /** pump 帧 → s16le → 发送。**同步完成,不 await**:pushLoop 的 25ms 节拍不能被它拖慢。 */
  onFrame(tsUs: bigint, pcm: Float32Array): void {
    if (!this.connected) return;
    const buf = Buffer.allocUnsafe(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) {
      const s = pcm[i];
      // 与 encoding.ts 的 s16 量化同口径:先钳位再取整,避免溢出回绕成爆音。
      const v = s >= 1 ? 32767 : s <= -1 ? -32768 : Math.round(s * 32768);
      buf.writeInt16LE(v < -32768 ? -32768 : v > 32767 ? 32767 : v, i * 2);
    }
    this.sendFrame(TYPE_PCM, tsUs, buf);
  }

  onReset(positionMs?: number): void {
    this.sendFrame(TYPE_RESET, 0n, Buffer.from(JSON.stringify({ positionMs: positionMs ?? 0 })));
  }

  onStop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sendFrame(TYPE_STOP, 0n, Buffer.alloc(0));
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch { /* ignore */ }
    this.socket = null;
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    if (this.opts.onLog) this.opts.onLog(level, msg);
    else if (level === "info") console.log(`[airplay-bridge] ${msg}`);
    else if (level === "warn") console.warn(`[airplay-bridge] ${msg}`);
    else console.error(`[airplay-bridge] ${msg}`);
  }
}
