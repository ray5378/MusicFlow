// ==================== event/timing 通道保活 + NTP 请求（Phase 6b 批 3）====================
//
// 对端 ap2/connections/event.py EventGeneric：TCP accept 后**纯排水**（收到即丢）。
// sender 职责：
//   - SETUP（session）响应 eventPort、SETUP（stream）响应含 timingPort（NTP 模式）
//     —— 两条 TCP 连接必须建立并保活（bed accept() 只收一个连接，断开不重收）。
//   - timing 连接上周期写 NTP 请求报文（32B RAOP timing 形态；bed 丢弃，
//     真机按响应计算时钟偏移 —— 响应处理批 4/真机 e2e 再补）。
//
// NTP 请求包（32B，经典 RAOP timing 形态，大端）：
//   [0]=0x80 [1]=0xd3 [2..3]=seq [4..7]=0
//   [8..15]  = 上次应答时间（首包 0）
//   [16..23] = 本端发送时刻（NTP 64bit：1900 纪元秒 ++ 分数）
//   [24..31] = 0（保留）
import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";

const NTP_EPOCH_OFFSET_S = 2208988800; // 1900→1970

export class TimingNtpError extends Error {}

/** NTP 64bit 时间戳（秒.分数）→ 8B 大端。 */
export function ntpTimestamp(nowMs: number): Buffer {
  const buf = Buffer.alloc(8);
  const sec = Math.floor(nowMs / 1000) + NTP_EPOCH_OFFSET_S;
  const frac = Math.round(((nowMs % 1000) / 1000) * 2 ** 32);
  buf.writeUInt32BE(sec >>> 0, 0);
  buf.writeUInt32BE(frac >>> 0, 4);
  return buf;
}

/** 构造 32B NTP timing 请求。 */
export function buildNtpRequest(seq: number, lastReplyTs: Buffer, nowMs: number): Buffer {
  if (lastReplyTs.length !== 8) throw new TimingNtpError("lastReplyTs 必须 8B");
  const pkt = Buffer.alloc(32);
  pkt[0] = 0x80;
  pkt[1] = 0xd3; // timing 请求（经典 RAOP 形态）
  pkt.writeUInt16BE(seq & 0xffff, 2);
  lastReplyTs.copy(pkt, 8);
  ntpTimestamp(nowMs).copy(pkt, 16);
  return pkt;
}

/** 单条 TCP 排水通道：连接、保活、断线重连（指数退避封顶 2s）。 */
class DrainChannel extends EventEmitter {
  private socket: Socket | null = null;
  /** 在途 dial 的 socket（connect 回调未到之前）。destroy() 必须一并销毁，
   *  否则会漏一条 TCP，且回调随后把 socket 落成 ⇒ connected 被置回 true。 */
  private pending: Socket | null = null;
  private host = "";
  private port = 0;
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  async connect(host: string, port: number): Promise<void> {
    this.host = host;
    this.port = port;
    this.closed = false;
    await this.dial();
  }

  private dial(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const s = createConnection({ host: this.host, port: this.port }, () => {
        // destroy() 可能抢在 connect 回调之前发生：此时不得落成 socket，
        // 也不得注册 close ⇒ 不重连；更不得把 connected 置回 true。
        if (this.closed || this.pending !== s) {
          s.destroy();
          settle(); // 已收敛，resolve 以免调用方 await 挂死
          return;
        }
        this.pending = null;
        this.retry = 0;
        this.socket = s;
        s.on("data", () => {
          /* 排水 */
        });
        s.on("close", () => this.scheduleReconnect());
        s.on("error", () => {
          /* close 会跟随触发 */
        });
        settle();
      });
      this.pending = s;
      s.once("error", (e: Error) => {
        if (this.pending === s) this.pending = null;
        // 已 destroy：收敛（不上抛，也不重连）
        if (this.closed) settle();
        else {
          settled = true;
          reject(e);
        }
      });
      s.once("close", () => {
        // destroy() 在途时：socket 既不触发 connect 也不报错，只触发 close
        // ⇒ 必须在这里兜底，否则 dial() 的 promise 永不 settle（调用方 await 挂死）。
        if (this.closed) settle();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.socket = null;
    const delay = Math.min(2000, 100 * 2 ** this.retry++);
    this.timer = setTimeout(() => {
      this.dial().catch(() => this.scheduleReconnect());
    }, delay);
  }

  /** 写报文（未连接则丢弃本包，重连在后台进行）。 */
  write(pkt: Buffer): void {
    this.socket?.write(pkt);
  }

  destroy(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.destroy();
    this.socket = null;
    this.pending?.destroy(); // 在途 dial：一并销毁，杜绝漏一条 TCP
    this.pending = null;
  }

  get connected(): boolean {
    return this.socket !== null;
  }
}

/** event + timing 双通道管理：SETUP 后 connect()，之后 startNtp() 周期发请求。 */
export class EventTimingChannels {
  private readonly event = new DrainChannel();
  private readonly timing = new DrainChannel();
  private ntpTimer: ReturnType<typeof setInterval> | null = null;
  private ntpSeq = 0;
  private readonly lastReply = Buffer.alloc(8);

  /** 建立两条 TCP（eventPort 来自 session SETUP 响应、timingPort 为我们声明的 NTP 端口）。 */
  async connect(host: string, opts: { eventPort: number; timingPort: number }): Promise<void> {
    await Promise.all([
      this.event.connect(host, opts.eventPort),
      this.timing.connect(host, opts.timingPort),
    ]);
  }

  /** 周期发 NTP 请求（默认 1s，与 cliairplay 节奏同量级）。 */
  startNtp(intervalMs = 1000): void {
    if (this.ntpTimer) return;
    this.ntpTimer = setInterval(() => {
      this.timing.write(buildNtpRequest(this.ntpSeq++, this.lastReply, Date.now()));
    }, intervalMs);
    this.ntpTimer.unref?.();
  }

  stopNtp(): void {
    if (this.ntpTimer) clearInterval(this.ntpTimer);
    this.ntpTimer = null;
  }

  destroy(): void {
    this.stopNtp();
    this.event.destroy();
    this.timing.destroy();
  }

  get ntpConnected(): boolean {
    return this.timing.connected;
  }
}
