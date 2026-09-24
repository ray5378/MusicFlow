// ==================== Sendspin 服务端 (WebSocket 监听 + Noise initiator) ====================
//
// 服务器是 Sendspin 协议里的 **监听方 + Noise initiator**:
//   - 用 `ws` 的 `WebSocketServer` 监听 `:38927/sendspin`,接受客户端拨入;
//   - 明文 TEXT 期:收 `client/init` → 回 `server/init`（prologue = 二者原文拼接）;
//   - 服务端做 initiator:写 msg1（负载 `{psk_id, psk_category}`）→ 读 msg2（明文 `{}`）;
//   - 之后进入加密 transport 期(JSON 帧 = [0x00]+json;二进制帧由调用方带类型字节);
//   - post-handshake:server/hello → client/hello → server/activate → 业务数据。
//
// 分组同步推流保留:解码 → **按 (codec, gain) 分组编码(同组只编一次)** →
// 按组公共时间戳下发(group.pushFrame)。

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
  PREFILL_BUFFER_MIN_MS,
  PREFILL_BUFFER_MAX_MS,
  LATE_JOIN_MARGIN_US,
  LATE_JOIN_KEEP_PAST_US,
  LATE_JOIN_RING_MAX_US,
} from "./constants.js";
import { nowUs } from "./clock.js";
import { MessageRouter } from "./messages.js";
import "./roles/index.js";
import { negotiateRoles } from "./roles/registry.js";
import { createChunkEncoder, flacCodecHeaderB64, FLAC_BIT_DEPTH, type ChunkEncoder, type EncodedChunk, OPUS_FRAME_MS, SAMPLE_RATE, type SendspinCodec, waitFlacEncoderReady } from "./encoding.js";
import { stopGroupPump } from "./streamEngine.js";
import { computeCommonSendAhead, type SendAheadInput } from "./group.js";
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
  /** 推流**默认编码偏好**(插件配置页 `preferred_codec`):`pcm` 或 `flac`。
   *  缺省 `pcm`(见 negotiateCodec 注释里 2026-09-17 ESP32 真机实测)。这只决定
   *  **优先顺序**,不是强制:设备不支持所选时仍自动退到另一种。 */
  preferredCodec?: SendspinCodecPreference;
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

/** 归一化 socket 对端地址:Node 在双栈监听下会把 IPv4 报成 IPv4-mapped IPv6
 *  (`::ffff:192.168.10.245`),直接拿去当 6053 目标会被当主机名解析。 */
export function normalizeRemoteHost(host?: string | null): string {
  if (!host) return "";
  const h = host.trim();
  // ::ffff:a.b.c.d → a.b.c.d
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(h);
  if (m) return m[1]!;
  if (h === "::1") return "127.0.0.1";
  return h;
}

export class SendspinServer {
  identity: Identity;
  log: SendspinLog;
  readonly clients = new Map<string, SendspinConnection>();
  readonly groups = new Map<string, SendspinGroup>();
  /** 不再自动重拨的目标 host:port → goodbye reason(手动 dial 清除,见 goodbye 分支)。 */
  readonly noAutoRedial = new Map<string, string>();
  /** 手动拨号清除指定目标的重拨抑制(运营商明确意图,供路由层调用)。 */
  clearNoRedial(host: string, port: number): void {
    this.noAutoRedial.delete(`${host}:${port}`);
  }
  /** 进行中的拨号 url → 任务(同目标单飞,见 dialPlayer)。 */
  private readonly pendingDials = new Map<string, Promise<SendspinConnection>>();
  pairingPsk: Uint8Array;
  serverName: string;
  /** 运行时可热更新(插件配置页开关,见 PUT /v1/plugins/:id)。 */
  allowLegacyClients: boolean;
  /** 运行时可热更新(插件配置页切换,见 PUT /v1/plugins/:id)。
   *  只影响**之后**建立的新连接/新起播流的 codec 协商,不断当前流。 */
  preferredCodec: SendspinCodecPreference;
  /** 配对记录(长配对 PSK / 未配对批准)。无则握手恒走 sentinel(配对功能关闭)。 */
  pairingStore: PairingStore | null = null;
  /** 配对编排(由 index.ts 在 store 就绪后注入;无则 pair/* 直接忽略)。 */
  pairing: PairingCoordinator | null = null;
  router = new MessageRouter();
  port: number;
  wss: WebSocketServer | null = null;
  /** `listen()` 进行中/已完成的 Promise —— 用于并发互斥(见 listen 注释)。 */
  private listening: Promise<void> | null = null;
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
    this.preferredCodec = normalizeCodecPreference(opts.preferredCodec);
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
    // ⚠️ 并发幂等:`await waitFlacEncoderReady()` 之前就占位,否则两个并发 listen()
    //    都能通过上面的检查 → 双双 bind 同一端口 → 第二个 `EADDRINUSE`。
    //    (引入预热 await 之前不存在这个让路窗口,是 2026-09-17 的新坑。)
    if (this.listening) return this.listening;
    this.listening = this.doListen(port);
    try {
      await this.listening;
    } catch (e) {
      this.listening = null; // 失败后允许重试
      throw e;
    }
  }

  private async doListen(port: number): Promise<void> {
    // 预热进程内 FLAC 编码器(libFLAC 是异步初始化,asm.js 需过一轮 tick)。
    // ⚠️ 必须在收客户端之前完成:否则首个 `encoderFor()` 会抛「尚未就绪」并中断出流。
    const ready = await waitFlacEncoderReady();
    if (!ready) {
      this.log("warn", "libFLAC 预热超时 —— flac 编码将不可用(opus/pcm 不受影响)");
    }
    this.port = port;
    const wss = new WebSocketServer({ port, path: WS_PATH, maxPayload: MAX_REASSEMBLED_BYTES });
    // 第二个参数 req 是升级前的 HTTP 请求 —— 唯一能拿到**对端 IP** 的地方。
    // 服务端主动拨号(dialPlayer)有自己的 dialHost,这里只补「客户端拨入」这一侧。
    // IP 供 ESPHome 6053 只读桥接自动派生目标(无需用户手工填 host)。
    wss.on("connection", (ws, req) => this.onClientConnect(ws, req.socket?.remoteAddress));
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", (e) => reject(e));
    });
    this.wss = wss;
    this.log("info", `sendspin listening ws://0.0.0.0:${port}${WS_PATH} (server_id=${this.serverId})`);
  }

  private onClientConnect(ws: WebSocket, remoteHost?: string): void {
    const conn = new SendspinConnection(this, ws, normalizeRemoteHost(remoteHost));
    this.log("info", `new connection from ${conn.remoteHost || ws.url || "(client)"}`);
  }

  /** 引用计数(仅用于断言):当前已为其建立 6053 只读桥接的对端 host。
   *  由 services/sendspin/esphomeBridge.ts 维护,这里是反向查询入口。 */
  peersByHost(): Map<string, SendspinConnection[]> {
    const m = new Map<string, SendspinConnection[]>();
    for (const conn of this.clients.values()) {
      if (!conn.remoteHost) continue;
      const list = m.get(conn.remoteHost) ?? [];
      list.push(conn);
      m.set(conn.remoteHost, list);
    }
    return m;
  }

  /** 服务端主动拨号(见 spec server-initiated):拨玩家 :8928/sendspin。
   *  WS 方向反转而已,后续 client/init→Noise→hello/activate 与拨入完全一致
   *  (Noise initiator 恒为服务端)。成功返回激活后的连接(已注册 peer)。
   *  同一目标单飞:并发重拨会形成双连接,设备仲裁踢掉一个(2026-09-17 真机
   *  another_server 风暴)。进行中的同目标拨号直接复用,不另开 socket。 */
  async dialPlayer(url: string, timeoutMs = 15000): Promise<SendspinConnection> {
    const singleKey = `dial:${url}`;
    const pending = this.pendingDials.get(singleKey);
    if (pending) {
      this.log("info", `dial ${url} 已在进行中,复用(避免双连接仲裁)`);
      return pending;
    }
    const task = this.dialPlayerInner(url, timeoutMs).finally(() => {
      if (this.pendingDials.get(singleKey) === task) this.pendingDials.delete(singleKey);
    });
    this.pendingDials.set(singleKey, task);
    return task;
  }

  private async dialPlayerInner(url: string, timeoutMs = 15000): Promise<SendspinConnection> {
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
      // 主动拨出同样记录对端 IP,与「客户端拨入」路径保持一致。
      conn.remoteHost = normalizeRemoteHost(u.hostname);
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
    const sendAhead = computeCommonSendAhead([...g.members].map((c) => sendAheadInputOf(c)));
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
    this.listening = null; // 允许 stop → listen 重新绑定
  }
}

/** 从 `client/hello` payload 取设备宣告的缓冲容量(字节);取不到返回 0。
 *
 *  真机实发(ESPHome 2026.9.0 / esp32-player-meet):
 *    `"player@v1_support": { supported_formats: [...], buffer_capacity: 1600000,
 *                            supported_commands: ["volume","mute"] }`
 *  单位是 **byte** —— ESPHome 源码实锤:`components/sendspin/__init__.py`
 *  把 `CONF_BUFFER_SIZE`(media_source 里 `cv.int_range(min=25000)`,明显是字节)
 *  直接塞进 `audio_buffer_capacity`;aiosendspin 同名字段作
 *  `BufferTracker(capacity_bytes=...)` 消费。另兼容 `player_support`(非 v1
 *  键名)与顶层 `buffer_capacity`。 */
export function parseHelloBufferCapacity(payload: any): number {
  const support = payload?.["player@v1_support"] ?? payload?.player_support ?? payload;
  const raw = support?.buffer_capacity ?? payload?.buffer_capacity;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/** 设备缓冲容量的**可用比例**——留安全余量,不把设备灌满。
 *
 *  2026-09-24 真机 A/B 实测(ESPHome 2026.9.0 / esp32-player-meet,
 *  `buffer_capacity=1600000B`,FLAC 实测 105052 B/s):
 *    - 档位 10s(= 1.05MB,**66%** 占用)→ 设备侧 `Failed to send audio chunk`
 *      = 0、`Lost sync` = 0,100s 全程干净;
 *    - 档位 30s(按 100% 容量钳到 15.23s)→ 设备在 **PLAYING 后 15.30s**
 *      开始连续 `Failed to send audio chunk`(设备拒收 = 缓冲满),并伴随
 *      `Lost sync (85352us off)` 风暴 —— 15.30s 与 1600000/105052=15.23s 吻合,
 *      即「灌满到 100% 后每一帧都被拒」。
 *
 *  为什么要余量(而不是像 aiosendspin 那样直接用 100%):
 *    aiosendspin 的 `BufferTracker` 累计的是**每个 chunk 的真实压缩字节数**
 *    (字段就叫 `capacity_bytes`),而本仓是**按时长**记账
 *    (`depth = cursor − now`,再乘平均码率换算),两者不等价:
 *    FLAC 瞬时码率随内容起伏,加上每 chunk 的协议头开销与最多一帧(25ms)
 *    的目标水位过冲,按 100% 算必然踩线。取 **0.6** 实测安全
 *    (10s 档那次实测占用 66% 已干净,0.6 再加一档余量)。
 *
 *  想用更深的档位 → 在 ESPHome 里调大 `buffer_size`(容量越大,
 *  同一比例对应的秒数越多),而不是把这个比例调高。 */
export const DEVICE_BUFFER_HEADROOM_RATIO = 0.6;

export class SendspinGroup {
  name: string;
  server: SendspinServer;
  members = new Set<SendspinConnection>();
  volume = 100;
  muted = false;
  positionMs = 0;
  timelineBaseUs = 0n;
  /** 当前播曲(由 ProtocolPlayer.playMedia 写入,供 pollState/自动切歌判定)。 */
  current: { songId: string; title?: string; artist?: string; album?: string; coverArt?: string; mime?: string; durationMs: number } | null = null;
  /** 延迟的 stream/start 目标集(见 protocolPlayer.playMedia 注释:解码可达 10s,
   *  立即宣告会让设备在空等中丢弃该流)。由 pushFrame 在**首个音频帧之前**兑现。
   *  数组(多房间组每个成员各兑现一次);单设备组退化为单元素,与旧单字段语义一致。 */
  pendingAnnounces: SendspinConnection[] = [];
  /** 兑现某个成员的延迟 stream/start —— **只在该成员首块音频已产出时**调用。
   *
   *  ⚠️ 不能「先宣告、再等编码器吐货」(2026-09-24 真机:播放中把 Sendspin 播放器
   *  加入群组,走 FLAC 链路的新成员不出声,PCM 正常)。原因:
   *   FLAC 是块编码器(libFLAC 自选块大小,约 4096 样本 ≈ 85ms),新成员的编码器
   *   要攒满一块才吐首帧;而 PCM 每批即刻产出。于是只有 FLAC 会在
   *   `stream/start` 与首块音频之间留出 ~85ms 空窗 —— 这正是本文件已记录过的
   *   事故形态:「收到 Stream Started 却在等待中丢弃该流 → 不做 codec header
   *   处理、扬声器不启动 = 无声」。
   *   MA 的 `_pending_stream_start` 同样是**首块就绪才发**,故这里改为逐成员兑现。
   *
   *  附带收益:codec_header 此刻必定是该成员编码器的**真实 STREAMINFO**
   *  (`realFlacHeaderB64` 已有值),不再回落到合成头(合成头曾因 block size /
   *  位深与实流不符导致严格解码器逐帧校验失败 → 日志全绿但无声)。 */
  flushAnnounceFor(c: SendspinConnection): void {
    // spec:「server MUST NOT send stream/start unless the latest client/state
    // reports available:true」。设备**明确**报 available:false 时本轮不宣告,
    // 条目留在队列里,下一帧(pushFrame 每帧都会调本函数)自然重试;
    // 未上报过 available 的设备(真机固件即如此)不受影响(见 clientWantsStream)。
    if (!c.clientWantsStream()) return;
    // 去重:多首连续起播可能把同一 conn 压入多次(上一首没产帧就没兑现过),
    // 只删第一个会留下陈旧条目,后续被误兑现成第二份 stream/start。
    let i = this.pendingAnnounces.indexOf(c);
    if (i < 0) return;
    while (i >= 0) {
      this.pendingAnnounces.splice(i, 1);
      i = this.pendingAnnounces.indexOf(c);
    }
    try {
      c.announceStream();
    } catch {
      /* 单成员宣告失败不连累其余 */
    }
  }

  /** 兜底兑现所有仍未发出的延迟宣告:全程一帧都没产出的成员也要拿到 stream/start,
   *  否则客户端会空等一个永不开始的流(与旧行为一致)。 */
  announcePending(): void {
    const list = this.pendingAnnounces.splice(0);
    for (const c of list) {
      try { c.announceStream(); } catch { /* 单成员宣告失败不连累其余 */ }
    }
  }
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
  /** 编码组键:同一份 PCM 经同一 codec、同一增益编出的字节**逐字节相同**,
   *  与是哪个客户端无关 —— 故同键成员共享一个编码器(见 pushFrame)。 */
  private encoderKey(codec: SendspinCodec, gain: number): string {
    return `${codec}:${gain}`;
  }
  /** 取(必要时创建)某个编码组的编码器。 */
  encoderForGroup(codec: SendspinCodec, gain: number): ChunkEncoder {
    const key = this.encoderKey(codec, gain);
    let e = this.encoders.get(key);
    if (!e) {
      e = createChunkEncoder(codec);
      this.encoders.set(key, e);
    }
    return e;
  }
  /** 该连接所属编码组的编码器(播报尾帧 flush 等旧调用点用)。
   *  ⚠️ `appliedGain` 走**可选调用**:单测里的最小桩只给 `{clientId, codec}`
   *  (见 reclaim.test.ts),直接调会抛 —— 与 streamEngine 对最小 stub group 的
   *  可选调用是同一约定。缺省增益 100 = 不改音量。 */
  encoderFor(c: SendspinConnection): ChunkEncoder {
    return this.encoderForGroup(c.codec, c.appliedGain?.() ?? 100);
  }
  /** 该连接所属编码组已产出的真实首段 STREAMINFO(未产出则 undefined)。
   *  供 stream/start 用真实值,避免手工合成 header 与实流漂移。
   *  ⚠️ 只读不建:此处若创建编码器会白白多起一个实例(且未喂料时 header 必为 undefined)。 */
  realFlacHeaderB64(c: SendspinConnection): string | undefined {
    return this.encoders.get(this.encoderKey(c.codec, c.appliedGain()))?.getCodecHeaderB64?.() ?? undefined;
  }
  /** 本组当前公共 send_ahead(微秒)。与帧头里填的值**同源** —— 时间线锚点
   *  必须用同一个量(MA `push_stream.py:1313`),否则 `delta=(ts-send_ahead)-now`
   *  不为 0,设备会立刻判「已过期」→ underrun。 */
  commonSendAheadUs(): number {
    return computeCommonSendAhead([...this.members].map((m) => sendAheadInputOf(m)));
  }

  // ---- 缓冲档位 × 设备容量匹配(见 PREFILL_BUFFER_MAX_MS 注释与
  //      SendspinConnection.bufferCapacityBytes) ----

  /** 本首歌累计已推送的**压缩字节数 / 样本数**(单成员口径,用于实测码率)。
   *  只在 pushFrame 里累加;起播时由 resetPushMeter 清零。 */
  private pushedBytes = 0;
  private pushedSamples = 0;

  /** 每个**编码组**(键 = `codec:gain`)累计已交付的样本数(单声道口径)。
   *  时间线推进取它的**上包络增量**,而不是「每批各成员产出取 max」——详见 pushFrame。 */
  private deliveredByGroup = new Map<string, number>();
  /** 上包络(单调不减):成员/编码组增删(含播中加入)时时间线永不倒退、不停滞。 */
  private deliveredPeak = 0;

  /** **尚未播到**的音频缓存(late-join 回填用),键 = 编码组(`codec:gain`)。
   *
   *  为什么按编码组而不是按成员:同组字节**逐字节相同**(见 pushFrame ①),
   *  所以一份缓存就能给该组任意新成员复用 —— 与 aiosendspin 的
   *  `_role_chunk_cache`(按 TransformKey 缓存已编码 chunk)同构。
   *
   *  逐出规则对齐 aiosendspin `_prune_role_chunk_cache`:丢掉
   *  `ts + duration <= now - KEEP_PAST` 的条目,即只留「未来还没播的」加 1s 尾巴。 */
  private recentByGroup = new Map<
    string,
    Array<{ tsUs: bigint; durUs: number; data: Uint8Array }>
  >();

  /** 起播/重建流时清零计量窗口(上一首的码率、上一段流的交付累积对新流都无参考价值)。 */
  resetPushMeter(): void {
    this.pushedBytes = 0;
    this.pushedSamples = 0;
    this.deliveredByGroup.clear();
    this.deliveredPeak = 0;
    // 上一首的字节对新流毫无用处:留着只会让新成员被回填进**已经播完**的音频。
    this.recentByGroup.clear();
  }

  /** 是否已有**实测**码率(否则 encodedBytesPerSec 走名义回落)。
   *  供日志判据用:首帧时必然还没样本,此时打出来的秒数偏保守,会误导排障。 */
  hasMeasuredRate(): boolean {
    return this.pushedSamples > 0 && this.pushedBytes > 0;
  }

  /** 实测「压缩字节/秒」。样本数 → 秒;无样本时按 codec 名义值回落。 */
  encodedBytesPerSec(): number {
    if (this.pushedSamples > 0 && this.pushedBytes > 0) {
      const secs = this.pushedSamples / SAMPLE_RATE;
      if (secs > 0) return this.pushedBytes / secs;
    }
    // 名义值(实测出来前只用一两帧,影响可忽略):
    //   PCM 48k/16/2 = 192000 B/s;FLAC 取 0.7 × PCM(偏保守 → 钳制更紧,更安全)。
    const codec = [...this.members][0]?.codec ?? "pcm";
    return codec === "pcm" ? SAMPLE_RATE * 2 * 2 : SAMPLE_RATE * 2 * 2 * 0.7;
  }

  /** 全员宣告的缓冲容量取**最小值**(0 视为未宣告,忽略);全都没宣告 → 0。 */
  deviceCapacityBytes(): number {
    let min = 0;
    for (const m of this.members) {
      const b = m.bufferCapacityBytes;
      if (b > 0 && (min === 0 || b < min)) min = b;
    }
    return min;
  }

  /** 预填充水位的**设备容量上界**(毫秒)。
   *
   *  两个独立约束取小(对照 aiosendspin `BufferTracker`:`capacity_bytes` +
   *  `max_duration_us`,二者是「独立的」两把尺):
   *    ① 时长:`PREFILL_BUFFER_MAX_MS`(30s,= aiosendspin
   *       `PlayerPersistentState.max_duration_us` 默认 30_000_000);
   *    ② 字节:`deviceCapacityBytes × DEVICE_BUFFER_HEADROOM_RATIO ÷ 实测码率`。
   *
   *  设备未宣告容量时返回 ①(行为与加入本逻辑前**完全一致**)。
   *  真机 1.6MB + FLAC 实测下 ② ≈ 9.1 秒 —— 选 15/20/25/30s 档会被钳到 ②,
   *  这不是「档位失效」:超过设备环形缓冲的部分根本放不下,推过去只会
   *  被设备逐帧拒收(`Failed to send audio chunk`)并抽干缓冲 → 插静音卡顿。
   *  要更深的水位请调大设备侧 `buffer_size`。 */
  capacityLimitedPrefillMs(): number {
    const cap = this.deviceCapacityBytes();
    if (cap <= 0) return PREFILL_BUFFER_MAX_MS;
    const usable = cap * DEVICE_BUFFER_HEADROOM_RATIO;
    const byBytes = (usable / Math.max(1, this.encodedBytesPerSec())) * 1000;
    return Math.max(PREFILL_BUFFER_MIN_MS, Math.min(PREFILL_BUFFER_MAX_MS, Math.floor(byBytes)));
  }
  private scalePcm(pcm: Float32Array, gain: number): Float32Array {
    const g = gain / 100;
    if (g >= 1) return pcm;
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * g;
    return out;
  }
  /** 推一批 PCM 给全部成员,返回**本批时间线推进量**(样本,单声道口径)。
   *
   *  ## 返回值 = 真正上网的音频量(时间线推进依据)
   *
   *  调用方按 `samples / SAMPLE_RATE` 前进游标(见 streamEngine.pushLoop 与
   *  playerCore 播报循环),所以这里必须是实测值,不能是估算。
   *
   *  ## ① 按 (codec, gain) 分组编码:同组只编一次
   *
   *  同一份 PCM + 同一 codec + 同一增益 ⇒ 编出的字节**逐字节相同**,与是哪个客户端
   *  无关。旧实现给每个成员各建编码器、各编一遍,代价有三:
   *    1. CPU × 成员数 —— libFLAC 是进程内同步(asm.js)编码,直接占用事件循环;
   *    2. 各编码器的**块相位**由创建时刻决定 ⇒ 彼此错开;
   *    3. 「时间线推进」按每批各成员产出取 max ⇒ 相位错开时把**并集**当本批推进。
   *  第 3 条正是 2026-09-24 真机「播放中把 Sendspin 播放器加入群组后整组一卡一卡」
   *  的根因(见下)。按组编码后,同组设备拿到完全相同的字节与时间戳序列。
   *
   *  ## ② 时间线用 max-of-**累计** 的上包络增量,而不是「每批取 max」
   *
   *  块编码器(libFLAC)攒满一块才吐一帧(4096 样本 ≈ 85ms),**某批零产出是正常的**。
   *  旧口径每批取 `max(各成员本批产出)`,两组相位错开时:
   *      批 k  : A 吐一帧(4096) / B 吐 0     → 记 4096
   *      批 k+1: A 吐 0        / B 吐一帧(4096) → 又记 4096
   *  两批共记 8192,而真正上网的音频只有 4096 ⇒ 时间线按 ~2× 推进(真机实测净
   *  1.44×,因帧长可变)。时间戳跑到墙钟前面 → 设备排程跟不上 → 反复
   *  `Lost sync` / 插静音,听感一卡一卡;且**只有当前这首坏、切歌即恢复**
   *  (新曲全员同时创建编码器 ⇒ 相位重新对齐,这正是该 bug 的指纹)。
   *
   *  改为每编码组维护**累计交付样本**,推进量 = `max(累计)` 的增量:相位错开相互
   *  抵消,长期严格等于真实上网的音频量。`deliveredPeak` 单调不减、且新编码组以
   *  当前峰值为基线登记,所以成员增删(含播中加入)都不会让时间线倒退或停滞。
   */
  async pushFrame(tsUs: bigint, pcm: Float32Array): Promise<number> {
    // ---- 分组:同 (codec, gain) 的成员共享一次编码 ----
    const groups = new Map<
      string,
      { codec: SendspinCodec; gain: number; members: SendspinConnection[] }
    >();
    for (const c of this.members) {
      const gain = c.appliedGain();
      const key = this.encoderKey(c.codec, gain);
      let g = groups.get(key);
      if (!g) {
        g = { codec: c.codec, gain, members: [] };
        groups.set(key, g);
      }
      g.members.push(c);
    }

    const before = this.deliveredPeak;
    let peak = before;
    // 码率计量跟**本批推进最多**的组走(单成员口径,与旧实现同义):各组成交量本应
    // 相同,取 max 是为了避开「某组恰好缓冲未吐」时把样本数记小、码率算大。
    let meterSamples = 0;
    let meterBytes = 0;

    for (const [key, g] of groups) {
      const enc = this.encoderForGroup(g.codec, g.gain);
      let chunks: EncodedChunk[];
      try {
        chunks = await enc.encode(this.scalePcm(pcm, g.gain));
      } catch (e) {
        // 编码阶段异常带上下文再抛,便于上游区分「编码器坏了」与「连接断了」。
        throw new Error(
          `encode failed (codec=${g.codec} gain=${g.gain} members=${g.members.length}): ${(e as Error)?.message || e}`,
        );
      }
      // ★ 该组**首块音频已产出**时才给组内成员发 stream/start(见 flushAnnounceFor 注释):
      //   先宣告再等编码器吐货会在 FLAC 链路留出 ~85ms 空窗,设备据此刻丢弃该流
      //   → 播放中加入的新成员无声(2026-09-24 真机)。PCM 因首批即有产出不受影响。
      if (chunks.length > 0) {
        for (const c of g.members) this.flushAnnounceFor(c);
      }

      let sum = 0;
      let bytes = 0;
      let ts = tsUs;
      // late-join 回填缓存:逐帧记下**本组真正发出去的 chunk** 及其真实起点时间戳。
      // 只有这里(唯一的下发点)能拿到「未来还没播的音频」,新成员加入时靠它补齐。
      const ring = this.ringFor(key);
      for (const ck of chunks) {
        const n = ck.frameSamples ?? 0;
        sum += n;
        const data = ck.data;
        // 空包必跳过:严格客户端收空包会判 Invalid data(2026-09-17 ESPHome 真机)。
        if (data && data.length > 0) {
          bytes += data.length;
          // 同一份字节分发给组内全部成员 —— 字节与时间戳序列完全一致。
          for (const c of g.members) c.sendAudio(ts, data);
          if (n > 0) ring.push({ tsUs: ts, durUs: Math.round((n * 1_000_000) / SAMPLE_RATE), data });
        }
        // 时间戳一律以**实测样本数**推进,见 EncodedChunk.frameSamples。
        //
        // ⚠️ 同一批里若有**多帧**(libFLAC 在某次喂料后恰好凑满 2 帧、或抖动后补吐),
        // 绝不能全用同一个 `tsUs` —— 第 2 帧的真实起点比第 1 帧晚
        // `frameSamples / SAMPLE_RATE` 秒。共用一个 ts 会让第 2 帧被判「已过期」
        // → 设备立即吐字节 → 缓冲空 → underrun。因此逐帧按 `ck.frameSamples` 推进。
        if (n > 0) ts += BigInt(Math.round((n * 1_000_000) / SAMPLE_RATE));
      }

      // 该组累计交付。新组以**当前峰值**为基线登记 —— 否则播中加入的新成员
      // (或新出现的 codec/gain 组合)会把 max 拉低,时间线倒着走。
      const cum = (this.deliveredByGroup.get(key) ?? before) + sum;
      this.deliveredByGroup.set(key, cum);
      if (cum > peak) peak = cum;

      if (sum > meterSamples) {
        meterSamples = sum;
        meterBytes = bytes;
      }
    }

    this.deliveredPeak = peak;
    if (meterSamples > 0) {
      this.pushedSamples += meterSamples;
      this.pushedBytes += meterBytes;
    }
    this.pruneRecent();
    return peak - before;
  }

  /** 取(必要时创建)某编码组的 late-join 缓存。 */
  private ringFor(key: string): Array<{ tsUs: bigint; durUs: number; data: Uint8Array }> {
    let r = this.recentByGroup.get(key);
    if (!r) {
      r = [];
      this.recentByGroup.set(key, r);
    }
    return r;
  }

  /** 逐出 late-join 缓存:① 已经播完(ts+dur ≤ now−KEEP_PAST)的;② 超出总时长上限的。
   *  对齐 aiosendspin `_prune_role_chunk_cache` —— 缓存只保留「尚未播到」的音频。 */
  private pruneRecent(): void {
    const cut = nowUs() - BigInt(LATE_JOIN_KEEP_PAST_US);
    for (const [key, ring] of this.recentByGroup) {
      while (ring.length > 0 && ring[0].tsUs + BigInt(ring[0].durUs) <= cut) ring.shift();
      let total = 0;
      for (let i = ring.length - 1; i >= 0; i--) {
        total += ring[i].durUs;
        if (total > LATE_JOIN_RING_MAX_US) {
          ring.splice(0, i + 1);
          break;
        }
      }
      if (ring.length === 0) this.recentByGroup.delete(key);
    }
  }

  /** late-join 回填:**播中加入**的成员立即补齐「它本该已经收到的音频」。
   *
   *  背景(2026-09-24 真机):组时间线游标领先墙钟一整个预填充水位(30s 档 ≈ 29s),
   *  新成员若只等未来帧,就要空等一个水位才出声 —— 这就是「加入新设备要很久才
   *  发出声音」。MA/aiosendspin 的解法是 `on_role_join` 回放缓存
   *  (`_send_cached_chunks_to_role` / `_start_catchup_encoding`):把**起点 ≥
   *  late-join 目标时刻**的缓存 chunk 立刻发给新角色,之后无缝接实时流。
   *
   *  这里做同一件事,只是字节已经在缓存里(同组字节逐字节相同,无需重新编码):
   *    ① 目标时刻 = `now + send_ahead + LATE_JOIN_MARGIN_US`
   *       —— 设备**按 `ts − send_ahead` 决定何时播**这一块,所以「不在过去」的
   *       充要条件是 `ts ≥ now + send_ahead`;加上余量后新成员约 0.1s 出声,且与
   *       老成员播的是**同一份时间戳**,天然对齐(不像起播锚点可以随便定提前量:
   *       起播时没有别人在对齐,late-join 必须贴住既有时间轴);
   *    ② 跳过起点早于目标时刻的 chunk(对齐 MA:「straddling 的整块跳过」);
   *    ③ 只回填设备装得下的量(容量钳制),避免一进来就把设备灌满被逐帧拒收;
   *    ④ 宣告必须在音频之前(`stream/start` 先到,否则设备在空等中丢弃该流)。
   *
   *  返回回填的 chunk 数(0 = 无可回填,调用方按原路径等未来帧即可)。 */
  seedLateJoin(c: SendspinConnection): number {
    // 设备明确报 available:false 时不回填 —— 音频要跟在 stream/start 之后。
    if (!c.clientWantsStream()) return 0;
    const ring = this.recentByGroup.get(this.encoderKey(c.codec, c.appliedGain()));
    if (!ring || ring.length === 0) return 0;

    // 帧头不带 send_ahead(见 sendAudio 注释),设备用的是它自己的(未协商时默认
    // 800ms)。组公共值就是我们对它的最佳估计,与锚点用的是同一个量。
    const sendAheadUs = Math.max(this.commonSendAheadUs(), LATE_JOIN_MARGIN_US);
    const target = nowUs() + BigInt(sendAheadUs + LATE_JOIN_MARGIN_US);
    let startIdx = -1;
    for (let i = 0; i < ring.length; i++) {
      if (ring[i].tsUs >= target) { startIdx = i; break; }
    }
    // 缓存里全是「已经播到/播过」的音频(例如刚起播、水位还没立起来)→ 无可回填。
    if (startIdx < 0) return 0;

    const capUs = Math.max(0, this.capacityLimitedPrefillMs()) * 1000;
    const items: Array<{ tsUs: bigint; data: Uint8Array }> = [];
    let accUs = 0;
    for (let i = startIdx; i < ring.length; i++) {
      if (accUs >= capUs) break;
      accUs += ring[i].durUs;
      items.push({ tsUs: ring[i].tsUs, data: ring[i].data });
    }
    if (items.length === 0) return 0;

    // ★ 先宣告、后音频(见 flushAnnounceFor:先给货后宣告会留空窗,设备丢弃该流)。
    if (!this.pendingAnnounces.includes(c)) this.pendingAnnounces.push(c);
    this.flushAnnounceFor(c);
    for (const it of items) c.sendAudio(it.tsUs, it.data);
    this.server.log(
      "info",
      `sendspin late-join 回填: client=${c.clientId} codec=${c.codec} chunks=${items.length} ` +
        `span=${Math.round(accUs / 1000)}ms target=${target - nowUs()}us(ahead of now) group=${this.name}`,
    );
    return items.length;
  }
  /** 曲终/停止:对全员发 stream/end(结束全部角色流) + group/update(stopped)。
   *  缺了客户端永远卡 PLAYING(2026-09-17 ESPHome 真机:播完 30s 还 PLAYING)。
   *  调用前先把 current 置空,sendGroupUpdate 才能报出 stopped。 */
  finishPlayback(): void {
    for (const c of this.members) {
      const reg = c.clientId ? this.server.clients.get(c.clientId) : undefined;
      this.server.log("info", `finishPlayback member=${c.clientId} legacy=${c.legacy} ws=${(c as any).ws?.readyState} registered=${reg === c}`);
      c.sendJson("stream/end", {});
      c.sendGroupUpdate();
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
    this.recentByGroup.clear();
    return n;
  }
}

/** 推流编码偏好(可在 plugin 配置页切换的值域)。 */
export type SendspinCodecPreference = Extract<SendspinCodec, "pcm" | "flac">;

/** 把任意配置值收敛成合法偏好:非法/缺失一律回退 `pcm`。 */
export function normalizeCodecPreference(v: unknown): SendspinCodecPreference {
  const s = String(v ?? "").toLowerCase();
  return s === "flac" ? "flac" : "pcm";
}

/** 按客户端 player_support 协商编码(管线恒定 48kHz 立体声,见 encoding.ts)。
 *  只从 PCM / FLAC 里选(裸 opus 常被这类客户端拒收 —— 9.x:
 *  "only PCM and FLAC are supported",硬编码跳过 opus)。只声明其他 codec
 *  (仅 opus/mp3 等)的回落到 `preferred` 的兜底值。
 *  键名兼容:9.x 线上为 player@v1_support(别名),老版本为 player_support。
 *
 *  `preferred`(缺省 pcm)决定**探测顺序**,不是强制:首选不被支持就自动退到另一种,
 *  两者都不支持才落到 FLAC(带 codec_header,严格客户端唯一稳妥解)。
 *  两种链路的选择理由见下方注释。 */
export function negotiateCodec(payload: any, preferred: SendspinCodecPreference = "pcm"): SendspinCodec {
  const list = payload?.["player@v1_support"]?.supported_formats ?? payload?.player_support?.supported_formats;
  const have = new Set(
    Array.isArray(list) ? list.map((f: any) => String(f?.codec || "").toLowerCase()) : [],
  );
  //
  // ⚠️ **默认 PCM 优先,FLAC 兜底**(2026-09-17 真机实测:此配置下 `Lost sync` 归零、
  //   出声三件套齐全、零报错)。
  // 选 PCM 的理由(ESP32 端压倒性优势):
  //   - FLAC:设备每 85ms 要用 micro-flac 解一个 4096 样本帧,且服务端 libFLAC
  //     也要攒满 4096 才吐 ⇒ 25ms 喂料 / 85ms 吐块天然错位,时间线极易失步。
  //   - PCM:sendspin-cpp 走 `CHUNK_TYPE_PCM_DUMMY_HEADER` + `decode_dummy_header`,
  //     `decode_audio_chunk()` 里更只是一条 `std::memcpy` —— 零解码、零攒样。
  // 代价只有带宽(48k/2ch/16bit = 1.536 Mbps),局域网内完全可接受。
  //
  // 📌 FLAC 链路本身的三处修复(9B 帧头 / 时间线按实产推进 / 绝对时刻调度)均已落地,
  //   因此**切到 FLAC 也能出声**;个别设备/固件在 FLAC 上表现更好时可把它设为首选。
  const order: SendspinCodecPreference[] = preferred === "flac" ? ["flac", "pcm"] : ["pcm", "flac"];
  for (const c of order) if (have.has(c)) return c;
  return "flac"; // 两者都没报:退回 FLAC(带 codec_header,严格客户端唯一稳妥解)
}

/** 从连接取出 send_ahead 计算入参:仅当设备**已上报** client/state 时才带入
 *  其参数,否则留 undefined 让 `computeCommonSendAhead` 用缺省(向后兼容旧固件)。 */
function sendAheadInputOf(c: SendspinConnection): SendAheadInput {
  return {
    latencyFuncMs: c.latencyFuncMs,
    minBufferMs: c.stateReported ? c.minBufferMs : undefined,
    requiredLeadTimeMs: c.stateReported ? c.requiredLeadTimeMs : undefined,
    outputDelayMs: c.stateReported ? c.outputDelayMs : undefined,
  };
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
  /** 对端 IP(已归一化,去 IPv4-mapped IPv6 前缀)。来源:
   *  - 客户端拨入:`WebSocketServer` 的 `connection` 回调第二个参数 req 的 socket 地址;
   *  - 服务端拨出(`dialPlayer`):拨号 URL 的 hostname。
   *  ESPHome 6053 只读桥接用它自动派生目标,用户无需手工填设备 host。 */
  remoteHost = "";
  group: SendspinGroup | null = null;
  codec: SendspinCodec = "pcm";
  volume = 100;
  muted = false;
  roles: string[] = [];
  latitude = 0;
  longitude = 0;
  latencyFuncMs = 30;
  clientHello: Record<string, any> | null = null;

  /** ---- 设备上报的延迟参数(来自 `client/state.payload.player`,P1 对齐 MA)----
   *  aiosendspin `PlayerStatePayload` 是 **client → server** 方向,设备用它告诉
   *  服务端「我需要多少提前量才能不断流」。此前我们硬编码 800ms 且**完全没有
   *  解析分支** —— 设备报什么都不看,等于闭眼猜。
   *
   *  - `required_lead_time_ms`:从服务端发出 stream/start(或 stream/clear)到
   *    **首个后续音频块**的时间戳之间的最小提前量(设备实测自己的启动开销);
   *  - `min_buffer_ms`:设备解码/播放缓冲最低水位,低于它即 underrun;
   *  - `output_delay_ms`:设备输出链路固有延迟(DAC / I2S / 扬声器).
   *
   *  MA 的合成公式:`send_ahead = max(min_buffer, required_lead) + output_delay`
   *  (见 `_role_send_ahead_us`;live 流不含 required_lead)。 */
  outputDelayMs = 0;
  requiredLeadTimeMs = 0;
  minBufferMs = 0;
  /** 是否已收到过 client/state(未见过的设备回落到保守缺省)。 */
  stateReported = false;
  /** 设备侧缓冲区容量(ms)。`client/state` / `client/hello` 均可携带;
   *  0 = **未上报**(旧固件 / legacy 明文路径),此时不做任何钳制。 */
  bufferCapacityMs = 0;
  /** 设备是否愿收流(spec `client/state.available`)。
   *  `null` = 从未上报 → 不做门控(向后兼容);`false` = 明确拒绝收流。 */
  clientAvailable: boolean | null = null;
  /** 设备播放状态(spec `state`):`synchronized` / `error` / …。 */
  clientSyncState: string | null = null;
  /** 收到 `available:false` / `state:error` 的时刻(用于门控超时兜底)。 */
  clientUnavailableSinceMs = 0;
  /** 上次已记录日志的同步状态,用于只记**变化**(见 noteSyncState)。 */
  private lastLoggedSyncState: string | null = null;
  /** 设备在 `client/hello` 里宣告的**压缩字节**缓冲上限(`player@v1_support.
   *  buffer_capacity`,单位 = byte)。0 = 未宣告(旧固件)→ 不做容量钳制。
   *
   *  为什么必须用它:aiosendspin `BufferTracker` 明确把它当 `capacity_bytes`
   *  用 —— 「server sends audio chunks as far ahead as the client's buffer
   *  capacity allows」是 spec 硬约束。推送量超过设备环形缓冲后,设备读不动
   *  socket,TCP 背压把帧堆在**服务端内存**里,设备端缓冲被抽干 → 反复 hard
   *  sync(阈值仅 5ms)→ 往音乐里插静音 → 听感「一卡一卡」。
   *  真机(ESPHome 2026.9.0 esp32-player-meet)实报 `buffer_capacity: 1600000`
   *  = 1.6MB —— 按 FLAC 实测量换算仅十来秒,正是「缓冲档位必须匹配设备」
   *  的那个数。 */
  bufferCapacityBytes = 0;

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

  constructor(server: SendspinServer, ws: WebSocket, remoteHost = "") {
    this.server = server;
    this.ws = ws;
    this.remoteHost = normalizeRemoteHost(remoteHost);
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
    this.codec = negotiateCodec(payload, this.server.preferredCodec);
    // 协商结果必打:codec 选错(如回落到 opus)时设备会静默不出声或整条 stream/start 作废,
    // 这条日志是排查「连上了但没声音」的第一站(2026-09-17 真机)。
    this.server.log("info", `legacy client/hello: codec=${this.codec} roles=${JSON.stringify(this.roles)} formats=${JSON.stringify(payload?.["player@v1_support"]?.supported_formats ?? payload?.player_support?.supported_formats ?? null)}`);
    // 原始 hello(截断 1500B):`client_id`/`device_info`/`supported_roles` 之后
    // 还可能有 spec 字段(如 `buffer_capacity`、`static_delay_ms`),只打解析后
    // 字段会看不到「设备到底宣告了什么」。1500B 足以覆盖 ESP32 单行 hello。
    try {
      this.server.log("info", `legacy client/hello RAW from ${clientId}: ${JSON.stringify(payload).slice(0, 1500)}`);
    } catch {
      /* 循环引用等极端情况忽略 */
    }
    this.parseHelloCapacity(payload);
    this.legacy = true;
    this.handshakeDone = true;
    this.phase = "ready";
    this.server.log("warn", `legacy unencrypted client: ${clientId} name=${this.name} (明文直通,配对不可用)`);
    // legacy 客户端只认 TEXT 帧:明文 server/hello。
    // ⚠️ 五字段必须齐全(server_id/name/version/active_roles/connection_reason):
    // sendspin-cpp 逐个严格校验,缺任一或枚举非法则整个 hello 作废 → 握手永不完成
    // → 30s nursery 超时被踢(2026-09-17 ESPHome 真机,见 protocol.cpp)。
    // connection_reason 决定多 server 仲裁优先级:discovery=礼貌探路(不抢占
    // 已有 playback 方,两边共存友好);playback=宣示播放权(会切换)。拨号用 discovery。
    this.sendCleartext("server/hello", {
      server_id: this.server.serverId,
      name: this.server.serverName,
      version: PROTOCOL_VERSION,
      active_roles: this.roles,
      connection_reason: "discovery",
    });
    // spec: provisional 连接 30s 内无 server/activate 即被 drop —— 真机(legacy)
    // 此前永远收不到 activate,每次 30.0s 准时 goodbye(another_server)离开。
    // Noise 路径在 onClientHello 发,这里补齐,同语义。
    this.sendJson("server/activate", { activities: ["playback"], active_roles: this.roles });
    this.sendGroupUpdate();
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
    if (t === "client/state") {
      // 设备上报延迟参数(MA PlayerStatePayload,client→server)。此前完全没解析。
      this.applyClientState(msg?.payload ?? {});
      return;
    }
    if (t === "client/time") {
      this.respondServerTime(msg?.payload ?? {});
      return;
    }
    if (t === "client/goodbye") {
      // 真机(sendspin-cpp)会用 goodbye 踢掉第二个 server(reason=another_server):
      // 必须打日志,否则 reason 只能靠抓包才看得见(2026-09-17 ESPHome 真机联调教训)。
      const reason = String((msg?.payload as any)?.reason ?? "");
      this.server.log("warn", `client/goodbye from ${this.clientId ?? "?"}: ${JSON.stringify(msg?.payload ?? {})}`);
      // spec:another_server/shutdown/user_request/unpaired/unauthorized/
      // pairing_required → SHOULD NOT auto-reconnect(之前无脑 60s 重拨,
      // 与设备"切换 server"打架,形成 dial→踢→重拨死循环)。记入抑制表,
      // 手动 dial 清除(运营商明确意图)。restart/concurrent_attempt 不抑制。
      if (this.dialed && this.dialHost && ["another_server", "shutdown", "user_request", "unpaired", "unauthorized", "pairing_required"].includes(reason)) {
        this.server.noAutoRedial.set(`${this.dialHost}:${this.dialPort}`, reason);
        this.server.log("warn", `auto-redial suppressed for ${this.dialHost}:${this.dialPort} (goodbye: ${reason});手动 dial 可恢复`);
      }
      try { this.ws.close(); } catch { /* ignore */ }
      return;
    }
    void this.server.router.handle(t, { ...(msg?.payload ?? {}), _conn: this });
  }

  /** 解析 `client/state` 的设备上报参数(P1 对齐 MA)。
   *
   *  payload 形状(MA `PlayerStatePayload`):
   *    { player: { output_delay_ms, required_lead_time_ms, min_buffer_ms,
   *                supported_commands, format } }
   *
   *  ⚠️ 这条消息此前**根本没有解析分支** —— 设备报什么都不看,send_ahead 硬编码
   *  800ms。设备(ESP32 sendspin-cpp)重启后 1-2s 内即上报,解析后 send_ahead
   *  才真正贴合本设备能力;未上报前保持缺省(向后兼容旧固件)。
   *
   *  2026-09-24 补齐 spec 三字段(`available` / `state` / `buffer_capacity`),
   *  并用真机 RAW 实测校正了**取值层级**:
   *
   *  真机(ESPHome 2026.9.0 / esp32-player-meet)实发 payload 为
   *    `{"state":"synchronized","player":{"volume":53,"muted":false,"static_delay_ms":0}}`
   *  —— `state` 在**根层**,而 `output_delay_ms` / `required_lead_time_ms` /
   *  `min_buffer_ms` / `available` / `buffer_capacity` **都不发**。
   *  也就是说:该固件下三个延迟量永远是缺省值(此前日志里的 `=0ms` 是缺省,
   *  不是设备真的上报了 0),`send_ahead` 一直走保守缺省。故 state/available
   *  一律**根层优先、player 层回落**,两个位置都读。
   *
   *  仍保持「未上报即不门控」的兼容语义,避免砸掉不发这些字段的旧固件。 */
  private applyClientState(payload: any): void {
    const root = payload && typeof payload === "object" ? payload : null;
    if (!root) return;
    const p = root.player && typeof root.player === "object" ? root.player : root;
    const num = (v: any): number | null => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const od = num(p.output_delay_ms);
    const rl = num(p.required_lead_time_ms);
    const mb = num(p.min_buffer_ms);
    if (od !== null) this.outputDelayMs = od;
    if (rl !== null) this.requiredLeadTimeMs = rl;
    if (mb !== null) this.minBufferMs = mb;
    // 设备输出链路固有延迟:真机报在 player 层 `static_delay_ms`(缺省 0)。
    const sd = num(p.static_delay_ms);
    if (sd !== null && od === null) this.outputDelayMs = sd;
    // ---- spec 三字段:根层优先,player 层回落(设备可能只发其中一部分) ----
    const cap = num(root.buffer_capacity_ms ?? root.buffer_capacity ?? p.buffer_capacity_ms ?? p.buffer_capacity);
    if (cap !== null) this.bufferCapacityMs = cap;
    const availVal = root.available ?? p.available;
    if (typeof availVal === "boolean") {
      if (availVal) this.clientUnavailableSinceMs = 0;
      else if (this.clientAvailable !== false) this.clientUnavailableSinceMs = Date.now();
      this.clientAvailable = availVal;
    }
    const stateVal = root.state ?? p.state;
    if (typeof stateVal === "string" && stateVal) {
      this.clientSyncState = stateVal;
      this.noteSyncState(stateVal);
    }
    const first = !this.stateReported;
    this.stateReported = true;
    // 首次上报打**完整原始 payload**(截断 600B):排查「设备到底报了什么」
    // 时不必再改代码重编。设备只在状态变化时才发,量可控。
    if (first) {
      let raw = "";
      try {
        raw = JSON.stringify(payload).slice(0, 600);
      } catch {
        raw = "<unserializable>";
      }
      this.server.log("info", `client/state RAW (first) from ${this.clientId ?? "?"}: ${raw}`);
    }
    this.server.log(
      "info",
      `client/state from ${this.clientId ?? "?"}${first ? " (first)" : ""}: ` +
      `output_delay=${this.outputDelayMs}ms required_lead=${this.requiredLeadTimeMs}ms ` +
      `min_buffer=${this.minBufferMs}ms buffer_capacity=${this.bufferCapacityMs}ms ` +
      `available=${this.clientAvailable} state=${this.clientSyncState}`,
    );
  }

  /** 解析 `client/hello` 里的设备缓冲容量(`player@v1_support.buffer_capacity`)。
   *
   *  真机实发(ESPHome 2026.9.0 / esp32-player-meet):
   *    `"player@v1_support": { supported_formats: [...], buffer_capacity: 1600000,
   *                            supported_commands: ["volume","mute"] }`
   *  另兼容 `player_support`(非 v1 legacy 键名)与顶层 `buffer_capacity`。
   *  单位是 **byte**(对照 aiosendspin `BufferTracker(capacity_bytes=...)`)。
   *  解析到就记一条日志 —— 档位是否需要被钳制,全看这个数。 */
  private parseHelloCapacity(payload: any): void {
    const n = parseHelloBufferCapacity(payload);
    if (n <= 0) return;
    this.bufferCapacityBytes = n;
    this.server.log(
      "info",
      `client/hello: device buffer_capacity=${n} bytes ${this.clientId ?? "?"}`,
    );
  }

  /** 设备**同步状态变化**时的显式日志(spec `client/state.state`)。
   *
   *  真机只在状态**翻转**时才发 `client/state`,故这里的变化日志等价于一份
   *  「失步/恢复」时间线 —— 排查「播放中偶发卡顿」时,以往只能靠设备侧
   *  ESPHome 日志(WorkBuddy/opencode 侧拿不到),现在服务端即可自证。
   *  spec 语义:`error` = 失步(客户端应静音)、`synchronized` = 已恢复。 */
  private noteSyncState(next: string | null): void {
    if (next === this.lastLoggedSyncState) return;
    this.lastLoggedSyncState = next;
    if (next === "error") {
      this.server.log("warn", `client/state: device reported SYNC LOST (state=error) ${this.clientId ?? "?"}`);
    } else if (next === "synchronized") {
      this.server.log("info", `client/state: device reports synchronized ${this.clientId ?? "?"}`);
    }
  }

  /** 设备此刻是否愿收流(spec `available`)。
   *
   *  ⚠️ 只在设备**明确上报过** `available` 时才启用门控 —— `null`(从未上报,
   *  如 legacy 明文固件)一律返回 true,保持既有行为,绝不因新增门控砸掉旧设备。
   *  另设 3s 超时兜底:设备报 `available:false` 后若迟迟不转 true(固件卡死 /
   *  漏发状态翻转),超时后照常推流 —— 宁可冒设备丢帧的风险,也不要永久无声。 */
  clientWantsStream(): boolean {
    if (this.clientAvailable !== false) return true;
    if (this.clientUnavailableSinceMs > 0 && Date.now() - this.clientUnavailableSinceMs > 3000) {
      return true;
    }
    return false;
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
      if (m.type === "client/state") {
        // 设备上报延迟参数(加密/Noise 路径,与 legacy 同语义)。
        this.applyClientState(m.payload ?? {});
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
    this.codec = negotiateCodec(payload, this.server.preferredCodec);
    this.server.log("info", `activated ${this.clientId} name=${this.name} roles=${this.roles.join(",")} codec=${this.codec}`);
    this.parseHelloCapacity(hello);
    this.sendJson("server/activate", { activities: ["playback"], active_roles: this.roles });
    // spec MUST:首次 activate 后立即下发 group/update(真实客户端如 sendspin-cpp
    // 在收到它之前不认 server;此前从没发过,ESPHome 真机 ~30s 后 goodbye 离开)。
    this.sendGroupUpdate();
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
    // 帧头 = 9B(1B type + 8B 微秒时间戳),**不含 send_ahead**。
    // ⚠️ 曾经这里多塞 4B send_ahead(13B 头),设备把其当成 FLAC 数据前 4 字节 →
    //    首字节 0x00 ≠ 0xFF → 每包 `Serious error decoding FLAC file` → 完全无声。
    //    详见 framing.ts packAudioChunk 注释(2026-09-17 实锤)。
    const pkt = packAudioChunk(tsUs, codecData);
    if (this.legacy) {
      this.ws.send(Buffer.from(pkt), { binary: true });
      return;
    }
    this._sendPlain(pkt);
  }

  /** 新曲起播宣告流格式。真实播放器(9.x / sendspin-cpp / legacy)在收到
   *  stream/start 前会丢弃音频(无 format 不播)。codec 取连接协商结果,
   *  管线恒定 48kHz 立体声 16bit。
   *
   *  FLAC 的 codec_header 取**编码器首段的真实 STREAMINFO**
   *  (`enc.getCodecHeaderB64()`,对齐 aiosendspin 的 `transformer.get_header()`)。
   *  手工合成的 STREAMINFO 极易与 ffmpeg 实流产漂移 —— 曾把 block size 写 4096
   *  而实流是 4608、把位深写 16 而 ffmpeg 默认编 24bit,严格解码器逐帧校验失败
   *  导致「日志全绿但无声」(2026-09-17 真机两轮踩坑)。
   *  首段尚未产出时回落到合成值(值已按实测校正),首段产出后可选重发。
   *
   *  延迟调用:aiosendspin 把 stream/start **推迟到第一块音频到达时**才发
   *  (见 player/v1.py `_pending_stream_start`),正是为了拿到真实 header。
   *  `announceStream()` 保留即时发送(兼容既有流程),`announceStreamWithHeader()`
   *  供首段产出后补发。 */
  announceStream(): void {
    this.announceStreamWithHeader(this.codec === "flac" ? this.flacHeaderB64() : null);
  }

  /** 当前 FLAC codec_header:优先编码器真实首段头,回落合成值。 */
  private flacHeaderB64(): string {
    const g = this.group;
    if (g) {
      for (const m of g.members) {
        const h = g.realFlacHeaderB64(m);
        if (h) return h;
      }
    }
    return flacCodecHeaderB64();
  }

  announceStreamWithHeader(codecHeaderB64: string | null): void {
    const player: Record<string, unknown> = { codec: this.codec, sample_rate: 48000, channels: 2, bit_depth: FLAC_BIT_DEPTH };
    if (this.codec === "flac" && codecHeaderB64) player.codec_header = codecHeaderB64;
    const payload = { player };
    this.server.log("info", `announceStream -> ${JSON.stringify(payload).slice(0, 220)} legacy=${this.legacy} ws=${(this as any).ws?.readyState}`);
    this.sendJson("stream/start", payload);
  }
  /** spec MUST 的组状态:首次 activate 后立即发,字段变化时重发。
   *  未入组(idle)时按其默认组(clientId)报 stopped,给客户端稳定的组身份。 */
  sendGroupUpdate(): void {
    const g = this.group;
    this.sendJson("group/update", {
      playback_state: g?.current ? "playing" : "stopped",
      group_id: g?.name ?? this.clientId ?? "",
      group_name: g?.name ?? this.name,
    });
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