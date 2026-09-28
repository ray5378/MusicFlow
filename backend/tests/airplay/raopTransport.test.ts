// RAOP 传输层「会话建立与推流节拍」契约测试。
//
// 为什么单独测:既有 `raopPlayer.test.ts` 只覆盖了「已进入 RECORD 之后」的协议方法
// (sendChunk / onLoss / sendSync / SDP / sendRtsp 响应解析)。而 `connect()` 这一整段
// —— UDP 端口分配、RTSP ANNOUNCE→SETUP→RECORD 握手、Transport 头解析、Audio-Latency
// 回写、sync 循环启动、以及 `stream()` 的墙钟节拍门 —— 全是零覆盖。这些字段写错的表现
// 是「设备能连上但完全无声 / 延迟补偿错 / 进度条与实际声音不同步」,真机极难归因。
//
// 手法:把 `net` 与 `dgram` 换成内存假体(vi.mock),让 connect() 完整跑一遍并逐字节断言
// 发出的 RTSP 请求与解析出的会话字段;`stream()` 用可控 producer + 墙钟节拍真实驱动。
//
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";

// 假体注册表:vi.mock 工厂被提升,故共享句柄必须先经 vi.hoisted 建立。
const H = vi.hoisted(() => ({
  dgramSockets: [] as any[],
  tcpSockets: [] as any[],
  tcpReplies: [] as string[][],
}));

/** 假 UDP socket:记录 reuseAddr 选项与每次 send,可 emit("message"/"error")。 */
class FakeUdp extends EventEmitter {
  sent: Array<{ buf: Buffer; port: number; addr: string }> = [];
  closed = false;
  constructor(public opts: { reuseAddr?: boolean }) {
    super();
    H.dgramSockets.push(this);
  }
  bind(_port: number, cb?: () => void): this {
    // dgram 的 bind 是异步回调;这里用 setImmediate 保留异步语义。
    setImmediate(() => cb?.());
    return this;
  }
  address() {
    return { address: "192.168.1.9", port: this.opts.reuseAddr ? 6001 : 6000, family: "IPv4" };
  }
  send(buf: Buffer, ...rest: any[]): void {
    const payload = typeof rest[0] === "number" && typeof rest[1] === "number"
      ? Buffer.from(buf.subarray(rest[0], rest[0] + rest[1]))
      : Buffer.from(buf);
    const port = typeof rest[0] === "number" && typeof rest[1] === "number" ? rest[2] : rest[0];
    const addr = typeof rest[0] === "number" && typeof rest[1] === "number" ? rest[3] : rest[1];
    this.sent.push({ buf: payload, port, addr });
  }
  close(): void {
    this.closed = true;
  }
  get last(): Buffer {
    return this.sent[this.sent.length - 1].buf;
  }
}

/** 假 RTSP(TCP)socket:write 记录请求,并从共享回复队列取一条「分片」异步 emit。 */
class FakeTcp extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  constructor() {
    super();
    H.tcpSockets.push(this);
  }
  write(buf: Buffer): boolean {
    this.written.push(buf.toString("latin1"));
    const chunks = H.tcpReplies.shift();
    if (chunks) setImmediate(() => { for (const c of chunks) this.emit("data", Buffer.from(c, "latin1")); });
    return true;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

vi.mock("dgram", () => ({
  createSocket: (opts: { reuseAddr?: boolean }) => new FakeUdp(opts),
}));

vi.mock("net", () => ({
  createConnection: (_opts: any, onConnect: () => void) => {
    const s = new FakeTcp();
    setImmediate(() => onConnect());
    return s;
  },
}));

import {
  RaopPlayer,
  SAMPLE_RATE,
  CHUNK_LEN,
  type RaopSession,
} from "../../src/services/airplay/raop.js";

const HOST = "192.168.1.50";

/** 标准 RTSP 200 回复;可附加头部与 body。 */
function rtsp(headers: Record<string, string> = {}, body = ""): string {
  const hs = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  const cl = body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : "";
  return `RTSP/1.0 200 OK\r\n${hs}${cl}\r\n${body}`;
}

/** 预排 ANNOUNCE / SETUP / RECORD 三段回复(按 write 顺序消费)。 */
function queueHandshake(opts: { announceSession?: string; transport?: string; audioLatency?: string } = {}) {
  H.tcpReplies.push([rtsp({ Session: opts.announceSession ?? "SESS-1" })]);
  H.tcpReplies.push([
    rtsp({
      Transport:
        opts.transport ??
        "RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;server_port=7000;control_port=7001;timing_port=7002",
    }),
  ]);
  H.tcpReplies.push([rtsp(opts.audioLatency ? { "Audio-Latency": opts.audioLatency } : {})]);
}

beforeEach(() => {
  H.dgramSockets.length = 0;
  H.tcpSockets.length = 0;
  H.tcpReplies.length = 0;
});

afterEach(() => {
  // 清掉残留的 RTSP 超时定时器(源码靠 socket close 清,这里手动关)。
  for (const t of H.tcpSockets) if (!t.destroyed) t.destroy();
  for (const s of H.dgramSockets) s.removeAllListeners();
  vi.useRealTimers();
});

async function connected(opts: Record<string, unknown> = {}) {
  queueHandshake();
  const p = new RaopPlayer({ host: HOST, ...opts } as any);
  const session = await p.connect();
  return { p, session, anyP: p as any };
}

// ---------------------------------------------------------------------------
// 1. connect():UDP 分配 + RTSP 握手 + Transport/Audio-Latency 解析
// ---------------------------------------------------------------------------
describe("connect():RAOP 会话建立", () => {
  it("绑定 3 个 UDP 端口:timing/control 允许地址复用,audio 独占(避免抢端口)", async () => {
    await connected();
    expect(H.dgramSockets.length).toBe(3);
    // 前两个是 timing/control(reuseAddr=true),第三个是 audio(reuseAddr=false)。
    // audio 不能复用:它承载唯一一路 RTP 收包,被别的实例共用会串流。
    expect(H.dgramSockets.map((s) => s.opts.reuseAddr)).toEqual([true, true, false]);
  });

  it("localIp 取自 audio socket(ANNOUNCE 的 o= 行要写本机可达地址)", async () => {
    const { anyP } = await connected();
    expect(anyP.localIp).toBe("192.168.1.9");
  });

  it("握手顺序 ANNOUNCE → SETUP → RECORD,且默认 RTSP 端口 5000", async () => {
    const { p, anyP } = await connected();
    const tcp = H.tcpSockets[0];
    expect(tcp.written.length).toBe(3);
    expect(tcp.written[0]).toContain("ANNOUNCE ");
    expect(tcp.written[0]).toContain("Content-Type: application/sdp");
    expect(tcp.written[1]).toContain("SETUP ");
    expect(tcp.written[2]).toContain("RECORD ");
    expect(anyP.opts.port).toBe(5000);
    expect(p.encrypted).toBe(false);
  });

  it("SETUP 的 Transport 头回带本端 control/timing 端口(设备据此回包)", async () => {
    const { anyP } = await connected();
    const setup = H.tcpSockets[0].written[1];
    expect(setup).toContain("Transport: RTP/AVP/UDP;unicast");
    expect(setup).toContain("mode=record");
    // control/timing 端口来自本地 socket.address().port(复用 socket 均为 6001)
    expect(setup).toContain("control_port=6001");
    expect(setup).toContain("timing_port=6001");
  });

  it("RECORD 带 Range 与 RTP-Info(seq/rtptime 必须非空,否则设备不认起始锚点)", async () => {
    const { anyP } = await connected();
    const record = H.tcpSockets[0].written[2];
    expect(record).toContain("Range: npt=0-");
    expect(record).toMatch(/RTP-Info: seq=\d+;rtptime=\d+/);
  });

  it("解析 SETUP 的 server_port/control_port/timing_port 作为回包目标", async () => {
    const { session } = await connected();
    expect(session).toEqual({ session: "SESS-1", audioPort: 7000, controlPort: 7001, timingPort: 7002 });
  });

  it("ANNOUNCE 与 SETUP 都带 Session 时,SETUP 的回值覆盖 ANNOUNCE(以后者为准)", async () => {
    H.tcpReplies.push([rtsp({ Session: "FROM-ANNOUNCE" })]);
    H.tcpReplies.push([
      rtsp({
        Session: "FROM-SETUP",
        Transport: "RTP/AVP/UDP;unicast;mode=record;server_port=7000;control_port=7001;timing_port=7002",
      }),
    ]);
    H.tcpReplies.push([rtsp()]);
    const p = new RaopPlayer({ host: HOST });
    const s = await p.connect();
    expect(s.session).toBe("FROM-SETUP");
  });

  it("SETUP 缺 server_port → 抛错(audioPort 为 0 时无法发包,必须硬失败)", async () => {
    H.tcpReplies.push([rtsp()]);
    H.tcpReplies.push([rtsp({ Transport: "RTP/AVP/UDP;unicast;mode=record;control_port=7001" })]);
    const p = new RaopPlayer({ host: HOST });
    await expect(p.connect()).rejects.toThrow(/server_port/);
  });

  it("RECORD 的 Audio-Latency 抬高同步延迟(设备要求更深缓冲时不得压回)", async () => {
    queueHandshake({ audioLatency: "88200" });
    const p = new RaopPlayer({ host: HOST });
    await p.connect();
    expect((p as any).latencyFrames).toBe(88200);
  });

  it("Audio-Latency 小于 1s 帧数 → 仍保底 1s(cliraop 默认;过浅会周期性断音)", async () => {
    queueHandshake({ audioLatency: "100" });
    const p = new RaopPlayer({ host: HOST });
    await p.connect();
    expect((p as any).latencyFrames).toBe(SAMPLE_RATE);
  });

  it("无 Audio-Latency 头 → 保持默认 1s(不因缺失把延迟打成 0)", async () => {
    await connected();
    const p2 = new RaopPlayer({ host: HOST });
    H.tcpReplies.push([rtsp()]);
    H.tcpReplies.push([rtsp({ Transport: "RTP/AVP/UDP;unicast;mode=record;server_port=7000;control_port=7001;timing_port=7002" })]);
    H.tcpReplies.push([rtsp()]);
    await p2.connect();
    expect((p2 as any).latencyFrames).toBe(SAMPLE_RATE);
  });

  it("加密会话(et 含 1):ANNOUNCE 的 SDP 带 rsaaeskey/aesiv", async () => {
    await connected({ et: "1" });
    const announce = H.tcpSockets[0].written[0];
    expect(announce).toContain("a=rsaaeskey:");
    expect(announce).toContain("a=aesiv:");
  });
});

// ---------------------------------------------------------------------------
// 2. sendRtsp 超时
// ---------------------------------------------------------------------------
describe("sendRtsp:设备沉默时必须超时失败(不永久挂住调用方)", () => {
  it("10s 内无回复 → reject 并带 timeout 提示", async () => {
    const { p, anyP } = await connected();
    vi.useFakeTimers();
    // 断言处理器必须在推进时钟**之前**挂上:否则 reject 先发生、后挂 handler,
    // vitest 会把这次拒绝记为 unhandled rejection(污染整个套件)。
    const assertion = expect((p as any).sendRtsp("OPTIONS", null, null)).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
    expect(anyP.socket).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3. sendRtspNoWait / setVolumeDb
// ---------------------------------------------------------------------------
describe("setVolumeDb / sendRtspNoWait:音量必须非阻塞(接收端常不回复)", () => {
  it("有 socket → 写出 SET_PARAMETER volume,但不等待回复", async () => {
    const { p, anyP } = await connected();
    const tcp = H.tcpSockets[0];
    const before = tcp.written.length;
    p.setVolumeDb(-12);
    expect(tcp.written.length).toBe(before + 1);
    const req = tcp.written[before];
    expect(req).toContain("SET_PARAMETER ");
    expect(req).toContain("volume: -12.00");
    expect(req).toContain("Content-Type: text/parameters");
    expect(anyP.socket).toBeTruthy();
  });

  it("无 socket / 已销毁 → 静默丢弃,不抛错(会话已收尾时的音量残留调用)", async () => {
    const { p, anyP } = await connected();
    anyP.socket = null;
    expect(() => p.setVolumeDb(-5)).not.toThrow();
    anyP.socket = { destroyed: true, write: () => { throw new Error("should not write"); } };
    expect(() => p.setVolumeDb(-5)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. startUdpListeners:audio socket 出错 → 停止推流
// ---------------------------------------------------------------------------
describe("startUdpListeners:audio socket 故障必须停机", () => {
  it("audioSocket error → streaming=false(否则循环继续往死 socket 发包)", async () => {
    const { p, anyP } = await connected();
    anyP.streaming = true;
    const audio = H.dgramSockets[2];
    audio.emit("error", new Error("EADDRNOTAVAIL"));
    expect(anyP.streaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. syncLoop:单例间隔,重复调用不得叠加
// ---------------------------------------------------------------------------
describe("syncLoop:同步打点定时器单例", () => {
  it("首次创建定时器,重复调用不重建(避免多份 1s 打点)", async () => {
    const { p, anyP } = await connected();
    anyP.syncLoop();
    const first = anyP.syncTimer;
    expect(first).toBeTruthy();
    anyP.syncLoop();
    expect(anyP.syncTimer).toBe(first);
    clearInterval(anyP.syncTimer);
    anyP.syncTimer = null;
  });

  it("推流中每秒打一次 sync;暂停时不打(设备据此算缓冲深度)", async () => {
    const { p, anyP } = await connected();
    anyP.started = true;
    anyP.streaming = true;
    anyP.serverControlPort = 7001;
    const ctrl = H.dgramSockets[1];
    vi.useFakeTimers();
    anyP.syncLoop();
    await vi.advanceTimersByTimeAsync(1000);
    const afterRunning = ctrl.sent.filter((s) => s.buf[1] === 0xd4).length;
    expect(afterRunning).toBeGreaterThanOrEqual(1);
    // 暂停 → 下一拍不得再发(否则设备把"冻结"的位置当成仍在推进)
    p.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctrl.sent.filter((s) => s.buf[1] === 0xd4).length).toBe(afterRunning);
    clearInterval(anyP.syncTimer);
    anyP.syncTimer = null;
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 6. stream():墙钟节拍与推流循环
// ---------------------------------------------------------------------------
describe("stream():实时节拍推流", () => {
  /** 造一帧标准 PCM。 */
  const pcm = () => Buffer.alloc(CHUNK_LEN * 4);

  /** 造一个已就绪的 stream 目标会话。 */
  function streamSession(anyP: any): RaopSession {
    anyP.serverAudioPort = 7000;
    anyP.serverControlPort = 7001;
    return { session: "S", audioPort: 7000, controlPort: 7001, timingPort: 7002 };
  }

  async function readyPlayer() {
    const { p, anyP } = await connected();
    anyP.audioBacklog.clear();
    anyP.started = false;
    return { p, anyP };
  }

  it("producer 立刻返回 null → 正常收尾,streaming 复位,统计写入", async () => {
    const { p, anyP } = await readyPlayer();
    const sess = streamSession(anyP);
    await p.stream(async () => null, sess);
    expect(anyP.streaming).toBe(false);
    expect(p.realtimeStats).not.toBeNull();
    expect(p.realtimeStats!.chunks).toBe(0);
    clearInterval(anyP.syncTimer);
    anyP.syncTimer = null;
  });

  it("producer 出 2 帧后 null → 发 2 个 RTP 包、首包带 marker、首帧后发首个 sync", async () => {
    const { p, anyP } = await readyPlayer();
    const sess = streamSession(anyP);
    let n = 0;
    const audio = H.dgramSockets[2];
    const ctrl = H.dgramSockets[1];
    await p.stream(async () => (n++ < 2 ? pcm() : null), sess);
    clearInterval(anyP.syncTimer);
    anyP.syncTimer = null;
    const audioPkts = audio.sent.filter((s) => s.buf[1] === 0xe0 || s.buf[1] === 0x60);
    expect(audioPkts.length).toBe(2);
    expect(audioPkts[0].buf[1]).toBe(0xe0); // 首包 marker
    expect(audioPkts[1].buf[1]).toBe(0x60);
    // 首个 sync 只在第一帧发出后打一次,且是「首帧」语义(首字节 0x90)
    const syncs = ctrl.sent.filter((s) => s.buf[1] === 0xd4);
    expect(syncs.length).toBe(1);
    expect(syncs[0].buf[0]).toBe(0x90);
    expect(p.realtimeStats!.chunks).toBe(2);
  });

  it("pause 期间不推进 RTP 时钟(idx 冻结),resume 后继续", async () => {
    const { p, anyP } = await readyPlayer();
    const sess = streamSession(anyP);
    const audio = H.dgramSockets[2];
    let n = 0;
    await p.stream(async () => {
      n++;
      if (n === 1) {
        p.pause();
        setTimeout(() => p.resume(), 5);
        return pcm();
      }
      if (n === 2) return pcm();
      return null;
    }, sess);
    clearInterval(anyP.syncTimer);
    anyP.syncTimer = null;
    const audioPkts = audio.sent.filter((s) => s.buf[1] === 0xe0 || s.buf[1] === 0x60);
    // 暂停期间不发包;恢复后共 2 帧
    expect(audioPkts.length).toBe(2);
    // 第二包的 rtptime 必须紧跟第一包(CHUNK_LEN 递增),证明暂停未让时钟跳空
    const ts0 = audioPkts[0].buf.readUInt32BE(4);
    const ts1 = audioPkts[1].buf.readUInt32BE(4);
    expect(ts1).toBe((ts0 + CHUNK_LEN) >>> 0);
  });
});
