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
import { randomBytes } from "node:crypto";
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
  SENTINEL_PSK_HEX,
} from "./constants.js";
import { nowUs } from "./clock.js";
import { MessageRouter } from "./messages.js";
import "./roles/index.js";
import { negotiateRoles } from "./roles/registry.js";
import { createChunkEncoder, type ChunkEncoder, OPUS_FRAME_MS, type SendspinCodec } from "./encoding.js";
import { stopGroupPump } from "./streamEngine.js";
import { computeCommonSendAhead } from "./group.js";
import { b64urlDecode, b64urlEncode } from "./util.js";
import type { PairingStore } from "./pairingStore.js";
import type { PairingCoordinator } from "./pairServer.js";

export interface SendspinServerOptions {
  pairkeys: Identity;
  identityDir?: string;
  pairingPskHex?: string;
  serverName?: string;
  log?: SendspinLog;
  /** 允许 legacy 明文客户端(无 Noise 加密,前加密时代协议,如 ESPHome/sendspin-cpp
   *  与 aiosendspin<7)。缺省 true(与 Music Assistant 的 allow_legacy_clients 一致)。
   *  关闭后明文 client/hello 直接 fail,仅合规加密客户端可连。 */
  allowLegacyClients?: boolean;
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
  /** 运行时可热更新(插件配置页开关,见 PUT /v1/plugins/:id)。 */
  allowLegacyClients: boolean;
  /** 配对记录(长配对 PSK / 未配对批准)。无则握手恒走 sentinel(配对功能关闭)。 */
  pairingStore: PairingStore | null = null;
  /** 配对编排(由 index.ts 在 store 就绪后注入;无则 pair/* 直接忽略)。 */
  pairing: PairingCoordinator | null = null;
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
    this.allowLegacyClients = opts.allowLegacyClients !== false;
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

  /** 服务端主动拨号(见 spec server-initiated):拨玩家 :8928/sendspin。
   *  WS 方向反转而已,后续 client/init→Noise→hello/activate 与拨入完全一致
   *  (Noise initiator 恒为服务端)。成功返回激活后的连接(已注册 peer)。 */
  async dialPlayer(url: string, timeoutMs = 15000): Promise<SendspinConnection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
        reject(new Error("dial timeout"));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error("dial failed"));
      });
    });
    const before = new Set(this.clients.keys());
    const conn = new SendspinConnection(this, ws);
    // 记住拨号来源:掉线重拨与忘记目标时定位用。
    try {
      const u = new URL(url);
      conn.dialed = true;
      conn.dialHost = u.hostname;
      conn.dialPort = u.port ? parseInt(u.port, 10) : 80;
    } catch { /* URL 非法已在上游校验 */ }
    this.log("info", `dialed ${url},等激活`);
    const t0 = Date.now();
    for (;;) {
      for (const [id, c] of this.clients) {
        if (!before.has(id) && c === conn) return c;
      }
      // 连接已死直接报错,不傻等超时。
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        throw new Error("连接在激活前断开(对方可能拒绝了握手)");
      }
      if (Date.now() - t0 > timeoutMs) {
        try { ws.terminate(); } catch { /* ignore */ }
        throw new Error("activation timeout");
      }
      await new Promise((r) => setTimeout(r, 200));
    }
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
      if (g.empty) {
        // 组空即停 pump(放掉整首 PCM)+ 关编码器(杀 ffmpeg),队列不动(重连恢复)。
        // 不做:无听众还继续解完整队歌,是标准的内存/CPU 双泄漏。
        stopGroupPump(g);
        const n = g.close();
        this.groups.delete(g.name);
        if (n > 0) this.log("info", `group ${g.name} 空了,关 ${n} 个编码器`);
      }
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

  /** 当前曲媒体信息(供 /status media 与 /queue currentMedia)。
   *  前端与 HA 靠 media.songId 变化触发歌词/封面刷新;缺了切歌后还挂着第一首。 */
  currentMedia(clientId: string): { songId: string; title?: string; artist?: string; album?: string; coverArt?: string } | undefined {
    const cur = this.groups.get(clientId)?.current;
    if (!cur) return undefined;
    return { songId: cur.songId, title: cur.title, artist: cur.artist, album: cur.album, coverArt: cur.coverArt };
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
  current: { songId: string; title?: string; artist?: string; album?: string; coverArt?: string; durationMs: number } | null = null;
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
  /** 关闭全部编码器(含 flac 的 ffmpeg 持续进程),返回关掉的数量(供回收上报)。 */
  close(): number {
    let n = 0;
    for (const e of this.encoders.values()) {
      try { e.close(); } catch { /* ignore */ }
      n++;
    }
    this.encoders.clear();
    return n;
  }
}

/** 按客户端 player_support 协商编码(尊重客户端优先级顺序)。
 *  只协商 codec(管线恒定 48kHz 立体声,见 encoding.ts);都不支持则回退 opus。
 *  不协商的后果:9.x 等客户端直接拒收 opus(only PCM and FLAC are supported)。
 *  键名兼容:9.x 线上为 player@v1_support(别名),老版本为 player_support。 */
export function negotiateCodec(payload: any): SendspinCodec {
  // 9.x 线上键名为 player@v1_support(别名),老版本为 player_support,都认。
  const list = payload?.["player@v1_support"]?.supported_formats ?? payload?.player_support?.supported_formats;
  if (!Array.isArray(list)) return "opus";
  for (const f of list) {
    const codec = String(f?.codec || "").toLowerCase();
    if (codec === "opus" || codec === "flac" || codec === "pcm") return codec;
  }
  return "opus";
}

export class SendspinConnection {
  id: string;
  clientId: string | null = null;
  name = "";
  server: SendspinServer;
  private ws: WebSocket;
  noise: NoiseSession | null = null;
  handshakeDone = false;
  /** 本次握手混入的 PSK 类别(sn/lt/pr),决定会话权限与配对走向。 */
  handshakePskCategory: "sn" | "lt" | "pr" = "sn";
  /** legacy 明文客户端(无 Noise):client/hello 直连,全程 TEXT/RAW BINARY,无加密。
   *  配对不可用(与 MA 的 legacy transition-mode 一致),peer 标记 unencrypted。 */
  legacy = false;
  /** 本连接是否由服务端主动拨出;是则 dialHost/dialPort 记录目标(掉线重拨用)。 */
  dialed = false;
  dialHost = "";
  dialPort = 0;
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
  private hsRemotePub: Uint8Array | null = null;
  /** pairing server/activate 计数(上次 Noise 握手以来),进 PAKE sid。 */
  private pairingActivations = 0;
  private rehandshaking: {
    session: NoiseSession;
    category: "sn" | "lt" | "pr";
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
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

  /** 协商套件名(当前恒定默认套件,供配对 wrapping 选 AEAD)。 */
  suiteName(): string {
    return DEFAULT_SUITE;
  }

  /** 取下一次 pairing activate 的 pairing_index(PAKE sid 用,每次自增)。 */
  nextPairingIndex(): number {
    this.pairingActivations += 1;
    return this.pairingActivations;
  }

  /** 带内 re-handshake(见 spec connection.md):不断 WS,直接换会话密钥。
   *  用途:配对后提到长配对 PSK / 切到配对 PSK / 长连接轮换。完成后重走
   *  hello/activate(对端按新会话重新激活)。 */
  rehandshakeTo(pskHex: string, category: "sn" | "lt" | "pr"): Promise<void> {
    if (this.legacy || !this.noise || !this.hsRemotePub) {
      return Promise.reject(new Error("re-handshake 仅加密连接可用"));
    }
    if (this.rehandshaking) return Promise.reject(new Error("re-handshake 已在进行"));
    const h = this.noise.handshakeHash;
    if (!h || h.length !== 32) return Promise.reject(new Error("no handshake hash"));
    const session = asInitiator({
      suite: DEFAULT_SUITE,
      localStaticPriv: this.server.identity.privateKey,
      remoteStaticPub: this.hsRemotePub,
      prologue: new Uint8Array(h),
      psk: Buffer.from(pskHex, "hex"),
    });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rehandshaking = null;
        reject(new Error("re-handshake timeout"));
      }, 30_000);
      this.rehandshaking = { session, category, resolve, reject, timer };
      // msg1 走旧密钥加密通道;之后禁应用消息,直到新 activate。
      const msg1 = session.writeMessage(handshakePayload1(pskHex, category));
      this.sendJson("noise/handshake", { data: b64urlEncode(msg1) });
    });
  }

  /** transport 期收到的 noise/handshake(= re-handshake 的 msg2)。 */
  private onRehandshakeMsg2(dataB64: string): void {
    const rh = this.rehandshaking;
    if (!rh) return;
    let msg2: Uint8Array;
    try {
      msg2 = typeof dataB64 === "string" ? b64urlDecode(dataB64) : new Uint8Array();
    } catch {
      this.failRehandshake(new Error("malformed re-handshake msg2"));
      return;
    }
    try {
      rh.session.readMessage(msg2);
    } catch {
      this.failRehandshake(new Error("re-handshake msg2 auth failed"));
      return;
    }
    clearTimeout(rh.timer);
    this.rehandshaking = null;
    this.noise = rh.session;
    this.handshakePskCategory = rh.category;
    this.pairingActivations = 0; // 新握手,配对计数清零
    if (rh.category === "lt" && this.clientId) void this.server.pairingStore?.touchRecord(this.clientId);
    rh.resolve();
    // 新密钥就位:重走 hello/activate(对端按新会话激活,peer 注册幂等刷新)。
    this.sendJson("server/hello", { name: this.server.serverName });
  }

  private failRehandshake(e: Error): void {
    const rh = this.rehandshaking;
    this.rehandshaking = null;
    if (rh) {
      clearTimeout(rh.timer);
      rh.reject(e);
    }
  }

  /** 明文期(TEXT)与加密期(BINARY)的统一入口。 */
  async onFrame(data: Buffer, isBinary: boolean): Promise<void> {
    if (!this.handshakeDone) {
      this.handleCleartext(data, isBinary);
      return;
    }
    if (this.legacy) {
      this.handleLegacyFrame(data, isBinary);
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
  // legacy 明文客户端(前加密时代,如 ESPHome/sendspin-cpp、aiosendspin<7):
  // 首帧直接发 client/hello → 若 allowLegacyClients 则走 legacy 直通(无 Noise)。

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
    } else if (t === "client/hello" && this.phase === "init") {
      // 前加密时代客户端:无 client/init,直接明文 hello 等 server/hello。
      if (!this.server.allowLegacyClients) return this.fail("legacy clients disabled");
      this.beginLegacy(msg.payload);
    } else {
      this.fail(`unexpected cleartext frame: ${t}`);
    }
  }

  /** legacy 明文直通:无 Noise,会话全程明文。配对不可用;peer 标记 unencrypted。
   *  对照 MA 的 allow_legacy_clients transition-mode(默认开,纯过渡兼容)。 */
  private beginLegacy(payload: any): void {
    const rawId = typeof payload?.client_id === "string" ? payload.client_id.trim() : "";
    // sendspin-cpp 默认用网卡 MAC 作 client_id(重启稳定);无则合成一个。
    const clientId = rawId.length >= 4 ? rawId.slice(0, 128) : `legacy-${randomBytes(8).toString("hex")}`;
    const supported = Array.isArray(payload?.supported_roles) ? payload.supported_roles : [];
    this.clientId = clientId;
    this.id = clientId;
    this.name = typeof payload?.name === "string" && payload.name ? String(payload.name).slice(0, 128) : clientId;
    this.roles = negotiateRoles(supported);
    this.clientHello = payload ?? {};
    this.codec = negotiateCodec(payload);
    this.legacy = true;
    this.handshakeDone = true;
    this.phase = "ready";
    this.server.log("warn", `legacy unencrypted client: ${clientId} name=${this.name} (明文直通,配对不可用)`);
    // legacy 客户端只认 TEXT 帧:明文 server/hello(字段需齐,sendspin-cpp 严格校验)。
    this.sendCleartext("server/hello", {
      server_id: this.server.serverId,
      name: this.server.serverName,
      version: PROTOCOL_VERSION,
      active_roles: this.roles,
      connection_reason: "legacy_transition",
    });
    this.server.onConnectionActivated(this);
  }

  /** legacy 会话的明文 JSON 入站:与加密期 _dispatch 同语义(client/time 计时,
   *  其余走 MessageRouter;音频等上行二进制 legacy 客户端不发,直接忽略)。 */
  private handleLegacyFrame(data: Buffer, isBinary: boolean): void {
    if (isBinary) return; // legacy 客户端无上行二进制
    let msg: any;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    const t = msg?.type;
    if (t === "client/hello") return; // 重复 hello 直接忽略(不断连)
    if (t === "client/time") {
      this.respondServerTime(msg?.payload ?? {});
      return;
    }
    if (t === "client/goodbye") {
      try { this.ws.close(); } catch { /* ignore */ }
      return;
    }
    void this.server.router.handle(t, { ...(msg?.payload ?? {}), _conn: this });
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
    this.hsRemotePub = new Uint8Array(clientPub);
    // 有配对记录 → 长配对 PSK(lt) 建会话;无 → pairing PSK(默认 sentinel,sn)。
    // 记录按 client/init 的 client_id 查找(客户端此时已自报身份)。
    const rec = this.server.pairingStore?.getRecord(clientId);
    const pskHex = rec?.pskHex ?? Buffer.from(this.server.pairingPsk).toString("hex");
    const category = rec ? "lt" : "sn";
    this.handshakePskCategory = category;
    const prologue = new Uint8Array(
      Buffer.concat([Buffer.from(clientInitText, "utf8"), Buffer.from(serverInitText, "utf8")]),
    );
    this.noise = asInitiator({
      suite: DEFAULT_SUITE,
      localStaticPriv: this.server.identity.privateKey,
      remoteStaticPub: clientPub,
      prologue,
      psk: Buffer.from(pskHex, "hex"),
    });
    this.phase = "handshake";

    // server/init 紧跟 msg1(中间不等客户端,见参考 run_handshake_server)。
    this.sendCleartext(serverInitText);
    const msg1Pt = handshakePayload1(pskHex, category);
    const msg1Ct = this.noise!.writeMessage(msg1Pt);
    this.sendCleartext("noise/handshake", { data: b64urlEncode(msg1Ct) });
  }

  /** Sentinel Fallback 后的凭证失配标记:有配对记录但客户端用 sentinel 进来。
   *  按 spec 保持空 activities(不注册 peer、不给播放),等重新配对。 */
  sentinelMismatch = false;

  /** Sentinel Fallback 验证:成功返回 true(会话已切换为 sentinel,标记失配)。 */
  private trySentinelFallback(msg2Ct: Uint8Array): boolean {
    try {
      const eph = this.noise?.ephemeralPriv;
      if (!eph || !this.hsRemotePub || !this.clientInitText || !this.serverInitText) return false;
      const prologue = new Uint8Array(
        Buffer.concat([Buffer.from(this.clientInitText, "utf8"), Buffer.from(this.serverInitText, "utf8")]),
      );
      const fb = asInitiator({
        suite: DEFAULT_SUITE,
        localStaticPriv: this.server.identity.privateKey,
        remoteStaticPub: this.hsRemotePub,
        prologue,
        psk: Buffer.from(SENTINEL_PSK_HEX, "hex"),
        ephemeralPriv: eph,
      });
      // 推进到 step1(字节丢弃,只为内部状态与原会话对齐)再验 msg2。
      fb.writeMessage(handshakePayload1(SENTINEL_PSK_HEX, "sn"));
      fb.readMessage(msg2Ct);
      this.noise = fb;
      this.handshakePskCategory = "sn";
      this.sentinelMismatch = true;
      this.handshakeDone = true;
      this.phase = "ready";
      this.server.log("warn", `sentinel fallback: ${this.clientId} 丢了配对记录,保持未配对(需重新配对才给播放)`);
      this.sendJson("server/hello", { name: this.server.serverName });
      return true;
    } catch {
      return false;
    }
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
      // Sentinel Fallback(见 spec connection.md):服务端引用了长配对 PSK,但
      // 客户端已丢失记录 → 它会用 sentinel 发 msg2。用 sentinel 把同一 msg2
      // 再验一次(复用原 ephemeral,EE 才能对上);成功即"凭证失配"信号成立。
      if (this.handshakePskCategory === "lt" && this.trySentinelFallback(msg2Ct)) return;
      return this.fail("noise message 2 failed authentication");
    }
    this.handshakeDone = true;
    this.phase = "ready";
    this.pairingActivations = 0; // 新握手,配对计数清零
    this.server.log("info", `handshake ok: ${this.clientId}`);
    // 长配对 PSK 会话:刷新记录活跃时间。
    if (this.handshakePskCategory === "lt" && this.clientId) {
      void this.server.pairingStore?.touchRecord(this.clientId);
    }
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
      // re-handshake 期间只收握手与 hello/activate(见 spec),应用消息暂禁。
      if (this.rehandshaking) {
        if (m.type === "noise/handshake") {
          this.onRehandshakeMsg2(m.payload?.data);
          return;
        }
        if (m.type === "client/hello") {
          this.onClientHello(m.payload);
          return;
        }
        return;
      }
      if (m.type === "noise/handshake") return; // 非 re-handshake 期忽略
      if (m.type === "client/hello") {
        this.onClientHello(m.payload);
        return;
      }
      if (m.type === "client/time") {
        this.respondServerTime(m.payload);
        return;
      }
      if (m.type === "pair/abort" || m.type.startsWith("client/pair")) {
        void this.server.pairing?.onPairMessage(this, m.type, m.payload ?? {});
        return;
      }
      void this.server.router.handle(m.type, { ...m.payload, _conn: this });
    }
    // 其它二进制(音频/artwork 等)当前无上行。
  }

  private onClientHello(payload: any): void {
    this.clientHello = payload ?? {};
    const hello: Record<string, any> = this.clientHello ?? {};
    // 凭证失配(Sentinel Fallback 成功但有配对记录):按 spec 保持空 activities,
    // 不注册 peer、不给播放,等重新配对。
    if (this.sentinelMismatch) {
      this.roles = [];
      this.name = typeof hello.name === "string" ? hello.name : (this.clientId ?? "");
      this.server.log("warn", `credential mismatch held: ${this.clientId} (空激活,等重新配对)`);
      this.sendJson("server/activate", { activities: [], active_roles: [] });
      return;
    }
    const supported = Array.isArray(hello.supported_roles) ? hello.supported_roles : [];
    this.roles = negotiateRoles(supported);
    this.name = typeof hello.name === "string" ? hello.name : (this.clientId ?? "");
    this.codec = negotiateCodec(payload);
    this.server.log("info", `activated ${this.clientId} name=${this.name} roles=${this.roles.join(",")} codec=${this.codec}`);
    this.sendJson("server/activate", { activities: ["playback"], active_roles: this.roles });
    this.server.onConnectionActivated(this);
  }

  private respondServerTime(payload: any): void {
    // nowUs() 是 bigint(JSON 序列化直接炸,之前收到 client/time 必崩,见 pairE2E):
    // 线上改为 Number(微秒,53 位内安全约 285 年)。
    this.sendJson("server/time", {
      client_transmitted: payload?.client_transmitted ?? 0,
      server_received: Number(nowUs()),
      server_transmitted: Number(nowUs()),
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
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // legacy 客户端只认 TEXT 明文 JSON(无 Noise):加密帧它们解析不了。
    if (this.legacy) {
      this.ws.send(JSON.stringify({ type, payload: payload ?? {} }));
      return;
    }
    this._sendPlain(packJsonBody({ type, payload: payload ?? {} } as JsonMessage));
  }
  sendBinary(body: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // legacy:单帧 RAW BINARY 直发(不分片;opus 20ms 包本来就小)。
    if (this.legacy) {
      this.ws.send(Buffer.from(body), { binary: true });
      return;
    }
    this._sendPlain(body);
  }
  sendAudio(tsUs: bigint, codecData: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.legacy) {
      this.ws.send(Buffer.from(packAudioChunk(tsUs, codecData)), { binary: true });
      return;
    }
    this._sendPlain(packAudioChunk(tsUs, codecData));
  }

  /** 新曲起播宣告流格式。真实播放器(9.x / sendspin-cpp / legacy)在收到
   *  stream/start 前会丢弃音频(无 format 不播)。codec 取连接协商结果,
   *  管线恒定 48kHz 立体声 16bit。 */
  announceStream(): void {
    const player = { codec: this.codec, sample_rate: 48000, channels: 2, bit_depth: 16 };
    this.sendJson("stream/start", { player });
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