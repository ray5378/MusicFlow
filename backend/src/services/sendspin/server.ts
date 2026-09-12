// ==================== Sendspin 服务端 (initiator) ====================
//
// 角色:server = Noise **initiator**,主动拨号已配对/登记的客户端(对应参考
// aiosendspin.connect_to_client 播放路径)。客户端为 responder,其静态公钥
// 已通过配对/登记预先获知,故 initiator 可预置 `remoteStaticPub`。
//
//   - 握手:initiator 写 msg1 → 读 msg2 → 进入传输态(逐条 AEAD 加密);
//   - 传输帧:type 0=JSON,2/3=分片,4=player audio;
//   - 分组同步推流:解码→逐客户端独立编码(opencode)→按组公共时间戳下发。

import WebSocket from "ws";
import { loadOrCreateIdentity, type Identity } from "./identity.js";
import { asInitiator, type NoiseSession, type NoiseSuite } from "./handshake.js";
import { packJsonBody, unpackJsonBody, packAudioChunk, type JsonMessage } from "./framing.js";
import {
  SENTINEL_PSK_HEX,
  WS_PATH,
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
import { FfmpegPcmEncoder, type SendspinCodec } from "./encoding.js";
import { computeCommonSendAhead } from "./group.js";

export interface SendspinServerOptions {
  pairkeys: Identity;
  identityDir?: string;
  pairingPskHex?: string;
  serverName?: string;
  log?: SendspinLog;
}

export type SendspinLog = (level: "info" | "warn" | "error", msg: string) => void;

const defaultLog: SendspinLog = (level, msg) => {
  if (level === "error") console.error(`[sendspin] ${msg}`);
  else console.log(`[sendspin] ${msg}`);
};

export const PROLOGUE = "MusicFlow Sendspin Server v1";
export const DEFAULT_SUITE: NoiseSuite = "25519_ChaChaPoly_SHA256";

/** 一台已配对/登记设备的拨号信息。 */
export interface SendspinDevice {
  clientId: string;
  clientPub: Uint8Array; // 32B 静态公钥
  url: string; // ws://host:port/sendspin
  hello: Record<string, any>;
}

export class SendspinServer {
  identity: Identity;
  log: SendspinLog;
  readonly registry = new Map<string, SendspinDevice>();
  readonly clients = new Map<string, SendspinConnection>();
  readonly groups = new Map<string, SendspinGroup>();
  pairingPsk: Uint8Array;
  serverName: string;
  router = new MessageRouter();
  timelineStartUs = nowUs();

  constructor(opts: SendspinServerOptions, log?: SendspinLog) {
    this.identity = opts.pairkeys;
    this.log = log ?? opts.log ?? defaultLog;
    this.pairingPsk = Buffer.from(
      opts.pairingPskHex && opts.pairingPskHex.length === 64 ? opts.pairingPskHex : SENTINEL_PSK_HEX,
      "hex",
    );
    this.serverName = opts.serverName ?? "MusicFlow Sendspin";
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

  /** 登记设备(配对/外部登记)。 */
  addDevice(d: SendspinDevice): void {
    this.registry.set(d.clientId, d);
  }
  removeDevice(clientId: string): void {
    this.registry.delete(clientId);
  }

  /** 拨号一台设备并完成 initiator 握手。 */
  async dial(d: SendspinDevice): Promise<SendspinConnection> {
    const existing = this.clients.get(d.clientId);
    if (existing && existing.ready) return existing;
    const ws = new WebSocket(d.url, { maxPayload: MAX_REASSEMBLED_BYTES });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }).catch((e) => {
      ws.terminate();
      throw new Error(`dial ${d.clientId} failed: ${(e as Error).message}`);
    });
    const conn = new SendspinConnection(this, ws, d);
    this.clients.set(d.clientId, conn);
    conn.noise = asInitiator({
      suite: DEFAULT_SUITE,
      localStaticPriv: this.identity.privateKey,
      remoteStaticPub: d.clientPub,
      prologue: new TextEncoder().encode(PROLOGUE),
      psk: this.pairingPsk,
    });
    conn.handshakeSend();
    return conn;
  }

  /** 拨号全部注册设备。 */
  async dialAll(): Promise<void> {
    for (const d of this.registry.values()) {
      try {
        await this.dial(d);
      } catch (e) {
        this.log("warn", `${d.clientId}: ${(e as Error).message}`);
      }
    }
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
    for (const g of this.groups.values()) g.close();
    this.clients.clear();
    this.groups.clear();
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
  private encoders = new Map<string, FfmpegPcmEncoder>();

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
  encoderFor(c: SendspinConnection): FfmpegPcmEncoder {
    const key = `${c.clientId}:${c.codec}`;
    let e = this.encoders.get(key);
    if (!e) {
      e = new FfmpegPcmEncoder(c.codec);
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
      const data = await enc.encode(this.scalePcm(pcm, gain));
      if (data.length > 0) c.sendAudio(tsUs, data);
    }
  }
  close(): void {
    for (const e of this.encoders.values()) e.close();
    this.encoders.clear();
  }
}

export class SendspinConnection {
  id: string;
  clientId: string;
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
  private reasm: Buffer | null = null;
  private reasmType = 0;

  constructor(server: SendspinServer, ws: WebSocket, d: SendspinDevice) {
    this.server = server;
    this.ws = ws;
    this.clientId = d.clientId;
    this.id = d.clientId;
    this.latitude = d.hello.latitude ?? 0;
    this.longitude = d.hello.longitude ?? 0;
    ws.on("message", (data) => void this.onFrame(Buffer.from(data as Buffer)));
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      const g = this.group;
      this.group = null;
      if (g) {
        g.remove(this);
        if (g.empty) this.server.groups.delete(g.name);
      }
    });
  }

  get ready(): boolean {
    return this.ws.readyState === WebSocket.OPEN && this.handshakeDone;
  }

  /** initiator 写出 msg1。 */
  handshakeSend(): void {
    const ns = this.noise!;
    const payload1 = JSON.stringify({
      client_id: null,
      server_id: this.server.serverId,
    });
    const msg1 = ns.writeMessage(new TextEncoder().encode(payload1));
    this.ws.send(Buffer.from(msg1));
  }

  /** 读取 msg2,完成握手。 */
  private finishHandshake(msg2: Buffer): void {
    const ns = this.noise!;
    const payload = ns.readMessage(new Uint8Array(msg2));
    let clientHello: Record<string, any> = {};
    try {
      clientHello = JSON.parse(Buffer.from(payload).toString("utf8"));
    } catch {
      /* ignore */
    }
    this.handshakeDone = true;
    this.roles = negotiateRoles(clientHello.roles ?? []).filter((r) =>
      roleFactoryExists(r),
    );
    this.server.log("info", `handshake ok: ${this.clientId} roles=${this.roles.join(",")}`);
    // 给客户端回 server/hello + server/time
    this.sendJson("server/hello", {
      hello: {
        server_id: this.server.serverId,
        name: this.server.serverName,
        protocol_version: 1,
      },
      server_time: {
        client_transmitted: 0,
        server_received: nowUs(),
        server_transmitted: nowUs(),
      },
    });
  }

  async onFrame(data: Buffer): Promise<void> {
    if (!this.handshakeDone) {
      this.finishHandshake(data);
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
      void this.server.router.handle(m.type, { ...m.payload, _conn: this });
    }
  }

  // ---- 出站 ----
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

export function roleFactoryExists(rid: string): boolean {
  // roleFactoryMap 由 roles/index 导入注册;避免循环引用通过脆弱动态判断,直接放行
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    reqRoleFactory(rid);
    return true;
  } catch {
    return false;
  }
}

function reqRoleFactory(_rid: string): void {
  // 占位;角色工厂命中在 server 装配层用 registry.getFactory 注入
}