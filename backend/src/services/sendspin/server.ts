// ==================== Sendspin 服务端 (WebSocket 监听 + Noise initiator) ====================
//
// 服务器是 Sendspin 协议里的 **监听方 + Noise initiator**:
//   - 用 `ws` 的 `WebSocketServer` 监听 `:8927/sendspin`,接受客户端拨入;
//   - 明文 TEXT 期:收 `client/init` → 回 `server/init`（prologue = 二者原文拼接）;
//   - 服务端做 initiator:写 msg1（负载 `{psk_id, psk_category}`）→ 读 msg2（明文 `{}`）;
//   - 之后进入加密 transport 期(JSON 帧 = [0x00]+json;二进制帧由调用方带类型字节);
//   - post-handshake:server/hello → client/hello → server/activate → 业务数据。
//
// 分组同步推流保留:解码 → 逐客户端独立编码 → 按组公共时间戳下发(group.pushFrame)。

import WebSocket, { WebSocketServer } from "ws";
import { loadOrCreateIdentity, type Identity } from "./identity.js";
import { asInitiator, handshakePayload1, type NoiseSession, type NoiseSuite } from "./handshake.js";
import { packJsonBody, unpackJsonBody, packAudioChunk, type JsonMessage } from "./framing.js";
import {
  WS_PATH,
  WS_PORT,
  PROTOCOL_VERSION,
  BIN_JSON,
  BIN_FRAGMENT_MORE,
  BIN_FRAGMENT_END,
  MAX_TRANSPORT_PLAINTEXT,
  MAX_REASSEMBLED_BYTES,
} from "./constants.js";
import { nowUs } from "./clock.js";
import { MessageRouter } from "./messages.js";
import "./roles/index.js";
import { negotiateRoles } from "./roles/registry.js";
import { createChunkEncoder, type ChunkEncoder, OPUS_FRAME_MS, type SendspinCodec } from "./encoding.js";
import { computeCommonSendAhead } from "./group.js";
import { b64urlDecode, b64urlEncode } from "./util.js";

export interface SendspinServerOptions {
  pairkeys: Identity;
  identityDir?: string;
  pairingPskHex?: string;
  serverName?: string;
  log?: SendspinLog;
  /** 连接完成 server/activate（播放器可用）后的回调——用于注册 QueueController 播放器。 */
  onActivated?: (conn: SendspinConnection) => void;
  /** 连接关闭（含握手失败/断流）后的清理回调。 */
  onClosed?: (conn: SendspinConnection) => void;
}

export type SendspinLog = (level: "info" | "warn" | "error", msg: string) => void;

const defaultLog: SendspinLog = (level, msg) => {
  if (level === "error") console.error(`[sendspin] ${msg}`);
  else console.log(`[sendspin] ${msg}`);
};

export const DEFAULT_SUITE: NoiseSuite = "25519_ChaChaPoly_SHA256";

export class SendspinServer {
  identity: Identity;
  log: SendspinLog;
  readonly clients = new Map<string, SendspinConnection>();
  readonly groups = new Map<string, SendspinGroup>();
  pairingPsk: Uint8Array;
  serverName: string;
  router = new MessageRouter();
  port: number;
  wss: WebSocketServer | null = null;
  private onActivated?: (conn: SendspinConnection) => void;
  private onClosed?: (conn: SendspinConnection) => void;

  constructor(opts: SendspinServerOptions, log?: SendspinLog) {
    this.identity = opts.pairkeys;
    this.log = log ?? opts.log ?? defaultLog;
    this.pairingPsk = Buffer.from(
      opts.pairingPskHex && opts.pairingPskHex.length === 64 ? opts.pairingPskHex : "1b5e24dbc1aed95fc2a5a338a90c05df44bd10f5ec1f4cd66cbf86272767b9d3",
      "hex",
    );
    this.serverName = opts.serverName ?? "MusicFlow Sendspin";
    this.port = WS_PORT;
    this.onActivated = opts.onActivated;
    this.onClosed = opts.onClosed;
  }

  get serverId(): string {
    return this.identity.serverId;
  }

  static async create(opts: SendspinServerOptions, log?: SendspinLog): Promise<SendspinServer> {
    const srv = new SendspinServer(opts, log);
    if (srv.identity.privateKey.length === 0 && opts.identityDir) {
      srv.identity = await loadOrCreateIdentity(opts.identityDir);
    }
    return srv;
  }

  /** 绑定 WebSocketServer 于 `:port/sendspin`。幂等;监听失败 reject。 */
  async listen(port = this.port): Promise<void> {
    if (this.wss) return;
    this.port = port;
    const wss = new WebSocketServer({ port, path: WS_PATH, maxPayload: MAX_REASSEMBLED_BYTES });
    wss.on("connection", (ws) => this.onClientConnect(ws));
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", (e) => reject(e));
    });
    this.wss = wss;
    this.log("info", `sendspin listening ws://0.0.0.0:${port}${WS_PATH} (server_id=${this.serverId})`);
  }

  private onClientConnect(ws: WebSocket): void {
    const conn = new SendspinConnection(this, ws);
    this.log("info", `new connection from ${ws.url ?? "(client)"}`);
  }

  /** 连接完成 server/activate 后注册为可播播放器(由 index.ts 注入)。 */
  onConnectionActivated(conn: SendspinConnection): void {
    this.clients.set(conn.clientId!, conn);
    this.onActivated?.(conn);
  }

  onConnectionClosed(conn: SendspinConnection): void {
    if (conn.clientId) this.clients.delete(conn.clientId);
    if (conn.group) {
      const g = conn.group;
      conn.group = null;
      g.remove(conn);
      if (g.empty) this.groups.delete(g.name);
    }
    this.onClosed?.(conn);
  }

  group(name: string): SendspinGroup {
    let g = this.groups.get(name);
    if (!g) {
      g = new SendspinGroup(name, this);
      this.groups.set(name, g);
    }
    return g;
  }

  broadcastGroupState(g: SendspinGroup): void {
    const sendAhead = computeCommonSendAhead([...g.members].map((c) => ({ latencyFuncMs: c.latencyFuncMs })));
    const stamp = nowUs();
    for (const c of g.members) {
      c.sendJson("server/state", {
        group: { id: g.name, members: [...g.members].map((m) => ({ client_id: m.clientId })) },
        volume: c.appliedGain(),
        muted: c.muted || g.muted,
        position_ms: g.positionMs,
        send_ahead: sendAhead,
        timestamp: stamp,
      });
    }
  }

  stop(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
    for (const g of this.groups.values()) g.close();
    this.groups.clear();
    this.wss?.close();
    this.wss = null;
  }
}

export class SendspinGroup {
  name: string;
  server: SendspinServer;
  members = new Set<SendspinConnection>();
  volume = 100;
  muted = false;
  positionMs = 0;
  timelineBaseUs = 0n;
  /** 当前播曲(由 ProtocolPlayer.playMedia 写入,供 pollState/自动切歌判定)。 */
  current: { songId: string; title?: string; artist?: string; durationMs: number } | null = null;
  private encoders = new Map<string, ChunkEncoder>();

  constructor(name: string, server: SendspinServer) {
    this.name = name;
    this.server = server;
  }
  add(c: SendspinConnection): void {
    this.members.add(c);
  }
  remove(c: SendspinConnection): void {
    this.members.delete(c);
  }
  get empty(): boolean {
    return this.members.size === 0;
  }
  appliedGain(c: SendspinConnection): number {
    if (this.muted || c.muted) return 0;
    return Math.min(100, Math.max(0, Math.round((c.volume * this.volume) / 100)));
  }
  encoderFor(c: SendspinConnection): ChunkEncoder {
    const key = `${c.clientId}:${c.codec}`;
    let e = this.encoders.get(key);
    if (!e) {
      e = createChunkEncoder(c.codec);
      this.encoders.set(key, e);
    }
    return e;
  }
  private scalePcm(pcm: Float32Array, gain: number): Float32Array {
    const g = gain / 100;
    if (g >= 1) return pcm;
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * g;
    return out;
  }
  async pushFrame(tsUs: bigint, pcm: Float32Array): Promise<void> {
    for (const c of this.members) {
      const gain = c.appliedGain();
      const enc = this.encoderFor(c);
      const chunks = await enc.encode(this.scalePcm(pcm, gain));
      // opus 每 20ms 一裸包;多包时时间戳按帧长递增,对齐 MA 每包一次性的 psg 推送。
      chunks.forEach((data, i) => {
        c.sendAudio(tsUs + BigInt(i * OPUS_FRAME_MS) * 1000n, data);
      });
    }
  }
  close(): void {
    for (const e of this.encoders.values()) e.close();
    this.encoders.clear();
  }
}

export class SendspinConnection {
  id: string;
  clientId: string | null = null;
  name = "";
  server: SendspinServer;
  private ws: WebSocket;
  noise: NoiseSession | null = null;
  handshakeDone = false;
  group: SendspinGroup | null = null;
  codec: SendspinCodec = "opus";
  volume = 100;
  muted = false;
  roles: string[] = [];
  latitude = 0;
  longitude = 0;
  latencyFuncMs = 30;
  clientHello: Record<string, any> | null = null;

  private phase: "init" | "handshake" | "ready" = "init";
  private clientInitText = "";
  private serverInitText = "";
  private reasm: Buffer | null = null;
  private reasmType = 0;

  constructor(server: SendspinServer, ws: WebSocket) {
    this.server = server;
    this.ws = ws;
    this.id = "";
    ws.on("message", (data, isBinary) => void this.onFrame(Buffer.from(data as Buffer), isBinary));
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      this.server.onConnectionClosed(this);
    });
  }

  get ready(): boolean {
    return this.ws.readyState === WebSocket.OPEN && this.handshakeDone;
  }

  /** 明文期(TEXT)与加密期(BINARY)的统一入口。 */
  async onFrame(data: Buffer, isBinary: boolean): Promise<void> {
    if (!this.handshakeDone) {
      this.handleCleartext(data, isBinary);
      return;
    }
    let plain: Uint8Array;
    try {
      plain = this.noise!.decrypt(data);
    } catch {
      this.server.log("error", `transport auth failed: ${this.clientId}`);
      this.ws.terminate();
      return;
    }
    if (plain.length === 0) return;
    const t = plain[0];
    if (t === BIN_FRAGMENT_MORE) return this._onMore(plain);
    if (t === BIN_FRAGMENT_END) return this._onEnd(plain);
    if (this.reasm) return;
    this._dispatch(plain);
  }

  // ---- 明文期: client/init → server/init+msg1; noise msg2 → 加密期 ----

  private handleCleartext(data: Buffer, isBinary: boolean): void {
    if (isBinary) return this.fail("unexpected binary frame during cleartext handshake");
    let msg: any;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return this.fail("malformed cleartext JSON");
    }
    const t = msg?.type;
    if (t === "client/init") {
      if (this.phase !== "init") return this.fail("duplicate client/init");
      this.beginHandshake(data.toString("utf8"), msg.payload);
    } else if (t === "noise/handshake") {
      if (this.phase !== "handshake") return this.fail("unexpected noise/handshake");
      this.completeHandshake(msg?.payload?.data);
    } else {
      this.fail(`unexpected cleartext frame: ${t}`);
    }
  }

  private beginHandshake(clientInitText: string, payload: any): void {
    if (!payload || payload.version !== PROTOCOL_VERSION)
      return this.fail("unsupported protocol version");
    const suite = payload.suite;
    if (suite && suite !== DEFAULT_SUITE) return this.fail(`unsupported suite: ${suite}`);
    const clientId = payload.client_id;
    if (typeof clientId !== "string" || clientId.length === 0) return this.fail("missing client_id");
    let clientPub: Uint8Array;
    try {
      clientPub = b64urlDecode(clientId);
      if (clientPub.length !== 32) throw new Error("bad length");
    } catch {
      return this.fail("invalid client_id (must be 43-char base64url X25519 pubkey)");
    }

    this.clientId = clientId;
    this.id = clientId;
    const serverInitText = JSON.stringify({
      type: "server/init",
      payload: { server_id: this.server.serverId, version: PROTOCOL_VERSION },
    });
    this.clientInitText = clientInitText;
    this.serverInitText = serverInitText;
    const prologue = new Uint8Array(
      Buffer.concat([Buffer.from(clientInitText, "utf8"), Buffer.from(serverInitText, "utf8")]),
    );
    this.noise = asInitiator({
      suite: DEFAULT_SUITE,
      localStaticPriv: this.server.identity.privateKey,
      remoteStaticPub: clientPub,
      prologue,
      psk: this.server.pairingPsk,
    });
    this.phase = "handshake";

    // server/init 紧跟 msg1(中间不等客户端,见参考 run_handshake_server)。
    this.sendCleartext(serverInitText);
    const msg1Pt = handshakePayload1(Buffer.from(this.server.pairingPsk).toString("hex"));
    const msg1Ct = this.noise!.writeMessage(msg1Pt);
    this.sendCleartext("noise/handshake", { data: b64urlEncode(msg1Ct) });
  }

  private completeHandshake(dataB64: string): void {
    let msg2Ct: Uint8Array;
    try {
      msg2Ct = typeof dataB64 === "string" ? b64urlDecode(dataB64) : new Uint8Array();
    } catch {
      return this.fail("malformed noise message 2 payload encoding");
    }
    let payload: Uint8Array;
    try {
      payload = this.noise!.readMessage(msg2Ct);
    } catch {
      return this.fail("noise message 2 failed authentication");
    }
    this.handshakeDone = true;
    this.phase = "ready";
    this.server.log("info", `handshake ok: ${this.clientId}`);
    // server/hello (加密)
    this.sendJson("server/hello", { name: this.server.serverName });
  }

  // ---- 加密期收发 ----

  private _onMore(plain: Uint8Array): void {
    if (this.reasm === null) {
      this.reasmType = plain[1] ?? 0;
      this.reasm = Buffer.from(plain.subarray(2));
    } else {
      this.reasm = Buffer.concat([this.reasm, plain.subarray(1)]);
    }
  }
  private _onEnd(plain: Uint8Array): void {
    if (this.reasm === null) return;
    this.reasm = Buffer.concat([this.reasm, plain.subarray(1)]);
    const body = new Uint8Array(Buffer.concat([Buffer.from([this.reasmType]), this.reasm]));
    this.reasm = null;
    this._dispatch(body);
  }
  private _dispatch(body: Uint8Array): void {
    if (body[0] === BIN_JSON) {
      const m = unpackJsonBody(body);
      if (m.type === "client/hello") {
        this.onClientHello(m.payload);
        return;
      }
      if (m.type === "client/time") {
        this.respondServerTime(m.payload);
        return;
      }
      void this.server.router.handle(m.type, { ...m.payload, _conn: this });
    }
    // 其它二进制(音频/artwork 等)当前无上行。
  }

  private onClientHello(payload: any): void {
    this.clientHello = payload ?? {};
    const hello: Record<string, any> = this.clientHello ?? {};
    const supported = Array.isArray(hello.supported_roles) ? hello.supported_roles : [];
    this.roles = negotiateRoles(supported);
    this.name = typeof hello.name === "string" ? hello.name : (this.clientId ?? "");
    this.server.log("info", `activated ${this.clientId} name=${this.name} roles=${this.roles.join(",")}`);
    this.sendJson("server/activate", { activities: ["playback"], active_roles: this.roles });
    this.server.onConnectionActivated(this);
  }

  private respondServerTime(payload: any): void {
    this.sendJson("server/time", {
      client_transmitted: payload?.client_transmitted ?? 0,
      server_received: nowUs(),
      server_transmitted: nowUs(),
    });
  }

  // ---- 出站 ----

  private sendCleartext(type: string, payload?: Record<string, any>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (typeof type === "string" && type.includes("server/init")) {
      this.ws.send(type);
      return;
    }
    this.ws.send(JSON.stringify({ type, payload: payload ?? {} }));
  }

  sendJson(type: string, payload?: Record<string, any>): void {
    this._sendPlain(packJsonBody({ type, payload: payload ?? {} } as JsonMessage));
  }
  sendBinary(body: Uint8Array): void {
    this._sendPlain(body);
  }
  sendAudio(tsUs: bigint, codecData: Uint8Array): void {
    this._sendPlain(packAudioChunk(tsUs, codecData));
  }
  private _sendPlain(body: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (body.length <= MAX_TRANSPORT_PLAINTEXT) {
      this._enc(body);
      return;
    }
    const firstCap = MAX_TRANSPORT_PLAINTEXT - 2;
    this._enc(cat([BIN_FRAGMENT_MORE, body[0]], body.subarray(1, 1 + firstCap)));
    let off = firstCap;
    while (off < body.length - 1) {
      const n = Math.min(MAX_TRANSPORT_PLAINTEXT - 1, body.length - 1 - off);
      const end = off + n >= body.length - 1;
      this._enc(cat([end ? BIN_FRAGMENT_END : BIN_FRAGMENT_MORE], body.subarray(1 + off, 1 + off + n)));
      off += n;
    }
  }
  private _enc(body: Uint8Array): void {
    let ct: Uint8Array;
    try {
      ct = this.noise!.encrypt(body);
    } catch {
      return;
    }
    this.ws.send(Buffer.from(ct));
  }

  appliedGain(): number {
    if (!this.group) return this.muted ? 0 : this.volume;
    return this.group.appliedGain(this);
  }

  private fail(reason: string): void {
    this.server.log("error", `${this.clientId ?? "(anon)"} ${reason}`);
    try {
      this.ws.terminate();
    } catch {
      /* ignore */
    }
  }

  close(): void {
    try {
      this.ws.terminate();
    } catch {
      /* ignore */
    }
  }
}

function cat(a: number[], data: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(a), Buffer.from(data)]));
}