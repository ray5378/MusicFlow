// RAOP 传输层协议契约测试。
//
// 为什么单独测:raop.ts 的 `RaopPlayer` 是「协议状态机 + RTP 位打包」,真机才
// 能跑通的部分(socket bind / RTSP TCP)在网络层,而**协议字段写错**的表现是
// 设备端无声、进度条乱跳、多端不同步、丢包后永久破音 —— 这类 bug 在集成测试里
// 极难归因,只能靠字节级断言拦住。
//
// 手法:不连真网络。构造 `RaopPlayer` 后把假 UDP/TCP socket 塞进私有字段
// (TS 的 private 只是编译期约束),直接驱动 sendChunk / onLoss / sendSync /
// startUdpListeners / prepareSeek 等协议方法,再断言发出的每一个字节。
//
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import {
  generateKeyPairSync,
  privateDecrypt,
  createDecipheriv,
  constants,
} from "crypto";
import {
  RaopPlayer,
  CHUNK_LEN,
  SAMPLE_RATE,
  SAMPLE_SIZE,
  CHANNELS,
  resolveRsaPublicKey,
  rsaOaepEncrypt,
  aesCbcEncrypt,
} from "../../src/services/airplay/raop.js";

// ---------------------------------------------------------------------------
// 假 socket
// ---------------------------------------------------------------------------

/** 假 UDP socket:记录每一次 send,可 emit("message") 模拟设备来包。 */
class FakeUdp extends EventEmitter {
  sent: Array<{ buf: Buffer; port: number; addr: string }> = [];
  closed = false;
  constructor(private port = 6001, private addr = "192.168.1.9") {
    super();
  }
  /** 兼容 dgram 的两种重载:send(msg, port, addr) 与 send(msg, off, len, port, addr)。 */
  send(buf: Buffer, ...rest: any[]): void {
    let payload: Buffer;
    let port: number;
    let addr: string;
    if (typeof rest[0] === "number" && typeof rest[1] === "number") {
      payload = Buffer.from(buf.subarray(rest[0], rest[0] + rest[1]));
      port = rest[2];
      addr = rest[3];
    } else {
      payload = Buffer.from(buf);
      port = rest[0];
      addr = rest[1];
    }
    this.sent.push({ buf: payload, port, addr });
  }
  address() {
    return { address: this.addr, port: this.port, family: "IPv4" };
  }
  close() {
    this.closed = true;
  }
  get last(): Buffer {
    return this.sent[this.sent.length - 1].buf;
  }
}

/** 假 RTSP(TCP)socket:write 记下请求,并按预排队的回复分片异步 emit("data")。 */
class FakeTcp extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  private queue: string[][] = [];
  /** 为下一次 write 预排队回复;多个参数代表分片到达(测 Content-Length 拼接)。 */
  reply(...chunks: string[]): this {
    this.queue.push(chunks);
    return this;
  }
  write(buf: Buffer): boolean {
    this.written.push(buf.toString("latin1"));
    const chunks = this.queue.shift();
    if (!chunks) return true; // 无回复 → 对端沉默(调用方会撞上 10s 超时)
    setImmediate(() => {
      for (const c of chunks) this.emit("data", Buffer.from(c, "latin1"));
    });
    return true;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

const HOST = "192.168.1.50";

/** 造一个「已进入 RECORD 之后状态」的 player,协议字段全部注入成确定值。 */
function makePlayer(opts: Record<string, unknown> = {}) {
  const p = new RaopPlayer({ host: HOST, ...opts } as any);
  const audio = new FakeUdp(6001);
  const ctrl = new FakeUdp(6002);
  const time = new FakeUdp(6003);
  const anyP = p as any;
  anyP.audioSocket = audio;
  anyP.ctrlSocket = ctrl;
  anyP.timeSocket = time;
  anyP.serverAudioPort = 7000;
  anyP.serverControlPort = 7001;
  anyP.started = true;
  anyP.headTs = 441000;
  anyP.baseTs = 441000;
  anyP.startTs = 441000;
  anyP.seq = 0;
  anyP.url = `rtsp://${HOST}:5000/1234567890`;
  // 收口:清掉可能残留的 10s RTSP 超时定时器与 sync 定时器,否则进程会挂住等它们触发。
  cleanup.push(() => {
    if (anyP.syncTimer) clearInterval(anyP.syncTimer);
    for (const s of [audio, ctrl, time]) s.removeAllListeners();
  });
  return { p, anyP, audio, ctrl, time };
}

/** 一帧一包的标准 PCM(立体声 16bit)。 */
function pcmChunk(): Buffer {
  return Buffer.alloc(CHUNK_LEN * 4);
}

const cleanup: Array<() => void> = [];
const tcpSockets: FakeTcp[] = [];

beforeEach(() => {
  cleanup.length = 0;
  tcpSockets.length = 0;
});

afterEach(() => {
  // RTSP 请求成功 resolve 后源码不清超时定时器(靠 socket close 清),测试里必须
  // 手动关掉所有假 socket,否则每个残留定时器会让进程多等最多 10s。
  for (const t of tcpSockets) if (!t.destroyed) t.destroy();
  for (const fn of cleanup) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
});

function newTcp(): FakeTcp {
  const t = new FakeTcp();
  tcpSockets.push(t);
  return t;
}

// ---------------------------------------------------------------------------
// 1. 构造与加密协商
// ---------------------------------------------------------------------------
describe("RaopPlayer 构造:加密协商(et/forceRsa)", () => {
  it("默认 RTSP 端口 5000、采样率 44.1k", () => {
    const { anyP } = makePlayer();
    expect(anyP.opts.port).toBe(5000);
    expect(anyP.opts.sampleRate).toBe(SAMPLE_RATE);
    expect(anyP.opts.host).toBe(HOST);
  });

  it("mDNS TXT et 含 '1' → 走 RSA 加密音频", () => {
    const { p } = makePlayer({ et: "0,1,2" });
    expect(p.encrypted).toBe(true);
  });

  it("et 不含 '1' → 明文音频", () => {
    const { p } = makePlayer({ et: "0,2" });
    expect(p.encrypted).toBe(false);
  });

  it("forceRsa 可越过 et 强制加密(设备不宣告但服务端要求)", () => {
    const { p } = makePlayer({ forceRsa: true });
    expect(p.encrypted).toBe(true);
  });

  it("既无 et 也无 forceRsa → 明文", () => {
    const { p } = makePlayer();
    expect(p.encrypted).toBe(false);
  });

  it("显式 port / sampleRate 被保留", () => {
    const { anyP } = makePlayer({ port: 7000, sampleRate: 48000 });
    expect(anyP.opts.port).toBe(7000);
    expect(anyP.opts.sampleRate).toBe(48000);
  });
});

// ---------------------------------------------------------------------------
// 2. RSA 公钥解析
// ---------------------------------------------------------------------------
describe("resolveRsaPublicKey:设备 pk 优先,回落共享 AirPort 公钥", () => {
  it("无 pk → 回落内嵌的 well-known AirPort 公钥(可解析的 SPKI DER)", () => {
    const der = resolveRsaPublicKey(undefined);
    expect(der.length).toBeGreaterThan(200);
    // 能被 crypto 当 SPKI 吃下即证明格式正确
    expect(() => resolveRsaPublicKey("")).not.toThrow();
    expect(resolveRsaPublicKey("").equals(der)).toBe(true);
  });

  it("传合法 SPKI DER(base64) → 原样返回,不改写", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const out = resolveRsaPublicKey(der.toString("base64"));
    expect(out.equals(der)).toBe(true);
  });

  it("传 256 字节裸 modulus(非 DER)→ 按 JWK 组装成 SPKI", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as { n: string };
    const mod = Buffer.from(jwk.n, "base64url");
    expect(mod.length).toBe(256);
    const out = resolveRsaPublicKey(mod.toString("base64"));
    const expectDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    expect(out.equals(expectDer)).toBe(true);
  });

  it("传既非 SPKI 也非 256B 的垃圾 → 回落 well-known(不抛)", () => {
    const junk = Buffer.from("not-a-key-at-all").toString("base64");
    const out = resolveRsaPublicKey(junk);
    expect(out.equals(resolveRsaPublicKey(undefined))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. 加密 helpers
// ---------------------------------------------------------------------------
describe("rsaOaepEncrypt / aesCbcEncrypt(音频负载加密)", () => {
  it("rsaOaepEncrypt:真密钥对可往返解密(设备端用私钥还原 aes key)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pubDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const plain = Buffer.from("0123456789abcdef"); // 16B AES key
    const ct = rsaOaepEncrypt(pubDer, plain);
    expect(ct.length).toBe(256); // 2048-bit
    expect(ct.equals(plain)).toBe(false);
    const back = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING },
      ct,
    );
    expect(back.equals(plain)).toBe(true);
  });

  it("aesCbcEncrypt:整块(32B)全加密,可还原", () => {
    const key = Buffer.alloc(16, 0x11);
    const iv = Buffer.alloc(16, 0x22);
    const data = Buffer.alloc(32, 0xab);
    const enc = aesCbcEncrypt(data, key, iv);
    expect(enc.length).toBe(32);
    expect(enc.equals(data)).toBe(false);
    const dec = createDecipheriv("aes-128-cbc", key, iv);
    dec.setAutoPadding(false);
    const back = Buffer.concat([dec.update(enc), dec.final()]);
    expect(back.equals(data)).toBe(true);
  });

  it("aesCbcEncrypt:非整块(20B)只加密前 16B,尾部 4B 明文原样保留(对齐 libraop)", () => {
    const key = Buffer.alloc(16, 0x11);
    const iv = Buffer.alloc(16, 0x22);
    const data = Buffer.alloc(20, 0xcd);
    const enc = aesCbcEncrypt(data, key, iv);
    expect(enc.length).toBe(20);
    expect(enc.subarray(0, 16).equals(data.subarray(0, 16))).toBe(false);
    expect(enc.subarray(16).equals(data.subarray(16))).toBe(true);
  });

  it("aesCbcEncrypt:不足一块(10B)原样返回,不加密也不报错", () => {
    const key = Buffer.alloc(16, 1);
    const iv = Buffer.alloc(16, 2);
    const data = Buffer.alloc(10, 0x7e);
    const enc = aesCbcEncrypt(data, key, iv);
    expect(enc.length).toBe(10);
    expect(enc.equals(data)).toBe(true);
  });

  it("aesCbcEncrypt:空输入原样返回", () => {
    const empty = Buffer.alloc(0);
    expect(aesCbcEncrypt(empty, Buffer.alloc(16), Buffer.alloc(16)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. RTP 音频包 sendChunk
// ---------------------------------------------------------------------------
describe("sendChunk:RTP 音频包位布局", () => {
  it("首包带 marker(0x60|0x80 = 0xE0),后续包清掉 marker", () => {
    const { p, audio, anyP } = makePlayer();
    anyP.started = false; // 会话里还没发过任何音频包 → 这一包就是首包
    expect(p.sendChunk(pcmChunk())).toBe(true);
    expect(audio.sent[0].buf[1]).toBe(0xe0);
    p.sendChunk(pcmChunk());
    expect(audio.sent[1].buf[1]).toBe(0x60);
  });

  it("RTP 固定头:V=2(0x80)、payload type 0x60、ssrc 会话内不变", () => {
    const { p, audio, anyP } = makePlayer();
    p.sendChunk(pcmChunk());
    p.sendChunk(pcmChunk());
    const a = audio.sent[0].buf;
    const b = audio.sent[1].buf;
    expect(a[0]).toBe(0x80);
    expect(a.readUInt32BE(8)).toBe(anyP.ssrc >>> 0);
    expect(b.readUInt32BE(8)).toBe(a.readUInt32BE(8));
  });

  it("seq 每包 +1 并写入包头 2..4", () => {
    const { p, audio, anyP } = makePlayer();
    anyP.seq = 100;
    p.sendChunk(pcmChunk());
    p.sendChunk(pcmChunk());
    expect(audio.sent[0].buf.readUInt16BE(2)).toBe(101);
    expect(audio.sent[1].buf.readUInt16BE(2)).toBe(102);
  });

  it("每包 rtptime 推进 CHUNK_LEN,发完才抬 headTs", () => {
    const { p, audio, anyP } = makePlayer();
    anyP.headTs = 441000;
    p.sendChunk(pcmChunk());
    expect(audio.sent[0].buf.readUInt32BE(4)).toBe(441000);
    p.sendChunk(pcmChunk());
    expect(audio.sent[1].buf.readUInt32BE(4)).toBe(441000 + CHUNK_LEN);
  });

  it("positionSec 随发包推进 = (headTs - baseTs)/rate(经 ts2ms 取整到毫秒)", () => {
    const { p, anyP } = makePlayer();
    anyP.headTs = 441000;
    anyP.baseTs = 441000;
    p.sendChunk(pcmChunk());
    // ts2ms 内部 Math.floor → 位置粒度是 1ms,不能按未取整的 352/44100 断言
    const expectSec = Math.floor((CHUNK_LEN * 1000) / SAMPLE_RATE) / 1000;
    expect(p.positionSec).toBeCloseTo(expectSec, 6);
    expect(p.positionSec).toBeGreaterThan(0);
  });

  it("包发往 SETUP 拿到的 server_port(音频目的端口)", () => {
    const { p, audio } = makePlayer();
    p.sendChunk(pcmChunk());
    expect(audio.sent[0].port).toBe(7000);
    expect(audio.sent[0].addr).toBe(HOST);
  });

  it("无音频 socket 或正在销毁 → 返回 false,不发包", () => {
    const { p, anyP, audio } = makePlayer();
    anyP.destroying = true;
    expect(p.sendChunk(pcmChunk())).toBe(false);
    anyP.destroying = false;
    anyP.audioSocket = null;
    expect(p.sendChunk(pcmChunk())).toBe(false);
    expect(audio.sent.length).toBe(0);
  });

  it("重传 backlog 上限 128:超出后淘汰最老的包", () => {
    const { p, anyP } = makePlayer();
    anyP.seq = 0;
    for (let i = 0; i < 130; i++) p.sendChunk(pcmChunk());
    expect(anyP.audioBacklog.size).toBe(128);
    expect(anyP.audioBacklog.has(1)).toBe(false); // 第一个包已被淘汰
    expect(anyP.audioBacklog.has(2)).toBe(false);
    expect(anyP.audioBacklog.has(130)).toBe(true);
  });

  it("加密会话(rsa)发出的负载是密文,不等于明文 ALAC", () => {
    const { p, audio } = makePlayer({ et: "1" });
    p.sendChunk(pcmChunk());
    const { p: plainP, audio: plainAudio } = makePlayer();
    plainP.sendChunk(pcmChunk());
    // 两者长度一致(ALAC 打包长度固定),但内容不同 → 确实走了 AES
    expect(audio.sent[0].buf.length).toBe(plainAudio.sent[0].buf.length);
    expect(audio.sent[0].buf.subarray(12).equals(plainAudio.sent[0].buf.subarray(12))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. 丢包重传 onLoss
// ---------------------------------------------------------------------------
describe("onLoss:接收端丢包重传", () => {
  it("命中 backlog → 原包重发,RAOP 重传头为 80 D6 00 01", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.seq = 0;
    p.sendChunk(pcmChunk()); // seq=1
    const resend = ctrl;
    resend.sent.length = 0;
    anyP.onLoss(1, 1, 7001);
    expect(resend.sent.length).toBe(1);
    const r = resend.sent[0].buf;
    expect(r[0]).toBe(0x80);
    expect(r[1]).toBe(0xd6); // 0x56 | 0x80
    expect(r[2]).toBe(0);
    expect(r[3]).toBe(1);
  });

  it("重发包体与原始音频包一致(只改头部)", () => {
    const { p, anyP, audio, ctrl } = makePlayer();
    anyP.seq = 0;
    p.sendChunk(pcmChunk());
    const original = audio.sent[0].buf;
    ctrl.sent.length = 0;
    anyP.onLoss(1, 1, 7001);
    const r = ctrl.sent[0].buf;
    expect(r.length).toBe(original.length);
    expect(r.subarray(4).equals(original.subarray(4))).toBe(true);
  });

  it("backlog 里没有的 seq → 不重发(已被淘汰或从未发过)", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.seq = 0;
    p.sendChunk(pcmChunk());
    ctrl.sent.length = 0;
    anyP.onLoss(9999, 1, 7001);
    expect(ctrl.sent.length).toBe(0);
  });

  it("n>1 连续重传:只有存在于 backlog 的才发", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.seq = 0;
    p.sendChunk(pcmChunk()); // 1
    p.sendChunk(pcmChunk()); // 2
    p.sendChunk(pcmChunk()); // 3
    ctrl.sent.length = 0;
    anyP.onLoss(2, 3, 7001); // 要 2,3,4 —— 4 不存在
    expect(ctrl.sent.length).toBe(2);
  });

  it("controlPort 为 0 → 不发,但仍计入 lossRequests(可观测)", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.seq = 0;
    p.sendChunk(pcmChunk());
    ctrl.sent.length = 0;
    anyP.stats = { chunks: 1, maxGapMs: 0, reanchors: 0, lastSendMs: 0, startMs: Date.now() };
    anyP.onLoss(1, 1, 0);
    expect(ctrl.sent.length).toBe(0);
    expect(p.realtimeStats?.lossRequests).toBe(1);
  });

  it("每次丢包请求都累加 lossRequests", () => {
    const { p, anyP } = makePlayer();
    anyP.stats = { chunks: 0, maxGapMs: 0, reanchors: 0, lastSendMs: 0, startMs: Date.now() };
    anyP.onLoss(1, 1, 7001);
    anyP.onLoss(2, 1, 7001);
    expect(p.realtimeStats?.lossRequests).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. sync 包
// ---------------------------------------------------------------------------
describe("sendSync:周期性同步包(接收端靠它算延迟)", () => {
  it("首包 first=true → 首字节 0x90;后续 → 0x80", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.sendSync(true);
    expect(ctrl.sent[0].buf[0]).toBe(0x90);
    anyP.sendSync(false);
    expect(ctrl.sent[1].buf[0]).toBe(0x80);
  });

  it("包长 20,类型 0xD4,末字段 7(对齐 libraop rtp_sync_pkt_t)", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.sendSync(false);
    const s = ctrl.sent[0].buf;
    expect(s.length).toBe(20);
    expect(s[1]).toBe(0xd4); // 0x54 | 0x80
    expect(s[3]).toBe(7);
  });

  it("rtptime 字段 = headTs - latencyFrames(告诉设备缓冲多深)", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.headTs = 441000;
    anyP.latencyFrames = 44100;
    anyP.sendSync(false);
    expect(ctrl.sent[0].buf.readUInt32BE(4)).toBe((441000 - 44100) >>> 0);
  });

  it("延迟被设备 Audio-Latency 抬高后,sync 的 rtptime 相应变小", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.headTs = 441000;
    anyP.latencyFrames = 44100;
    anyP.sendSync(false);
    const shallow = ctrl.sent[0].buf.readUInt32BE(4);
    anyP.latencyFrames = 88200; // 2s
    anyP.sendSync(false);
    expect(ctrl.sent[1].buf.readUInt32BE(4)).toBeLessThan(shallow);
  });

  it("末 4 字节回写当前 headTs", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.headTs = 123456;
    anyP.sendSync(false);
    expect(ctrl.sent[0].buf.readUInt32BE(16)).toBe(123456);
  });

  it("还没发出首个音频包(started=false)→ 不发 sync", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.started = false;
    anyP.sendSync(true);
    expect(ctrl.sent.length).toBe(0);
  });

  it("正在销毁(destroying)→ 不发 sync", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.destroying = true;
    anyP.sendSync(false);
    expect(ctrl.sent.length).toBe(0);
  });

  it("sync 发往 SETUP 的 control_port", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.sendSync(false);
    expect(ctrl.sent[0].port).toBe(7001);
    expect(ctrl.sent[0].addr).toBe(HOST);
  });
});

// ---------------------------------------------------------------------------
// 7. startUdpListeners:设备来包的处理
// ---------------------------------------------------------------------------
describe("startUdpListeners:设备侧的丢包请求与 NTP 对时", () => {
  it("丢包请求(msg[1]&0x7f === 0x55)→ 触发重传", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.seq = 0;
    p.sendChunk(pcmChunk()); // seq=1
    ctrl.sent.length = 0;
    anyP.startUdpListeners(7001, 7002);
    const req = Buffer.alloc(8);
    req[0] = 0x80;
    req[1] = 0x55 | 0x80; // 0xD5
    req.writeUInt16BE(1, 4); // seqno
    req.writeUInt16BE(1, 6); // n
    ctrl.emit("message", req, { port: 7001, address: HOST });
    expect(ctrl.sent.length).toBe(1);
    expect(ctrl.sent[0].buf[1]).toBe(0xd6);
  });

  it("非丢包类控制包(0x54 sync)→ 不触发重传", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.seq = 0;
    p.sendChunk(pcmChunk());
    ctrl.sent.length = 0;
    anyP.startUdpListeners(7001, 7002);
    const req = Buffer.alloc(8);
    req[1] = 0x54;
    ctrl.emit("message", req, { port: 7001, address: HOST });
    expect(ctrl.sent.length).toBe(0);
  });

  it("短于 8 字节的包被忽略(不解析,防越界读)", () => {
    const { p, anyP, ctrl } = makePlayer();
    anyP.seq = 0;
    p.sendChunk(pcmChunk());
    ctrl.sent.length = 0;
    anyP.startUdpListeners(7001, 7002);
    const short = Buffer.alloc(6);
    short[1] = 0x55 | 0x80;
    ctrl.emit("message", short, { port: 7001, address: HOST });
    expect(ctrl.sent.length).toBe(0);
  });

  it("NTP 对时请求 → 回 32 字节 D3 包", () => {
    const { p, anyP, time } = makePlayer();
    anyP.startUdpListeners(7001, 7002);
    const req = Buffer.alloc(32);
    req[0] = 0x80;
    req[1] = 0x52 | 0x80;
    req[2] = 0x00;
    req[3] = 0x07;
    time.emit("message", req, { port: 5555, address: HOST });
    expect(time.sent.length).toBe(1);
    const r = time.sent[0].buf;
    expect(r.length).toBe(32);
    expect(r[1]).toBe(0xd3); // 0x53 | 0x80
  });

  it("对时回包回显请求末尾 8 字节(ref_time),设备据此算往返", () => {
    const { p, anyP, time } = makePlayer();
    anyP.startUdpListeners(7001, 7002);
    const req = Buffer.alloc(32);
    for (let i = 24; i < 32; i++) req[i] = 0xa0 + (i - 24);
    time.emit("message", req, { port: 5555, address: HOST });
    const r = time.sent[0].buf;
    expect(r.subarray(8, 16).equals(req.subarray(24, 32))).toBe(true);
  });

  it("对时回包的 recv_time 与 send_time 同为当前 NTP(两字段相等)", () => {
    const { p, anyP, time } = makePlayer();
    anyP.startUdpListeners(7001, 7002);
    time.emit("message", Buffer.alloc(32), { port: 5555, address: HOST });
    const r = time.sent[0].buf;
    expect(r.subarray(16, 24).equals(r.subarray(24, 32))).toBe(true);
  });

  it("对时回包包头回显请求的首尾字节", () => {
    const { p, anyP, time } = makePlayer();
    anyP.startUdpListeners(7001, 7002);
    const req = Buffer.alloc(32);
    req[0] = 0x80;
    req[2] = 0x12;
    req[3] = 0x34;
    time.emit("message", req, { port: 5555, address: HOST });
    const r = time.sent[0].buf;
    expect(r[0]).toBe(0x80);
    expect(r[2]).toBe(0x12);
    expect(r[3]).toBe(0x34);
  });

  it("对时回包发回来包源地址(设备可能是另一个端口)", () => {
    const { p, anyP, time } = makePlayer();
    anyP.startUdpListeners(7001, 7002);
    time.emit("message", Buffer.alloc(32), { port: 5555, address: HOST });
    expect(time.sent[0].port).toBe(5555);
    expect(time.sent[0].addr).toBe(HOST);
  });
});

// ---------------------------------------------------------------------------
// 8. prepareSeek:不拆会话的原地 seek
// ---------------------------------------------------------------------------
describe("prepareSeek:不拆 RTSP 会话的原地重锚", () => {
  it("startTs 按目标秒重锚并对齐 chunk(position 才是内容位置)", async () => {
    const { p, anyP } = makePlayer();
    anyP.baseTs = 1000;
    // 10s = 441000 帧,441000 % 352 = 296 → 向下对齐到 440704
    await p.prepareSeek(10);
    const aligned = Math.round(10 * SAMPLE_RATE);
    const expectTs = (1000 + (aligned - (aligned % CHUNK_LEN))) >>> 0;
    expect(anyP.startTs).toBe(expectTs);
  });

  it("positionSec 立刻反映目标秒(不等下一个包)", async () => {
    const { p } = makePlayer();
    await p.prepareSeek(42.5);
    expect(p.positionSec).toBe(42.5);
  });

  it("重置首包 marker、清空重传 backlog、换新 seq", async () => {
    const { p, anyP } = makePlayer();
    anyP.seq = 0;
    p.sendChunk(pcmChunk());
    expect(anyP.audioBacklog.size).toBe(1);
    await p.prepareSeek(5);
    expect(anyP.started).toBe(false);
    expect(anyP.audioBacklog.size).toBe(0);
  });

  it("停掉旧的 sync 定时器(否则旧时间线继续打点)", async () => {
    const { p, anyP } = makePlayer();
    const timer = setInterval(() => undefined, 1000);
    anyP.syncTimer = timer;
    cleanup.push(() => clearInterval(timer)); // 兜底:万一被测代码没清,别把进程挂住
    await p.prepareSeek(1);
    expect(anyP.syncTimer).toBeNull();
  });

  it("FLUSH 被设备拒绝(非 2xx)→ 不抛,仍完成重锚(靠首包 marker 兜底)", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp().reply("RTSP/1.0 400 Bad Request\r\nCSeq: 1\r\n\r\n");
    anyP.socket = tcp;
    await expect(p.prepareSeek(8)).resolves.toBeUndefined();
    expect(anyP.started).toBe(false);
    expect(tcp.written[0]).toContain("FLUSH");
  });

  it("FLUSH 请求带上新的 RTP-Info(seq + rtptime),设备据此换锚", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp().reply("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n");
    anyP.socket = tcp;
    await p.prepareSeek(3);
    const req = tcp.written[0];
    expect(req).toContain("FLUSH");
    expect(req).toContain("RTP-Info:");
    expect(req).toContain(`rtptime=${anyP.startTs}`);
  });

  it("socket 已销毁 → 跳过 FLUSH,不报错", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp();
    tcp.destroy();
    anyP.socket = tcp;
    await expect(p.prepareSeek(2)).resolves.toBeUndefined();
    expect(tcp.written.length).toBe(0);
  });

  it("seek 会中止旧时间线的推流(streaming=false)", async () => {
    const { p, anyP } = makePlayer();
    anyP.streaming = true;
    await p.prepareSeek(1);
    expect(anyP.streaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. 状态机 pause / flush / stop
// ---------------------------------------------------------------------------
describe("播放状态机:pause / resume / flush / stop", () => {
  it("pause → isPaused 为真;resume → 复位", () => {
    const { p } = makePlayer();
    expect(p.isPaused).toBe(false);
    p.pause();
    expect(p.isPaused).toBe(true);
    p.resume();
    expect(p.isPaused).toBe(false);
  });

  it("pause 期间 sync 循环不再打点(由 stream 循环判断,此处验证标志位)", () => {
    const { p } = makePlayer();
    p.pause();
    expect(p.isPaused).toBe(true);
  });

  it("flush:清首包 marker 与 streaming,停 sync 定时器", async () => {
    const { p, anyP } = makePlayer();
    anyP.started = true;
    anyP.streaming = true;
    const timer = setInterval(() => undefined, 1000);
    anyP.syncTimer = timer;
    cleanup.push(() => clearInterval(timer)); // 兜底
    await p.flush();
    expect(anyP.started).toBe(false);
    expect(anyP.streaming).toBe(false);
    expect(anyP.syncTimer).toBeNull();
  });

  it("stop:置销毁标志并停止推流(发完最后状态即收)", async () => {
    const { p, anyP } = makePlayer();
    anyP.streaming = true;
    anyP.paused = true;
    await p.stop();
    expect(anyP.destroying).toBe(true);
    expect(anyP.streaming).toBe(false);
    expect(anyP.paused).toBe(false);
  });

  it("stop:发 TEARDOWN 并销毁 RTSP socket", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp().reply("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n");
    anyP.socket = tcp;
    await p.stop();
    expect(tcp.written.some((w) => w.includes("TEARDOWN"))).toBe(true);
    expect(tcp.destroyed).toBe(true);
  });

  it("stop:TEARDOWN 被拒(设备已掉线)→ 被吞掉,stop 仍正常返回", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp().reply("RTSP/1.0 454 Session Not Found\r\nCSeq: 1\r\n\r\n");
    anyP.socket = tcp;
    await expect(p.stop()).resolves.toBeUndefined();
    expect(anyP.destroying).toBe(true);
  });

  it("stop:三个 UDP socket 全部关闭(不留 fd)", async () => {
    const { p, audio, ctrl, time } = makePlayer();
    await p.stop();
    expect(audio.closed).toBe(true);
    expect(ctrl.closed).toBe(true);
    expect(time.closed).toBe(true);
  });

  it("destroying 之后 sendChunk 一律失败(不再往已关的 socket 写)", async () => {
    const { p, anyP } = makePlayer();
    await p.stop();
    expect(p.sendChunk(pcmChunk())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. realtimeStats 可观测指标
// ---------------------------------------------------------------------------
describe("realtimeStats:推流健康度快照", () => {
  it("没有进行中的流 → null(调用方据此判断「未推流」)", () => {
    const { p } = makePlayer();
    expect(p.realtimeStats).toBeNull();
  });

  it("有流时快照字段与内部统计一致", () => {
    const { p, anyP } = makePlayer();
    const startMs = Date.now() - 2000;
    anyP.stats = { chunks: 125, maxGapMs: 33.5, reanchors: 4, lastSendMs: 0, startMs };
    const s = p.realtimeStats!;
    expect(s.chunks).toBe(125);
    expect(s.maxGapMs).toBe(33.5);
    expect(s.reanchors).toBe(4);
    expect(s.lossRequests).toBe(0);
    expect(s.elapsedMs).toBeGreaterThanOrEqual(2000);
  });

  it("elapsedMs 永不为负(时钟回拨也不产生负时长)", () => {
    const { p, anyP } = makePlayer();
    anyP.stats = { chunks: 0, maxGapMs: 0, reanchors: 0, lastSendMs: 0, startMs: Date.now() + 5000 };
    expect(p.realtimeStats!.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 11. SDP
// ---------------------------------------------------------------------------
describe("sdp():ANNOUNCE 的会话描述", () => {
  it("fmtp 行带 chunk/sampleSize/channels/sampleRate(改错设备直接拒流)", () => {
    const { p, anyP } = makePlayer();
    anyP.localIp = "192.168.1.9";
    const sdp = (p as any).sdp() as string;
    expect(sdp).toContain(`a=fmtp:96 ${CHUNK_LEN} 0 ${SAMPLE_SIZE} 40 10 14 ${CHANNELS} 255 0 0 ${SAMPLE_RATE}`);
  });

  it("明文会话不带 rsaaeskey / aesiv", () => {
    const { p, anyP } = makePlayer();
    anyP.localIp = "192.168.1.9";
    const sdp = (p as any).sdp() as string;
    expect(sdp).not.toContain("a=rsaaeskey");
    expect(sdp).not.toContain("a=aesiv");
  });

  it("加密会话带 rsaaeskey(设备公钥加密的 AES key)与 aesiv", () => {
    const { p, anyP } = makePlayer({ et: "1" });
    anyP.localIp = "192.168.1.9";
    const sdp = (p as any).sdp() as string;
    expect(sdp).toContain("a=rsaaeskey:");
    expect(sdp).toContain("a=aesiv:");
  });

  it("o= 行带 session id 与本机 IP;编码声明 AppleLossless", () => {
    const { p, anyP } = makePlayer();
    anyP.localIp = "192.168.1.9";
    const sdp = (p as any).sdp() as string;
    expect(sdp).toContain(`o=iTunes ${anyP.sid} 0 IN IP4 192.168.1.9`);
    expect(sdp).toContain("a=rtpmap:96 AppleLossless");
  });
});

// ---------------------------------------------------------------------------
// 12. sendRtsp:请求构造与响应解析
// ---------------------------------------------------------------------------
describe("sendRtsp:RTSP 请求构造与响应解析", () => {
  it("请求行带方法与 URL,头部带 CSeq / User-Agent / Client-Instance", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp().reply("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n");
    anyP.socket = tcp;
    await (p as any).sendRtsp("OPTIONS", null, null);
    const req = tcp.written[0];
    expect(req).toContain(`OPTIONS ${anyP.url}`);
    expect(req).toContain("CSeq: 1");
    expect(req).toContain("User-Agent: iTunes/7.6.2");
    expect(req).toContain("Client-Instance:");
  });

  it("CSeq 每次请求递增(设备靠它配对响应)", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp()
      .reply("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n")
      .reply("RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n");
    anyP.socket = tcp;
    await (p as any).sendRtsp("OPTIONS", null, null);
    await (p as any).sendRtsp("OPTIONS", null, null);
    expect(tcp.written[0]).toContain("CSeq: 1");
    expect(tcp.written[1]).toContain("CSeq: 2");
  });

  it("已建立会话后带 Session 头", async () => {
    const { p, anyP } = makePlayer();
    anyP.session = "ABCDEF";
    const tcp = newTcp().reply("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n");
    anyP.socket = tcp;
    await (p as any).sendRtsp("SET_PARAMETER", null, null);
    expect(tcp.written[0]).toContain("Session: ABCDEF");
  });

  it("extra 头被带上(SETUP 的 Transport 等)", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp().reply("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n");
    anyP.socket = tcp;
    await (p as any).sendRtsp("SETUP", null, null, [["Transport", "RTP/AVP/UDP;unicast;mode=record"]]);
    expect(tcp.written[0]).toContain("Transport: RTP/AVP/UDP;unicast;mode=record");
  });

  it("带 body 时写 Content-Type 与正确的 Content-Length", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp().reply("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n");
    anyP.socket = tcp;
    const body = "v=0\r\n";
    await (p as any).sendRtsp("ANNOUNCE", body, "application/sdp");
    const req = tcp.written[0];
    expect(req).toContain("Content-Type: application/sdp");
    expect(req).toContain(`Content-Length: ${Buffer.byteLength(body)}`);
  });

  it("2xx 响应 → 解析出 status、小写 headers 与 body", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp().reply(
      "RTSP/1.0 200 OK\r\nCSeq: 1\r\nSession: DEADBEEF\r\nAudio-Latency: 44100\r\n\r\n",
    );
    anyP.socket = tcp;
    const res = await (p as any).sendRtsp("RECORD", null, null);
    expect(res.status).toBe(200);
    expect(res.headers["session"]).toBe("DEADBEEF");
    expect(res.headers["audio-latency"]).toBe("44100");
  });

  it("响应头大小写不敏感(统一转小写,防设备大小写差异)", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp().reply("RTSP/1.0 200 OK\r\nContent-Type: TEXT/parameters\r\n\r\n");
    anyP.socket = tcp;
    const res = await (p as any).sendRtsp("GET_PARAMETER", null, null);
    expect(res.headers["content-type"]).toBe("TEXT/parameters");
  });

  it("body 按 Content-Length 分片到达 → 拼齐后才 resolve", async () => {
    const { p, anyP } = makePlayer();
    const body = "0123456789";
    const tcp = newTcp().reply(
      `RTSP/1.0 200 OK\r\nContent-Length: ${body.length}\r\n\r\n01234`,
      "56789",
    );
    anyP.socket = tcp;
    const res = await (p as any).sendRtsp("GET_PARAMETER", null, null);
    expect(res.body).toBe(body);
  });

  it("非 2xx → reject(并把响应首行带进错误信息)", async () => {
    const { p, anyP } = makePlayer();
    const tcp = newTcp().reply("RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n");
    anyP.socket = tcp;
    await expect((p as any).sendRtsp("ANNOUNCE", null, null)).rejects.toThrow(/401|Unauthorized/);
  });

  it("socket 已关闭 → 立即 reject,不发网络请求", async () => {
    const { p, anyP } = makePlayer();
    anyP.socket = null;
    await expect((p as any).sendRtsp("TEARDOWN", null, null)).rejects.toThrow(/closed/);
  });
});
