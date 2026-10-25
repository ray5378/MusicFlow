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
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { HapChannel } from "./hapSocket.js";

export const RTSP_USER_AGENT = "AirPlay/670.6.2";

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

/** 一次请求-响应往返（带超时）。 */
async function exchange(
  transport: { write(b: Buffer): void },
  framer: HttpFramer,
  wire: Buffer,
  opts: { timeoutMs: number; what: string },
): Promise<RtspResponse> {
  transport.write(wire);
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const got = framer.extract();
    if (got) {
      const { startLine, headers } = parseHead(got.head);
      const m = /^RTSP\/1\.0\s+(\d+)\s*(.*)$/.exec(startLine);
      if (!m) throw new RtspError(`${opts.what}: 非法响应行 ${startLine}`);
      return { status: Number(m[1]), statusText: m[2] ?? "", headers, body: got.body };
    }
    if (Date.now() > deadline) throw new RtspError(`${opts.what}: 超时`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** AP2 RTSP 会话：单一 TCP 连接（明文 → pair-verify → HAP 加密升级）。 */
export class Ap2RtspClient extends EventEmitter {
  private socket: Socket | null = null;
  private channel: HapChannel | null = null;
  private readonly framer = new HttpFramer();
  private cseq = 0;
  private dataHandler: ((chunk: Buffer) => void) | null = null;

  /** 已连接并（可选）加密升级后的底层 socket。 */
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  get encrypted(): boolean {
    return this.channel !== null;
  }

  /** 连接明文 TCP。 */
  async connect(host: string, port: number): Promise<void> {
    const net = await import("node:net");
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
  }

  private attachSocket(socket: Socket): void {
    this.dataHandler = (chunk: Buffer) => this.feed(chunk);
    socket.on("data", this.dataHandler);
    socket.on("error", (e: Error) => this.emit("error", e));
  }

  private feed(chunk: Buffer): void {
    // 只缓冲；请求-响应由 exchange() 统一拉取（避免双向抢占）。
    // 批 4 如需处理 accessory 反向请求（EVENT），在此处先于 exchange 分派。
    this.framer.push(chunk);
  }

  /** 发请求并等待匹配响应（简单模式：假设无穿插的反向请求）。 */
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
    const wire = buildRequest({ ...opts, cseq: ++this.cseq });
    const resp = await exchange(this.transport(), this.framer, wire, {
      timeoutMs: opts.timeoutMs ?? 8000,
      what: `${opts.method} ${opts.url}`,
    });
    if (resp.status >= 400) {
      throw new RtspError(`${opts.method} ${opts.url} → ${resp.status} ${resp.statusText}`, resp.status);
    }
    return resp;
  }

  private transport(): { write(b: Buffer): void } {
    return this.channel ?? (this.socket as Socket);
  }

  destroy(): void {
    this.channel?.destroy();
    this.socket?.destroy();
    this.channel = null;
    this.socket = null;
  }
}
