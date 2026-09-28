// ==================== SendspinConnection:握手分流 / legacy 直通 / 带内 re-handshake ====================
//
// server.ts 后半段是**协议状态机**:明文期(client/init → server/init+msg1 → noise msg2)、
// 加密期(JSON 帧 + 分片重组)、legacy 明文直通(无 Noise)、以及不断连接换会话密钥的
// in-band re-handshake。这里每一条错误分支都是「静默失联」的高发区:分流判错 → 帧被
// 当垃圾丢弃 → 设备收不到 hello/activate → 30s nursery 超时被踢,而日志什么也不说。
//
// 测试用真实 Noise 对(asResponder 演客户端)驱动,不是塞假 session —— 这样 prologue /
// PSK 混入 / transport split 任何一处口径错都会让后续收发失败,断言随之爆掉。
//
// ⚠️ 出站密文必须**按发送顺序**解密(Noise 计数器单调)。故用 stateful reader:每次 drain
// 只消费**新**帧,绝不复用已消费前缀。
import "../plugins/_env.js";

import { describe, it, expect, afterEach, vi } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import { asResponder } from "../../src/services/sendspin/handshake.js";
import { BIN_JSON, BIN_FRAGMENT_MORE, BIN_FRAGMENT_END, PROTOCOL_VERSION } from "../../src/services/sendspin/constants.js";
import { packJsonBody } from "../../src/services/sendspin/framing.js";
import { b64urlEncode, b64urlDecode } from "../../src/services/sendspin/util.js";
import { DEFAULT_SUITE } from "../../src/services/sendspin/server.js";
import {
  FakeWs,
  makeServer,
  makeConn,
  makeLegacyConn,
  completeHandshake,
  logsContain,
  type HandshakeHarness,
} from "./_connStubs.js";

const sockets: FakeWs[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }
});

const track = <T extends { ws: FakeWs }>(h: T): T => {
  sockets.push(h.ws);
  return h;
};
const conn = (srv: any) => track(makeConn(srv));
const legacy = (srv: any, p: Record<string, any> = {}) => track(makeLegacyConn(srv, p));
// 注意:completeHandshake 只真正用 harness.srv(srv 自身持有 log/identity),
// 故这里用 srv 重建 harness —— 日志断言观察的是 srv.log,与 harness.logs 无关。
const noise = (srv: any, opts: any = {}) =>
  track(completeHandshake({ srv, logs: [], identity: srv.identity }, opts));

/** conn 出站前两帧是明文(0=server/init 裸文本,1=noise/handshake 明文 JSON);其后是密文。 */
const FIRST_ENCRYPTED = 2;

/** 按发送顺序增量消费 conn 的加密 JSON 帧(Noise 计数器必须单调,故 stateful)。 */
function makeReader(h: HandshakeHarness) {
  let cursor = FIRST_ENCRYPTED;
  return {
    next(): any {
      while (cursor < h.ws.sent.length) {
        const pt = h.receiveFromConn(h.ws.sent[cursor++]!.data as Uint8Array);
        if (pt.length > 0 && pt[0] === BIN_JSON) {
          try {
            return JSON.parse(Buffer.from(pt.subarray(1)).toString("utf8"));
          } catch {
            continue;
          }
        }
        continue; // 非 JSON 二进制帧(音频等)跳过
      }
      return undefined;
    },
    drain(): any[] {
      const out: any[] = [];
      for (let m = this.next(); m !== undefined; m = this.next()) out.push(m);
      return out;
    },
  };
}

describe("明文期分流:非法/越序帧一律 fail 断连(不静默吞)", () => {
  it("client/init 前收到无法解析的 JSON → malformed cleartext JSON", () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    void h.conn.onFrame(Buffer.from("{not json", "utf8"), false);
    expect(h.ws.terminateCount).toBe(1);
    expect(logsContain(logs, "malformed cleartext JSON")).toBe(true);
  });

  it("明文期收到二进制帧 → 明确拒绝(协议要求 TEXT)", () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    void h.conn.onFrame(Buffer.from([0, 1, 2]), true);
    expect(h.ws.terminateCount).toBe(1);
    expect(logsContain(logs, "unexpected binary frame during cleartext handshake")).toBe(true);
  });

  it("重复 client/init → duplicate client/init(状态机不许被重置)", () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    const pub = b64urlEncode(x25519.getPublicKey(x25519.utils.randomSecretKey()));
    const init = { type: "client/init", payload: { version: PROTOCOL_VERSION, client_id: pub } };
    void h.conn.onFrame(Buffer.from(JSON.stringify(init), "utf8"), false);
    void h.conn.onFrame(Buffer.from(JSON.stringify(init), "utf8"), false);
    expect(h.ws.terminateCount).toBe(1);
    expect(logsContain(logs, "duplicate client/init")).toBe(true);
  });

  it("握手尚未开始就收到 noise/handshake → unexpected noise/handshake", () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    void h.conn.onFrame(
      Buffer.from(JSON.stringify({ type: "noise/handshake", payload: { data: "x" } }), "utf8"),
      false,
    );
    expect(logsContain(logs, "unexpected noise/handshake")).toBe(true);
  });

  it("未知明文帧(既非 client/init 也非 noise/handshake) → 拒绝并报出类型", () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    void h.conn.onFrame(Buffer.from(JSON.stringify({ type: "server/nonsense" }), "utf8"), false);
    expect(logsContain(logs, "unexpected cleartext frame: server/nonsense")).toBe(true);
  });

  it("★ allowLegacyClients=false 时明文 client/hello 直接 fail(只留合规加密客户端)", () => {
    const { srv, logs } = makeServer({ allowLegacyClients: false });
    const h = conn(srv);
    void h.conn.onFrame(
      Buffer.from(JSON.stringify({ type: "client/hello", payload: { client_id: "X" } }), "utf8"),
      false,
    );
    expect(logsContain(logs, "legacy clients disabled")).toBe(true);
    expect(h.conn.legacy).toBe(false);
  });
});

describe("beginHandshake:client/init 参数校验与 msg1 下发", () => {
  const init = (payload: any) => Buffer.from(JSON.stringify({ type: "client/init", payload }), "utf8");
  const pub = () => b64urlEncode(x25519.getPublicKey(x25519.utils.randomSecretKey()));

  it("版本不符 → unsupported protocol version", () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    void h.conn.onFrame(init({ version: 999, client_id: pub() }), false);
    expect(logsContain(logs, "unsupported protocol version")).toBe(true);
  });

  it("未知 suite → unsupported suite(不静默退回)", () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    void h.conn.onFrame(init({ version: PROTOCOL_VERSION, suite: "bogus", client_id: pub() }), false);
    expect(logsContain(logs, "unsupported suite: bogus")).toBe(true);
  });

  it("缺 client_id → missing client_id", () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    void h.conn.onFrame(init({ version: PROTOCOL_VERSION }), false);
    expect(logsContain(logs, "missing client_id")).toBe(true);
  });

  it("client_id 不是 32 字节 X25519 公钥 → invalid client_id", () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    void h.conn.onFrame(init({ version: PROTOCOL_VERSION, client_id: "AAAA" }), false);
    expect(logsContain(logs, "invalid client_id")).toBe(true);
  });

  it("★ 合法 client/init → 回 server/init 裸文本 + noise/handshake(msg1),进入 handshake 相位", async () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    await h.conn.onFrame(init({ version: PROTOCOL_VERSION, client_id: pub() }), false);
    // server/init 是**裸 JSON 文本**(不是 {type,payload} 包装)—— 客户端按原文拼 prologue。
    const serverInit = h.ws.texts().find((t) => t.includes("server/init"));
    expect(serverInit).toBeTruthy();
    expect(JSON.parse(serverInit!)).toMatchObject({
      type: "server/init",
      payload: { version: PROTOCOL_VERSION, server_id: srv.serverId },
    });
    const m1 = h.ws.jsonOf("noise/handshake");
    expect(m1.length).toBe(1);
    expect(typeof m1[0].payload.data).toBe("string");
    expect(h.conn.handshakePskCategory).toBe("sn"); // 无配对记录 → pairing PSK(sentinel,sn)
    expect(logsContain(logs, "handshake ok")).toBe(false); // 还没收到 msg2
  });

  it("★ 有配对记录 → 会话 PSK 类别升为 lt(长配对 PSK)", async () => {
    const PSK = "11".repeat(32);
    const { srv } = makeServer();
    srv.pairingStore = { getRecord: () => ({ pskHex: PSK }) } as any;
    const h = conn(srv);
    await h.conn.onFrame(init({ version: PROTOCOL_VERSION, client_id: pub() }), false);
    expect(h.conn.handshakePskCategory).toBe("lt");
  });
});

describe("completeHandshake:Noise msg2 落定 + sentinel fallback", () => {
  it("★ 正确 msg2 → 加密通道就绪(handshakeDone/ready)并下发加密 server/hello", async () => {
    const { srv, logs } = makeServer();
    const h = await noise(srv);
    const reader = makeReader(h);
    expect(h.conn.handshakeDone).toBe(true);
    expect(h.conn.ready).toBe(true);
    expect(reader.drain().some((m) => m.type === "server/hello")).toBe(true);
    expect(logsContain(logs, "handshake ok")).toBe(true);
  });

  it("错误 msg2(认证失败,非 lt)→ 明确 fail,不假装成功", async () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    const pub = b64urlEncode(x25519.getPublicKey(x25519.utils.randomSecretKey()));
    const clientInitText = JSON.stringify({
      type: "client/init",
      payload: { version: PROTOCOL_VERSION, client_id: pub },
    });
    await h.conn.onFrame(Buffer.from(clientInitText, "utf8"), false);
    void h.conn.onFrame(
      Buffer.from(
        JSON.stringify({ type: "noise/handshake", payload: { data: "AAAAAAAAAAAAAAAAAAAAAA" } }),
        "utf8",
      ),
      false,
    );
    expect(logsContain(logs, "noise message 2 failed authentication")).toBe(true);
    expect(h.conn.handshakeDone).toBe(false);
  });

  // ⚠️ 已知产品缺陷(记入交付报告):trySentinelFallback 重放 msg1 时用了 **sentinel 派生
  //    的负载字节**,而对端客户端 hash 进对称状态的是服务端实际发出的 **lt 负载字节**;
  //    两者不同 ⇒ hash 分叉 ⇒ readMessage(msg2) 必 "invalid tag" ⇒ fallback 恒返回 false。
  //    (已用独立脚本实证:换成原始 lt payload 重放 → msg2 立即可解。)
  //    这里用 it.fails 记录「本应成立」的契约:缺陷修好那天它会翻红,提醒解除标记。
  it.fails("★ Sentinel Fallback:服务端按长配对 PSK 起会话,客户端丢记录用 sentinel 回 msg2 → 切回 sentinel 且标记失配", async () => {
    const { srv } = makeServer();
    const PSK = "aa".repeat(32);
    const h = await noise(srv, { pairingStore: { getRecord: () => ({ pskHex: PSK }) } });
    expect(h.conn.sentinelMismatch).toBe(true);
    expect(h.conn.handshakeDone).toBe(true);
    expect(h.conn.handshakePskCategory).toBe("sn");
  });

  // 现状(缺陷未修时):fallback 无法自证,必须**如实 fail** 而不是假装成功。
  it("★ 凭证失配且 fallback 失败 → 明确 fail 收口(绝不假装握手成功)", async () => {
    const { srv, logs } = makeServer();
    const PSK = "aa".repeat(32);
    const h = await noise(srv, { pairingStore: { getRecord: () => ({ pskHex: PSK }) } });
    expect(h.conn.sentinelMismatch).toBe(false);
    expect(h.conn.handshakeDone).toBe(false);
    expect(logsContain(logs, "noise message 2 failed authentication")).toBe(true);
  });

  it("★ lt 会话握手成功 → 刷新配对记录活跃时间(记录不被回收)", async () => {
    const PSK = "bb".repeat(32);
    const touchRecord = vi.fn(async () => {});
    const { srv } = makeServer();
    const h = await noise(srv, {
      pairingStore: { getRecord: () => ({ pskHex: PSK }), touchRecord },
      responderPskHex: PSK,
    });
    expect(h.conn.handshakePskCategory).toBe("lt");
    expect(touchRecord).toHaveBeenCalledWith(h.conn.clientId);
  });
});

describe("legacy 明文直通:beginLegacy 与 handleLegacyFrame", () => {
  it("★ 明文 client/hello → 明文 server/hello + server/activate + group/update + 注册", () => {
    const { srv } = makeServer();
    const h = legacy(srv, {
      client_id: "AA:BB:CC:DD:EE:FF",
      "player@v1_support": { supported_formats: [{ codec: "flac" }], supported_commands: ["volume"] },
    });
    expect(h.conn.legacy).toBe(true);
    expect(h.conn.ready).toBe(true);
    expect(h.conn.codec).toBe("flac");
    const hello = h.ws.jsonOf("server/hello");
    expect(hello.length).toBe(1);
    // 五字段必须齐全:sendspin-cpp 严格校验,缺任一 hello 作废 → 握手永不完成。
    expect(Object.keys(hello[0].payload).sort()).toEqual(
      ["active_roles", "connection_reason", "name", "server_id", "version"].sort(),
    );
    expect(hello[0].payload.connection_reason).toBe("discovery");
    expect(h.ws.jsonOf("server/activate").length).toBe(1);
    expect(h.ws.jsonOf("group/update").length).toBe(1);
    expect(srv.clients.get(h.conn.clientId)).toBe(h.conn);
  });

  it("client_id 缺失 → 合成 legacy-<hex>(不允许空身份)", () => {
    const { srv } = makeServer();
    const h = legacy(srv, { client_id: "" });
    expect(h.conn.clientId).toMatch(/^legacy-[0-9a-f]{16}$/);
  });

  it("无法序列化的 hello(循环引用)被容错:RAW 日志跳过但直通照常完成", () => {
    const { srv, logs } = makeServer();
    const h = conn(srv);
    const circular: any = { client_id: "CIRC", name: "C" };
    circular.self = circular;
    expect(() => (h.conn as any).beginLegacy(circular)).not.toThrow();
    expect(h.conn.legacy).toBe(true);
    expect(logsContain(logs, "legacy client/hello RAW")).toBe(false);
  });

  it("legacy 期无法解析的 JSON → 静默忽略(不断连)", () => {
    const { srv } = makeServer();
    const h = legacy(srv);
    const before = h.ws.sent.length;
    void h.conn.onFrame(Buffer.from("###", "utf8"), false);
    expect(h.ws.terminateCount).toBe(0);
    expect(h.ws.sent.length).toBe(before);
  });

  it("legacy 期上行二进制直接忽略(legacy 客户端无上行二进制)", () => {
    const { srv } = makeServer();
    const h = legacy(srv);
    const before = h.ws.sent.length;
    void h.conn.onFrame(Buffer.from([1, 2, 3]), true);
    expect(h.ws.sent.length).toBe(before);
  });

  it("legacy client/state → 解析设备上报参数", () => {
    const { srv } = makeServer();
    const h = legacy(srv);
    void h.conn.onFrame(
      Buffer.from(
        JSON.stringify({ type: "client/state", payload: { player: { output_delay_ms: 12, min_buffer_ms: 700 } } }),
        "utf8",
      ),
      false,
    );
    expect(h.conn.outputDelayMs).toBe(12);
    expect(h.conn.minBufferMs).toBe(700);
    expect(h.conn.stateReported).toBe(true);
  });

  it("★ legacy client/time → 回 server/time,client_transmitted 原样带回", () => {
    const { srv } = makeServer();
    const h = legacy(srv);
    h.ws.sent.length = 0;
    void h.conn.onFrame(
      Buffer.from(JSON.stringify({ type: "client/time", payload: { client_transmitted: 7 } }), "utf8"),
      false,
    );
    const t = h.ws.jsonOf("server/time");
    expect(t.length).toBe(1);
    expect(t[0].payload.client_transmitted).toBe(7);
    expect(typeof t[0].payload.server_received).toBe("number");
    expect(typeof t[0].payload.server_transmitted).toBe("number");
  });

  it("legacy 未知帧交给 MessageRouter,并把本连接作为 _conn 注入", () => {
    const { srv } = makeServer();
    const seen: any[] = [];
    srv.router.register("client", "custom", (payload: any) => seen.push(payload));
    const h = legacy(srv);
    void h.conn.onFrame(
      Buffer.from(JSON.stringify({ type: "client/custom", payload: { v: 5 } }), "utf8"),
      false,
    );
    expect(seen.length).toBe(1);
    expect(seen[0].v).toBe(5);
    expect(seen[0]._conn).toBe(h.conn);
  });

  it("★ legacy goodbye(another_server):拨出连接记入重拨抑制并关闭 socket", () => {
    const { srv, logs } = makeServer();
    const h = legacy(srv);
    h.conn.dialed = true;
    h.conn.dialHost = "10.0.0.9";
    h.conn.dialPort = 8928;
    void h.conn.onFrame(
      Buffer.from(JSON.stringify({ type: "client/goodbye", payload: { reason: "another_server" } }), "utf8"),
      false,
    );
    expect(srv.noRedialReason("10.0.0.9", 8928)).toBe("another_server");
    expect(h.ws.terminateCount).toBeGreaterThan(0);
    expect(logsContain(logs, "auto-redial suppressed")).toBe(true);
  });

  it("goodbye(restart) 不抑制重拨(设备是自己重启,应当拨回)", () => {
    const { srv } = makeServer();
    const h = legacy(srv);
    h.conn.dialed = true;
    h.conn.dialHost = "10.0.0.9";
    h.conn.dialPort = 8928;
    void h.conn.onFrame(
      Buffer.from(JSON.stringify({ type: "client/goodbye", payload: { reason: "restart" } }), "utf8"),
      false,
    );
    expect(srv.isRedialSuppressed("10.0.0.9", 8928)).toBe(false);
    expect(h.ws.terminateCount).toBeGreaterThan(0);
  });
});

describe("加密期 dispatch:onClientHello / client/time / client/state / pair / router", () => {
  it("★ client/hello → 协商角色与 codec、解析容量与命令、下发 activate+group/update、注册", async () => {
    const activated: any[] = [];
    const { srv } = makeServer({ onActivated: (c) => activated.push(c) });
    const h = await noise(srv, {
      helloPayload: {
        name: "客厅",
        supported_roles: ["player@v1", "controller@v1"],
        "player@v1_support": {
          supported_formats: [{ codec: "flac" }],
          buffer_capacity: 1_600_000,
          supported_commands: ["volume", "mute"],
        },
      },
    });
    const reader = makeReader(h);
    expect(h.conn.roles).toEqual(["player@v1", "controller@v1"]);
    expect(h.conn.name).toBe("客厅");
    expect(h.conn.codec).toBe("flac"); // 只声明 flac(首选 pcm 不被支持时自动退到 flac)
    expect(h.conn.bufferCapacityBytes).toBe(1_600_000);
    expect(h.conn.supportedCommands).toEqual(["volume", "mute"]);
    expect(srv.clients.get(h.conn.clientId!)).toBe(h.conn);
    expect(activated).toEqual([h.conn]);
    const msgs = reader.drain();
    const act = msgs.filter((m) => m.type === "server/activate").pop();
    expect(act.payload).toEqual({ activities: ["playback"], active_roles: ["player@v1", "controller@v1"] });
    // spec MUST:首次 activate 后立即下发 group/update,否则 sendspin-cpp 不认 server。
    expect(msgs.some((m) => m.type === "group/update")).toBe(true);
  });

  it("加密期 client/time → 回 server/time", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    const reader = makeReader(h);
    reader.drain(); // 清掉握手期的 server/hello
    await h.deliverJson({ type: "client/time", payload: { client_transmitted: 42 } });
    const t = reader.drain().filter((m) => m.type === "server/time").pop();
    expect(t.payload.client_transmitted).toBe(42);
  });

  it("加密期 client/state → 解析设备参数(与 legacy 同语义)", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    await h.deliverJson({ type: "client/state", payload: { player: { required_lead_time_ms: 250 } } });
    expect(h.conn.requiredLeadTimeMs).toBe(250);
  });

  it("★ pair/* 转交 PairingCoordinator(未注入则忽略,不抛)", async () => {
    const { srv } = makeServer();
    const onPairMessage = vi.fn();
    srv.pairing = { onPairMessage } as any;
    const h = await noise(srv);
    await h.deliverJson({ type: "client/pair/abort", payload: { reason: "user" } });
    expect(onPairMessage).toHaveBeenCalledTimes(1);
    expect(onPairMessage.mock.calls[0]![0]).toBe(h.conn);
    expect(onPairMessage.mock.calls[0]![1]).toBe("client/pair/abort");
  });

  it("pair/abort(无 client/ 前缀)同样转交", async () => {
    const { srv } = makeServer();
    const onPairMessage = vi.fn();
    srv.pairing = { onPairMessage } as any;
    const h = await noise(srv);
    await h.deliverJson({ type: "pair/abort", payload: {} });
    expect(onPairMessage).toHaveBeenCalledTimes(1);
  });

  it("未注入 pairing 时 pair 消息被安全忽略", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    await expect(h.deliverJson({ type: "client/pair/abort", payload: {} })).resolves.toBeUndefined();
  });

  it("★ 非 re-handshake 期的 noise/handshake 被忽略(不误当 msg2)", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    await h.deliverJson({ type: "noise/handshake", payload: { data: b64urlEncode(new Uint8Array(8)) } });
    expect(h.conn.handshakeDone).toBe(true);
    expect((h.conn as any).rehandshaking).toBeNull();
  });
});

describe("加密期分片重组:_onMore/_onEnd", () => {
  it("★ 被拆成多帧的应用消息重组后照常派发(大消息不丢)", async () => {
    const { srv } = makeServer();
    const seen: any[] = [];
    srv.router.register("client", "frag", (p: any) => seen.push(p));
    const h = await noise(srv);
    const body = packJsonBody({ type: "client/frag", payload: { v: 42 } } as any);
    const k = 5; // 在 JSON 体中间切开
    const first = new Uint8Array([BIN_FRAGMENT_MORE, body[0]!, ...body.subarray(1, 1 + k)]);
    const rest = new Uint8Array([BIN_FRAGMENT_END, ...body.subarray(1 + k)]);
    await h.deliver(first);
    await h.deliver(rest);
    expect(seen).toEqual([{ v: 42, _conn: h.conn }]);
  });

  it("没有前置 MORE 的孤立 END 被忽略(不构造半截 body)", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    await h.deliver(new Uint8Array([BIN_FRAGMENT_END, 1, 2, 3]));
    expect((h.conn as any).reasm).toBeNull();
  });

  it("多段 MORE 后 END:三段重组", async () => {
    const { srv } = makeServer();
    const seen: any[] = [];
    srv.router.register("client", "frag2", (p: any) => seen.push(p));
    const h = await noise(srv);
    const body = packJsonBody({ type: "client/frag2", payload: { s: "abcdefghij" } } as any);
    const a = new Uint8Array([BIN_FRAGMENT_MORE, body[0]!, ...body.subarray(1, 4)]);
    const b = new Uint8Array([BIN_FRAGMENT_MORE, ...body.subarray(4, 8)]);
    const c = new Uint8Array([BIN_FRAGMENT_END, ...body.subarray(8)]);
    await h.deliver(a);
    await h.deliver(b);
    await h.deliver(c);
    expect(seen[0].s).toBe("abcdefghij");
  });
});

describe("加密期收帧错误收口", () => {
  it("★ 解密失败 → 记录错误并 terminate(不会把密文当明文继续跑)", async () => {
    const { srv, logs } = makeServer();
    const h = await noise(srv);
    void h.conn.onFrame(Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]), true);
    expect(h.ws.terminateCount).toBe(1);
    expect(logsContain(logs, "transport auth failed")).toBe(true);
  });
});

describe("re-handshakeTo:不断连接换会话密钥", () => {
  const PSK2 = "cc".repeat(32);

  it("legacy 连接 → 明确拒绝(明文无会话密钥可换)", async () => {
    const { srv } = makeServer();
    const h = legacy(srv);
    await expect(h.conn.rehandshakeTo(PSK2, "lt")).rejects.toThrow(/仅加密连接可用/);
  });

  it("无 pending 时收到 msg2 → 静默返回(不越界)", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    expect(() => (h.conn as any).onRehandshakeMsg2("AAAA")).not.toThrow();
  });

  it("★ 完整再握手:新 msg1 → 对端 msg2 → 会话切换、类别/liveness 更新、重发 server/hello", async () => {
    const touchRecord = vi.fn(async () => {});
    const { srv } = makeServer();
    srv.pairingStore = { getRecord: () => null, touchRecord } as any;
    const h = await noise(srv);
    const reader = makeReader(h);
    const p = h.conn.rehandshakeTo(PSK2, "lt");
    // 已在进行 → 第二次必须拒绝(否则两套会话交叠)
    await expect(h.conn.rehandshakeTo(PSK2, "lt")).rejects.toThrow(/已在进行/);

    // 从 conn 出站加密帧里取出新 msg1(reader 按序消费)。
    const hs = reader.drain().filter((m) => m.type === "noise/handshake").pop();
    const msg1 = b64urlDecode(hs.payload.data);

    // 对端(responder)以旧会话 hash 为 prologue、用新 PSK 应答。
    const rh = asResponder({
      suite: DEFAULT_SUITE,
      localStaticPriv: h.clientPriv,
      remoteStaticPub: x25519.getPublicKey(srv.identity.privateKey),
      prologue: new Uint8Array(h.responder.handshakeHash),
      psk: Buffer.from(PSK2, "hex"),
    });
    rh.readMessage(msg1);
    const msg2 = rh.writeMessage(new Uint8Array(0));
    await h.deliverJson({ type: "noise/handshake", payload: { data: b64urlEncode(msg2) } });
    await p;

    expect((h.conn as any).rehandshaking).toBeNull();
    expect(h.conn.handshakePskCategory).toBe("lt");
    expect((h.conn as any).pairingActivations).toBe(0);
    expect(touchRecord).toHaveBeenCalled();
    // 会话已换:重发的 server/hello 用的是**新**密钥 ⇒ 必须用新 responder(rh)解密。
    const last = h.ws.sent[h.ws.sent.length - 1]!;
    const pt = rh.decrypt(last.data as Uint8Array);
    expect(JSON.parse(Buffer.from(pt.subarray(1)).toString("utf8")).type).toBe("server/hello");
  });

  it("★ msg2 认证失败 → failRehandshake:promise reject 且清空状态(不留悬挂)", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    const p = h.conn.rehandshakeTo(PSK2, "lt");
    // 用旧会话加密一个伪造 msg2 → 新会话 readMessage 必失败
    await h.deliverJson({
      type: "noise/handshake",
      payload: { data: b64urlEncode(new Uint8Array(32).fill(7)) },
    });
    await expect(p).rejects.toThrow(/re-handshake msg2/);
    expect((h.conn as any).rehandshaking).toBeNull();
  });

  it("re-handshake 期间应用消息被暂禁(client/time 不产生 server/time)", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    const reader = makeReader(h);
    const p = h.conn.rehandshakeTo(PSK2, "lt");
    await h.deliverJson({ type: "client/time", payload: { client_transmitted: 1 } });
    const since = reader.drain();
    expect(since.some((m) => m.type === "server/time")).toBe(false);
    // 收尾:让 pending reject,避免悬挂定时器
    await h.deliverJson({
      type: "noise/handshake",
      payload: { data: b64urlEncode(new Uint8Array(32).fill(3)) },
    });
    await expect(p).rejects.toThrow();
  });
});

describe("client/state 解析:available / state 门控与变化日志", () => {
  it("★ available:false → 置不可用并按时间戳记账;true → 立即复位", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    await h.deliverJson({ type: "client/state", payload: { available: false } });
    expect(h.conn.clientAvailable).toBe(false);
    expect(h.conn.clientUnavailableSinceMs).toBeGreaterThan(0);
    expect(h.conn.clientWantsStream()).toBe(false);
    await h.deliverJson({ type: "client/state", payload: { available: true } });
    expect(h.conn.clientAvailable).toBe(true);
    expect(h.conn.clientUnavailableSinceMs).toBe(0);
    expect(h.conn.clientWantsStream()).toBe(true);
  });

  it("available 在 player 层回落读取(根层优先)", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    await h.deliverJson({ type: "client/state", payload: { player: { available: false } } });
    expect(h.conn.clientAvailable).toBe(false);
  });

  it("★ state=error 打 SYNC LOST 警告;synchronized 报恢复;同值不重复刷日志", async () => {
    const { srv, logs } = makeServer();
    const h = await noise(srv);
    await h.deliverJson({ type: "client/state", payload: { state: "error" } });
    expect(h.conn.clientSyncState).toBe("error");
    expect(logs.some(([lv, m]) => lv === "warn" && m.includes("SYNC LOST"))).toBe(true);
    await h.deliverJson({ type: "client/state", payload: { state: "error" } });
    expect(logs.filter(([, m]) => m.includes("SYNC LOST")).length).toBe(1); // 只记变化
    await h.deliverJson({ type: "client/state", payload: { state: "synchronized" } });
    expect(logs.some(([, m]) => m.includes("reports synchronized"))).toBe(true);
  });

  it("buffer_capacity 与 static_delay_ms 回落解析", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    await h.deliverJson({
      type: "client/state",
      payload: { player: { static_delay_ms: 25, buffer_capacity_ms: 3000 } },
    });
    expect(h.conn.outputDelayMs).toBe(25);
    expect(h.conn.bufferCapacityMs).toBe(3000);
  });

  it("负数/非有限值一律不采纳(按未提供处理)", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    await h.deliverJson({
      type: "client/state",
      payload: { player: { output_delay_ms: -5, min_buffer_ms: "abc" } },
    });
    expect(h.conn.outputDelayMs).toBe(0);
    expect(h.conn.minBufferMs).toBe(0);
  });

  it("★ 无法序列化的 payload 首报日志退化为占位(不炸在日志里)", async () => {
    const { srv, logs } = makeServer();
    const h = await noise(srv);
    const circular: any = { client_id: "C" };
    circular.self = circular;
    expect(() => (h.conn as any).applyClientState(circular)).not.toThrow();
    expect(logsContain(logs, "<unserializable>")).toBe(true);
  });

  it("非对象 payload 直接忽略", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    expect(() => (h.conn as any).applyClientState(null)).not.toThrow();
    expect(h.conn.stateReported).toBe(false);
  });

  it("★ clientWantsStream:未上报(null)不门控;报 false 超过 3s 兜底放行(宁可丢帧也不永无声)", async () => {
    const { srv } = makeServer();
    const h = await noise(srv);
    expect(h.conn.clientWantsStream()).toBe(true); // null
    h.conn.clientAvailable = false;
    h.conn.clientUnavailableSinceMs = Date.now();
    expect(h.conn.clientWantsStream()).toBe(false);
    h.conn.clientUnavailableSinceMs = Date.now() - 4000;
    expect(h.conn.clientWantsStream()).toBe(true);
  });
});
