// ==================== AP2 会话编排（Phase 6b 批 4）验证 ====================
//
// - 速率协商：AP2_RATES 判定、设备回报优先、48k 直通 / 44.1k 重采样。
// - 会话状态机 + 假 accessory（加密 RTSP，SETUP/RECORD/TEARDOWN）+ UDP 收包断言。
// - 异常路径（lead 纪律要求：不留悬挂 socket/定时器）：
//     · SETUP 失败        → state='error' + 资源清理；
//     · RECORD 中途断链    → rtspClient 'close' → failLink → state='error'；
//     · UDP 出口不可达     → 连续错误达 AP2_SEND_ERROR_LIMIT → state='error'；
//     · TEARDOWN/close     → 幂等，任何状态可调；
//     · 排水通道断线        → destroy() 后不再重连（无悬挂定时器）。
//
// MUST be the first import: 在 backend 模块加载前把 DATA_DIR 指到隔离临时目录。
import "../plugins/_env.js";

import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { createSocket, type Socket as DgramSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import { Ap2RtspClient, HttpFramer } from "../../src/services/airplay/ap2/rtspClient.js";
import { HapChannel } from "../../src/services/airplay/ap2/hapSocket.js";
import { bplistDecode, bplistEncode, type PlistValue } from "../../src/services/airplay/ap2/bplist.js";
import {
  AP2_REALTIME_STREAM_TYPE,
  AP2_SEND_ERROR_LIMIT,
  Ap2StreamError,
  Ap2StreamSession,
  bridgePcmProvider,
  negotiateAp2Rate,
  type Ap2AudioSink,
} from "../../src/services/airplay/ap2/ap2Stream.js";
import { EventTimingChannels } from "../../src/services/airplay/ap2/timingClient.js";
import { AP2_RATES } from "../../src/services/airplay/rates.js";

const SHARED = Buffer.alloc(32, 0x77);

interface FakeAccessory {
  port: number;
  close: () => void;
  requests: string[];
  setStreamStatus: (s: number) => void;
  /** 强拆当前控制面连接（模拟 RECORD 中途断链）。 */
  dropConnection: () => void;
  dataPort: number;
  udp: DgramSocket;
  packets: Buffer[];
}

/** 假 accessory：加密 RTSP 上应答 SETUP(session)/RECORD/SETUP(stream)/TEARDOWN。 */
async function startFakeAccessory(): Promise<FakeAccessory> {
  const udp = createSocket("udp4");
  const packets: Buffer[] = [];
  udp.on("message", (m: Buffer) => packets.push(m));
  await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r));
  const dataPort = (udp.address() as AddressInfo).port;

  const requests: string[] = [];
  const sockets: Socket[] = [];
  let streamStatus = 200;
  const srv = createServer((sock: Socket) => {
    sockets.push(sock);
    sock.on("error", () => {
      /* 断链属预期 */
    });
    const chan = new HapChannel(sock, SHARED, "accessory");
    const framer = new HttpFramer();
    chan.on("error", () => {
      /* 断链属预期 */
    });
    chan.on("data", (plain: Buffer) => {
      framer.push(plain);
      for (;;) {
        const got = framer.extract();
        if (!got) break;
        const startLine = got.head.split("\r\n")[0]!;
        requests.push(startLine);
        const method = startLine.split(" ")[0]!;
        let body = Buffer.alloc(0);
        let status = 200;
        if (method === "SETUP") {
          const req = bplistDecode(got.body) as PlistValue;
          const isStream = typeof req === "object" && !Array.isArray(req) && "streams" in (req as object);
          if (isStream) {
            status = streamStatus;
            body = bplistEncode({ streams: [{ controlPort: 1, dataPort, streamID: 7, type: AP2_REALTIME_STREAM_TYPE }] });
          } else {
            body = bplistEncode({ eventPort: 0 });
          }
        }
        // 回显请求 CSeq（不再硬编码 1）：客户端按 CSeq 配对在途请求，
        // 假件固定回 1 会让 RECORD(cseq=2)/SETUP(stream,cseq=3) 永远配不上。
        const cseqLine = got.head.split("\r\n").find((l) => /^cseq:/i.test(l));
        const cseq = cseqLine ? cseqLine.slice(cseqLine.indexOf(":") + 1).trim() : "1";
        const head = `RTSP/1.0 ${status} ${status === 200 ? "OK" : "Err"}\r\nCSeq: ${cseq}\r\nContent-Length: ${body.length}\r\n\r\n`;
        chan.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    port: (srv.address() as AddressInfo).port,
    close: () => {
      for (const s of sockets) s.destroy();
      srv.close();
      udp.close();
    },
    requests,
    setStreamStatus: (s) => {
      streamStatus = s;
    },
    dropConnection: () => {
      for (const s of sockets) s.destroy();
      sockets.length = 0;
    },
    dataPort,
    udp,
    packets,
  };
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pcm(frames: number, seed = 1): Buffer {
  let s = seed >>> 0;
  const out = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const v = (s >>> 16) - 0x8000;
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

describe("negotiateAp2Rate（判据③ 速率协商）", () => {
  it("源 48k 无偏好 → AP2_RATES[0] 直通", () => {
    const d = negotiateAp2Rate({ sourceRate: 48000 });
    expect(d.rate).toBe(AP2_RATES[0]);
    expect(d.rate).toBe(48000);
    expect(d.resampled).toBe(false);
    expect(d.fromDevice).toBe(false);
  });

  it("源 48k 偏好 44.1k → 走 147/160 重采样", () => {
    const d = negotiateAp2Rate({ sourceRate: 48000, preferredRate: 44100 });
    expect(d.rate).toBe(44100);
    expect(d.resampled).toBe(true);
  });

  it("设备回报 44.1k 优先于请求值", () => {
    const d = negotiateAp2Rate({ sourceRate: 48000, preferredRate: 48000, deviceReportedRate: 44100 });
    expect(d.rate).toBe(44100);
    expect(d.fromDevice).toBe(true);
    expect(d.resampled).toBe(true);
  });

  it("非法偏好（不在 AP2_RATES）回落首项；非法设备回报忽略", () => {
    const d = negotiateAp2Rate({ sourceRate: 48000, preferredRate: 22050, deviceReportedRate: 96000 });
    expect(d.rate).toBe(48000);
    expect(d.fromDevice).toBe(false);
    expect(d.resampled).toBe(false);
  });

  it("源 44.1k 且协商 44.1k → 不重采样", () => {
    const d = negotiateAp2Rate({ sourceRate: 44100, preferredRate: 44100 });
    expect(d.resampled).toBe(false);
  });
});

describe("Ap2StreamSession（假 accessory 端到端）", () => {
  async function openSession(
    acc: FakeAccessory,
    opts: { sourceRate?: number; preferredRate?: number; sink?: Ap2AudioSink } = {},
  ) {
    const client = new Ap2RtspClient();
    await client.connect("127.0.0.1", acc.port);
    client.upgradeToEncrypted(SHARED);
    const session = new Ap2StreamSession({
      host: "127.0.0.1",
      port: acc.port,
      controllerId: "F00FBABE0003",
      sourceRate: opts.sourceRate ?? 48000,
      preferredRate: opts.preferredRate,
      client,
      sink: opts.sink,
    });
    return session;
  }

  it("open → pump → UDP 包结构与帧数 → close(TEARDOWN)", async () => {
    const acc = await startFakeAccessory();
    const session = await openSession(acc);
    try {
      const info = await session.open();
      expect(info.agreedRate).toBe(48000);
      expect(info.resampled).toBe(false);
      expect(info.streamId).toBe(7);
      expect(info.dataPort).toBe(acc.dataPort);

      // 1 帧（352 样本）+ 半帧（不足）→ 应只发 1 包，余量进 carry
      const frames = session.pump(pcm(352 + 100));
      expect(frames).toBe(1);
      await until(() => acc.packets.length >= 1);
      const pkt = acc.packets[0]!;
      expect(pkt[0]).toBe(0x80);
      expect(pkt.readUInt16BE(2)).toBe(0); // seq 0
      expect(pkt.length).toBe(12 + 1416 + 16 + 8);

      // 再补足 → 第二包（carry 生效）
      expect(session.pump(pcm(252))).toBe(1);
      await until(() => acc.packets.length >= 2);
      expect(acc.packets[1]!.readUInt16BE(2)).toBe(1);
      expect(acc.packets[1]!.readUInt32BE(4)).toBe(352); // ts += spf

      await session.close();
      expect(session.currentState).toBe("closed");
      expect(acc.requests.some((r) => r.startsWith("TEARDOWN"))).toBe(true);
      expect(acc.requests.filter((r) => r.startsWith("SETUP")).length).toBe(2);
    } finally {
      await session.close();
      acc.close();
    }
  });

  it("偏好 44.1k：重采样路径送达 UDP（包数与帧长正确）", async () => {
    const acc = await startFakeAccessory();
    const session = await openSession(acc, { sourceRate: 48000, preferredRate: 44100 });
    try {
      const info = await session.open();
      expect(info.agreedRate).toBe(44100);
      expect(info.resampled).toBe(true);
      const sent = session.pump(pcm(48000 / 10)); // 100ms @48k
      expect(sent).toBeGreaterThan(0);
      await until(() => acc.packets.length >= sent);
      // 44.1k 下 100ms ≈ 4410 输出帧 → 352/包 ≈ 12 包
      expect(sent).toBeGreaterThanOrEqual(11);
      expect(acc.packets[0]!.length).toBe(12 + 1416 + 16 + 8);
    } finally {
      await session.close();
      acc.close();
    }
  });

  it("SETUP(stream) 500 → open 拒绝、状态 error、资源清理", async () => {
    const acc = await startFakeAccessory();
    acc.setStreamStatus(500);
    const session = await openSession(acc);
    try {
      await expect(session.open()).rejects.toThrow();
      expect(session.currentState).toBe("error");
      expect(session.streamInfo).toBeNull();
    } finally {
      await session.close();
      acc.close();
    }
  });

  it("状态守卫：未 open 时 pump 抛 Ap2StreamError；close 幂等", async () => {
    const session = new Ap2StreamSession({ host: "127.0.0.1", port: 1, controllerId: "X" });
    expect(() => session.pump(Buffer.alloc(1408))).toThrow(Ap2StreamError);
    await session.close();
    await session.close();
    expect(session.currentState).toBe("closed");
  });
});

describe("异常路径（批 4 纪律：明确状态 + 无悬挂资源）", () => {
  it("RECORD 中途断链：控制面 close → failLink → state='error'，pump 立即拒绝", async () => {
    const acc = await startFakeAccessory();
    const client = new Ap2RtspClient();
    await client.connect("127.0.0.1", acc.port);
    client.upgradeToEncrypted(SHARED);
    const session = new Ap2StreamSession({
      host: "127.0.0.1", port: acc.port, controllerId: "F00FBABE0004", client, sourceRate: 48000,
    });
    try {
      await session.open();
      expect(session.pump(pcm(352))).toBe(1);

      acc.dropConnection(); // 对端强拆 → 我方 rtspClient 收到 close
      await until(() => session.currentState === "error");
      expect(session.stats.linkLoss).toBe("rtsp-close");
      expect(session.stats.sent).toBe(1);
      // 断链后推流立刻失败（不再往虚空发包）
      expect(() => session.pump(pcm(352))).toThrow(Ap2StreamError);
      // close 在 error 态仍幂等（不再尝试 TEARDOWN）
      await session.close();
      await session.close();
      expect(session.currentState).toBe("closed");
    } finally {
      await session.close();
      acc.close();
    }
  });

  it("UDP 出口不可达：连续错误达阈值 → state='error' + linkLoss=udp-unreachable", async () => {
    const acc = await startFakeAccessory();
    let destroyed = 0;
    const badSink: Ap2AudioSink = {
      connect: async () => undefined,
      send: () => {
        throw new Error("send ECONNREFUSED 127.0.0.1:9");
      },
      destroy: () => {
        destroyed++;
      },
    };
    const client = new Ap2RtspClient();
    await client.connect("127.0.0.1", acc.port);
    client.upgradeToEncrypted(SHARED);
    const session = new Ap2StreamSession({
      host: "127.0.0.1", port: acc.port, controllerId: "F00FBABE0005", client,
      sourceRate: 48000, sink: badSink,
    });
    try {
      await session.open();
      // 一次 pump 送 30 帧（> 阈值 20）→ 收敛
      session.pump(pcm(352 * (AP2_SEND_ERROR_LIMIT + 10)));
      expect(session.currentState).toBe("error");
      expect(session.stats.linkLoss).toBe("udp-unreachable");
      expect(session.stats.errors).toBeGreaterThanOrEqual(AP2_SEND_ERROR_LIMIT);
      expect(destroyed).toBeGreaterThanOrEqual(1); // 出口已释放
      expect(() => session.pump(pcm(352))).toThrow(Ap2StreamError);
    } finally {
      await session.close();
      acc.close();
    }
  });

  it("pumpRealtime 接点：按下发节奏拉取，供给返回 null 即收尾", async () => {
    const acc = await startFakeAccessory();
    const client = new Ap2RtspClient();
    await client.connect("127.0.0.1", acc.port);
    client.upgradeToEncrypted(SHARED);
    const session = new Ap2StreamSession({
      host: "127.0.0.1", port: acc.port, controllerId: "F00FBABE0006", client, sourceRate: 48000,
    });
    let pulls = 0;
    const provider = {
      pull: async (): Promise<Buffer | null> => {
        if (pulls++ >= 3) return null;
        return pcm(352, pulls);
      },
    };
    try {
      await session.open();
      const total = await session.pumpRealtime(provider);
      expect(pulls).toBe(4); // 3 次给料 + 1 次 null
      expect(total).toBe(3);
      await until(() => acc.packets.length >= 3);
      expect(acc.packets[2]!.readUInt16BE(2)).toBe(2);
    } finally {
      await session.close();
      acc.close();
    }
  });

  it("桥供给适配器：pullOutChunk 结构兼容（桥不感知 AP2）", async () => {
    const chunks = [pcm(352), pcm(352)];
    const fakeBridge = {
      pullOutChunk: async (): Promise<Buffer | null> => chunks.shift() ?? null,
    };
    const provider = bridgePcmProvider(fakeBridge);
    expect((await provider.pull())?.length).toBe(352 * 4);
    expect((await provider.pull())?.length).toBe(352 * 4);
    expect(await provider.pull()).toBeNull();
  });

  it("pumpRealtime 中途断链：链路收敛后立即退出拉取循环", async () => {
    const acc = await startFakeAccessory();
    const client = new Ap2RtspClient();
    await client.connect("127.0.0.1", acc.port);
    client.upgradeToEncrypted(SHARED);
    const session = new Ap2StreamSession({
      host: "127.0.0.1", port: acc.port, controllerId: "F00FBABE0007", client, sourceRate: 48000,
    });
    let pulls = 0;
    const provider = {
      pull: async (): Promise<Buffer | null> => {
        pulls++;
        if (pulls === 2) acc.dropConnection(); // 第 2 次给料时对端断链
        if (pulls > 50) return null; // 兜底，避免测试挂死
        return pcm(352, pulls);
      },
    };
    try {
      await session.open();
      const total = await session.pumpRealtime(provider);
      await until(() => session.currentState === "error");
      expect(total).toBeGreaterThanOrEqual(1);
      expect(pulls).toBeLessThan(50); // 断链后不再无限拉取
    } finally {
      await session.close();
      acc.close();
    }
  });

  it("destroy() 抢在 dial 完成前：在途 socket 一并销毁（connected 不回弹、不重连）", async () => {
    let conns = 0;
    const serverSockets: Socket[] = [];
    const srv: Server = createServer((s: Socket) => {
      conns++;
      serverSockets.push(s);
      s.on("error", () => {
        /* ignore */
      });
      s.on("data", () => {
        /* 排水 */
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const ch = new EventTimingChannels();
    try {
      // connect() 内部同步建好 pending socket 后立刻 destroy ⇒ dial 必定还在途
      const p = ch.connect("127.0.0.1", { eventPort: port, timingPort: port });
      ch.destroy();
      await p; // 必须不挂死；且回调不得把 connected 置回 true
      expect(ch.ntpConnected).toBe(false);

      await sleep(700); // 覆盖退避窗口（100ms 起）
      const after = conns;
      for (const s of serverSockets) s.destroy(); // 逼重连路径现形
      await sleep(700);
      expect(conns).toBe(after); // 不再增长 ⇒ 无重连、无漏建 TCP
      expect(ch.ntpConnected).toBe(false);
    } finally {
      ch.destroy();
      for (const s of serverSockets) s.destroy();
      srv.close();
    }
  });

  it("供给器抛错：pumpRealtime 收敛为 error + lastError 有值，且异常仍上抛调用方", async () => {
    const acc = await startFakeAccessory();
    const client = new Ap2RtspClient();
    await client.connect("127.0.0.1", acc.port);
    client.upgradeToEncrypted(SHARED);
    const session = new Ap2StreamSession({
      host: "127.0.0.1", port: acc.port, controllerId: "F00FBABE0008", client, sourceRate: 48000,
    });
    const provider = {
      pull: async (): Promise<Buffer | null> => {
        throw new Error("桥队列已废：pull 崩了");
      },
    };
    try {
      await session.open();
      // ① 异常必须上抛（不吞）
      await expect(session.pumpRealtime(provider)).rejects.toThrow("pull 崩了");
      // ② 状态机必须收敛（不能停在 open）
      expect(session.currentState).toBe("error");
      expect(session.stats.linkLoss).toBe("provider-error");
      expect(session.stats.lastError).toBe("桥队列已废：pull 崩了");
      // ③ 收敛后不得再推流
      expect(() => session.pump(pcm(352))).toThrow(Ap2StreamError);
    } finally {
      await session.close();
      acc.close();
    }
  });

  it("排水通道断线后重连，destroy() 后不再重连（无悬挂定时器）", async () => {
    let conns = 0;
    const serverSockets: Socket[] = [];
    const srv: Server = createServer((s: Socket) => {
      conns++;
      serverSockets.push(s);
      s.on("error", () => {
        /* ignore */
      });
      s.on("data", () => {
        /* 排水 */
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const ch = new EventTimingChannels();
    try {
      await ch.connect("127.0.0.1", { eventPort: port, timingPort: port });
      await until(() => conns === 2); // event + timing 两条 TCP（accept 回调晚于 connect resolve）
      // 服务器侧强拆 → 退避重连（100ms 起）
      for (const s of serverSockets) s.destroy();
      await until(() => conns > 2, 3000);
      // event/timing 两条通道各自重连，第二条 accept 可能晚于第一条 ⇒ 先等齐再取基线，
      // 否则「兄弟连接的 accept」会在 destroy() 之后落定，被误判成「destroy 后又发起了连接」。
      await sleep(400);
      ch.destroy();
      const afterDestroy = conns;
      await sleep(700); // 覆盖退避窗口
      expect(conns).toBe(afterDestroy); // destroy 后不再发起连接
    } finally {
      ch.destroy();
      for (const s of serverSockets) s.destroy();
      srv.close();
    }
  });
});
