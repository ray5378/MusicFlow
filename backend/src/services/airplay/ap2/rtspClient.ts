// ==================== AP2 RTSP 客户端（Phase 6b 批 2）====================
//
// AP2 控制通道（对端 bed ap2-receiver.py AP2Handler 逐字对齐）：
//   - 明文阶段：RTSP/1.0 直连（/pair-pin-start、/pair-setup、/pair-verify）。
//   - 加密阶段：pair-verify 成功后整条 TCP 升级 HapChannel，之后所有 RTSP 在其上。
//   - 请求-响应模式（controller 发、accessory 答）；CSeq 自增。
//   - 权威会话序列（transient/凭据同构）：
//       POST /pair-pin-start (octet-stream, CL=0)          ← PIN 配对前
//       POST /pair-setup (application/pairing+tlv8) ×N     ← M1/M3/M5
//       POST /pair-verify (application/pairing+tlv8) ×2    ← M1/M3
//       SETUP <rtsp://host/<connID>> RTSP/1.0 (bplist session: timingPort/timingProtocol)
//         → 200 bplist {eventPort}
//       RECORD <同 URL> RTSP/1.0 (CL=0)
//         → 200
//       SETUP 同 URL (bplist streams:[{type:96(realtime), ct:2(ALAC), sr, spf, shk, shiv,
//          controlPort, dataPort, streamConnectionID, latencyMin/Max, audioMode, isMedia}])
//         → 200 bplist {streams:[{controlPort, dataPort, streamID, type}]}
//       之后 /feedback 定期（二进制 plist 状态上报）。
// 通用头：User-Agent: AirPlay/670.6.2 / DACP-ID / Active-Remote / X-Apple-HKP。
//
// 【批 6b-C：轮询 → 事件驱动派发】
//   旧实现 `exchange()` 里 `await new Promise(r => setTimeout(r, 10))` 拉取响应，
//   响应到达后要等下一个 10ms 网格才被 `extract()` 拿走 ⇒ 每次往返引入
//   0~10ms 不定的尾延迟。握手 4~6 次往返叠加后，实测「ready→首包」
//   极差 30.35ms（6.23 / 13.49 / 32.51 / 35.24 / 36.58）。
//   现改为：`feed(chunk)` 收到字节立即 `push` + 抽干 `extract()` + `dispatch()`，
//   按 CSeq 配对唤醒对应在途请求 ⇒ 响应到达即 resolve，零固定延迟。
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { createLogger } from "../../../utils/logger.js";
import { HapChannel } from "./hapSocket.js";

export const RTSP_USER_AGENT = "AirPlay/670.6.2";

const log = createLogger("airplay-rtsp");

export interface RtspResponse {
  status: number;
  statusText: string;
  headers: Map<string, string>; // 小写化
  body: Buffer;
}

export class RtspError extends Error {
  constructor(message: string, public readonly status = 0) {
    super(message);
    this.name = "RtspError";
  }
}

/** 连接级通用头（DACP/Active-Remote 等）。 */
export interface RtspCommonHeaders {
  dacpId: string;
  activeRemote: string;
  /** X-Apple-HKP（2=HomeKit pair-verify 会话、4=transient）。 */
  hkp: number;
}

type BodySource = Buffer | string | null;

/** 请求-响应解析器（明文 TCP 或 HapChannel 之上共用）。 */
export class HttpFramer {
  private buf: Buffer = Buffer.alloc(0);

  /** 尝试从缓冲提取一个完整报文；不足返回 null。 */
  extract(): { bytesConsumed: number; head: string; body: Buffer } | null {
    const headEnd = this.buf.indexOf("\r\n\r\n");
    if (headEnd < 0) return null;
    const head = this.buf.toString("latin1", 0, headEnd);
    let contentLength = 0;
    for (const line of head.split("\r\n")) {
      const m = /^content-length:\s*(\d+)\s*$/i.exec(line);
      if (m) contentLength = Number(m[1]);
    }
    const total = headEnd + 4 + contentLength;
    if (this.buf.length < total) return null;
    const body = Buffer.from(this.buf.subarray(headEnd + 4, total));
    this.buf = this.buf.subarray(total);
    return { bytesConsumed: total, head, body };
  }

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  get buffered(): number {
    return this.buf.length;
  }
}

export function buildRequest(opts: {
  method: string;
  url: string;
  cseq: number;
  common: RtspCommonHeaders;
  contentType?: string;
  body?: BodySource;
  extraHeaders?: Record<string, string>;
}): Buffer {
  const body = opts.body === null || opts.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(opts.body)
    ? opts.body
    : Buffer.from(opts.body, "utf8");
  const lines: string[] = [
    `${opts.method} ${opts.url} RTSP/1.0`,
    `CSeq: ${opts.cseq}`,
    `User-Agent: ${RTSP_USER_AGENT}`,
    `DACP-ID: ${opts.common.dacpId}`,
    `Active-Remote: ${opts.common.activeRemote}`,
    `X-Apple-HKP: ${opts.common.hkp}`,
  ];
  if (opts.contentType) lines.push(`Content-Type: ${opts.contentType}`);
  if (opts.extraHeaders) {
    for (const [k, v] of Object.entries(opts.extraHeaders)) lines.push(`${k}: ${v}`);
  }
  lines.push(`Content-Length: ${body.length}`);
  return Buffer.concat([Buffer.from(lines.join("\r\n") + "\r\n\r\n", "latin1"), body]);
}

/** 解析响应/请求头。 */
function parseHead(head: string): { startLine: string; headers: Map<string, string> } {
  const lines = head.split("\r\n");
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i]!.indexOf(":");
    if (idx > 0) {
      headers.set(lines[i]!.slice(0, idx).trim().toLowerCase(), lines[i]!.slice(idx + 1).trim());
    }
  }
  return { startLine: lines[0]!, headers };
}

/** 在途请求（按 CSeq 索引；SETUP 与 /feedback 可能同时在途，故用 Map 不用单槽）。 */
interface PendingRequest {
  resolve: (r: RtspResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  what: string;
}

/** AP2 RTSP 会话：单一 TCP 连接（明文 → pair-verify → HAP 加密升级）。 */
export class Ap2RtspClient extends EventEmitter {
  private socket: Socket | null = null;
  private channel: HapChannel | null = null;
  private readonly framer = new HttpFramer();
  private cseq = 0;
  private dataHandler: ((chunk: Buffer) => void) | null = null;
  /** 已发出过 'close'（底层 socket 关闭只上报一次，避免双通道重复）。 */
  private closeEmitted = false;
  /** 主动 destroy() 时置位：不把「我方拆除」误报成「链路断开」。 */
  private intentionalClose = false;
  /** 在途请求表（CSeq → waiter）。响应到达即按 CSeq 唤醒对应条目。 */
  private readonly pending = new Map<number, PendingRequest>();

  /** 已连接并（可选）加密升级后的底层 socket。 */
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  get encrypted(): boolean {
    return this.channel !== null;
  }

  /** 当前在途请求数（诊断用；测试用于确认无悬挂 waiter）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 连接明文 TCP。 */
  async connect(host: string, port: number): Promise<void> {
    const net = await import("node:net");
    this.closeEmitted = false;
    this.intentionalClose = false;
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const s = net.createConnection({ host, port }, () => resolve(s));
      s.on("error", reject);
    });
    this.socket.setNoDelay(true);
    this.attachSocket(this.socket);
  }

  /** pair-verify 成功后调用：整条连接升级 HAP 加密。 */
  upgradeToEncrypted(sharedKey: Buffer): void {
    if (!this.socket) throw new RtspError("未连接");
    // 关键：摘除明文阶段的原始 data 监听，否则密文会同时灌进 framer。
    if (this.dataHandler) {
      this.socket.removeListener("data", this.dataHandler);
      this.dataHandler = null;
    }
    this.channel = new HapChannel(this.socket, sharedKey);
    // 重新挂接：HapChannel 上的明文 → framer
    this.channel.on("data", (plain: Buffer) => this.feed(plain));
    this.channel.on("error", (e: Error) => this.emit("error", e));
    // 加密通道关闭 = 控制面链路断开（RECORD 中途断链的检测点）。
    this.channel.on("close", () => this.emitClose());
  }

  private attachSocket(socket: Socket): void {
    this.dataHandler = (chunk: Buffer) => this.feed(chunk);
    socket.on("data", this.dataHandler);
    socket.on("error", (e: Error) => this.emit("error", e));
    socket.on("close", () => this.emitClose());
  }

  /** 链路关闭上报（幂等；主动 destroy 不上报 'close'）。 */
  private emitClose(): void {
    // 不论是否上报 'close'，链路断开都必须立刻唤醒在途请求：
    // 否则调用方要白等满 timeoutMs（默认 8s）才知道失败。
    this.rejectPending(new RtspError("链路已关闭"));
    if (this.closeEmitted || this.intentionalClose) return;
    this.closeEmitted = true;
    this.emit("close");
  }

  /**
   * 收到字节流：入缓冲 → 抽干所有完整报文 → 逐个派发。
   *
   * 抽干是硬要求：一次 data 事件里可能挤着 2 个响应（背靠背到达），
   * 只取一个会让第二个滞留到下次 data，退化成「等下一个事件」的老毛病。
   * 残留的半个报文留在 framer 缓冲里，等下一次 data 补齐。
   */
  private feed(chunk: Buffer): void {
    this.framer.push(chunk);
    for (;;) {
      const got = this.framer.extract();
      if (!got) break;
      this.dispatch(got.head, got.body);
    }
  }

  /** 分派一个完整报文：响应按 CSeq 配对唤醒在途请求，其余按规则丢弃。 */
  private dispatch(head: string, body: Buffer): void {
    const { startLine, headers } = parseHead(head);
    const matched = /^RTSP\/1\.0\s+(\d+)\s*(.*)$/.exec(startLine);
    if (!matched) {
      // 反向请求（accessory → controller，形如 `OPTIONS * RTSP/1.0`）：
      // 批 4 的会话序列里对端不会主动发请求，收到即丢弃；
      // 批 5 若要接 EVENT（/event 通知），在此分支前置处理，别改动响应路径。
      if (/^[A-Z]+\s+\S+\s+RTSP\/1\.0$/i.test(startLine)) {
        const method = startLine.split(" ")[0] ?? "";
        const url = startLine.split(" ")[1] ?? "";
        log.debug(`丢弃反向请求 ${JSON.stringify({ method, url })}`);
        return;
      }
      // 既不是响应也不是反向请求 = 报文损坏；没有调用方可以抛，只能告警后丢弃。
      log.warn(`非法报文起始行，丢弃 ${JSON.stringify({ startLine })}`);
      return;
    }
    const response: RtspResponse = {
      status: Number(matched[1]),
      statusText: matched[2] ?? "",
      headers,
      body,
    };
    const rawCseq = headers.get("cseq");
    const cseqNum = rawCseq === undefined ? Number.NaN : Number(rawCseq);
    if (!Number.isNaN(cseqNum)) {
      const entry = this.pending.get(cseqNum);
      if (entry) {
        this.settle(cseqNum, entry, response);
        return;
      }
      // CSeq 对不上：绝不猜。错配唤醒比超时更糟（会把 SETUP 的响应喂给 RECORD）。
      log.debug(`响应 CSeq 无在途请求，丢弃 ${JSON.stringify({
        cseq: cseqNum,
        startLine,
        pending: this.pending.size,
      })}`);
      return;
    }
    // 宽松兜底：对端（含老固件/假 accessory）可能不回显 CSeq。
    // 只有在途恰好 1 条时才敢认领；多条在途时认领等于抛硬币，宁可丢弃等超时。
    if (this.pending.size === 1) {
      const only = [...this.pending.entries()][0]!;
      log.debug(`响应缺 CSeq，单在途兜底 ${JSON.stringify({ want: only[0], what: only[1].what })}`);
      this.settle(only[0], only[1], response);
      return;
    }
    log.debug(`响应缺 CSeq 且多请求在途，丢弃 ${JSON.stringify({
      startLine,
      pending: this.pending.size,
    })}`);
  }

  /** 结算一条在途请求（清定时器 → 摘表 → resolve）。 */
  private settle(cseq: number, entry: PendingRequest, resp: RtspResponse): void {
    clearTimeout(entry.timer);
    this.pending.delete(cseq);
    entry.resolve(resp);
  }

  /** 无条件唤醒全部在途请求（链路关闭 / 主动拆除）。 */
  private rejectPending(err: Error): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  /**
   * 一次请求-响应往返（带超时）。
   *
   * 先登记 waiter 再写请求：事件驱动下响应可能在 `write()` 返回后、`await` 之前
   * 就通过 data 事件派发进来，若先写后登记会直接错配成超时。
   * 返回的 Promise 由 `dispatch()` 唤醒 —— 没有轮询，没有固定延迟。
   */
  private exchange(
    cseq: number,
    wire: Buffer,
    opts: { timeoutMs: number; what: string },
  ): Promise<RtspResponse> {
    const wait = new Promise<RtspResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cseq);
        reject(new RtspError(`${opts.what}: 超时`));
      }, opts.timeoutMs);
      this.pending.set(cseq, { resolve, reject, timer, what: opts.what });
    });
    try {
      this.transport().write(wire);
    } catch (e) {
      // 写失败不能吞成「等到 8s 超时」：那会把一个立即可定位的 EPIPE
      // 伪装成设备不响应，实测时极难分辨。摘掉 waiter 后原样上抛。
      const entry = this.pending.get(cseq);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(cseq);
      }
      wait.catch(() => undefined); // 避免这条已废弃的 promise 冒 unhandledRejection
      throw e;
    }
    return wait;
  }

  /** 发请求并等待匹配响应（按 CSeq 配对；支持多请求并发在途）。 */
  async request(opts: {
    method: string;
    url: string;
    common: RtspCommonHeaders;
    contentType?: string;
    body?: BodySource;
    extraHeaders?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<RtspResponse> {
    if (!this.connected) throw new RtspError("未连接");
    const cseq = ++this.cseq;
    const wire = buildRequest({ ...opts, cseq });
    const what = `${opts.method} ${opts.url}`;
    const resp = await this.exchange(cseq, wire, { timeoutMs: opts.timeoutMs ?? 8000, what });
    if (resp.status >= 400) {
      throw new RtspError(`${what} → ${resp.status} ${resp.statusText}`, resp.status);
    }
    return resp;
  }

  private transport(): { write(b: Buffer): void } {
    return this.channel ?? (this.socket as Socket);
  }

  destroy(): void {
    this.intentionalClose = true;
    // 先唤醒在途请求：destroy 的语义是「链路没了」，调用方不该再等。
    this.rejectPending(new RtspError("链路已关闭"));
    this.channel?.destroy();
    this.socket?.destroy();
    this.channel = null;
    this.socket = null;
  }
}
