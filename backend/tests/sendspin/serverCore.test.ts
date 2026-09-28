// ==================== SendspinServer / SendspinGroup:业务接线与状态机补测 ====================
//
// `server.ts` 的 `SendspinConnection`(每条连接)另有 connection*.test.ts 覆盖;本文件
// 锁的是**服务端级**的那几个对象:**重拨抑制表**(设备 goodbye 后不许再拨,但必须会过期,
// 否则硬断电的设备永远回不来)、**「目标是否已在线」判定**(拨入/拨出两条路径口径不同,
// 判错会双连接被设备仲裁踢掉)、**组回收**(组空即停 pump + 关编码器,不做就是内存/CPU
// 双泄漏)、以及**延迟 stream/start 的兑现**(兑现早了 FLAC 新成员无声、兑现晚了客户端空等)。
//
// 这些分支此前全黑:整仓没有一处 `new SendspinServer` 的单元测试(只有真起端口的集成
// 测试走到主路径)。这里用纯内存对象 + 受控假 socket,把「判据/边界/收口」拉出来。
import "../plugins/_env.js";

import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { SendspinServer } from "../../src/services/sendspin/server.js";
import { setNowUsOverride } from "../../src/services/sendspin/clock.js";
import { makeServer, makeConn, makeLegacyConn, FakeWs, makeIdentity } from "./_connStubs.js";

/** 本文件造出的所有假 socket —— 用后统一 terminate,清掉连接里的心跳定时器。 */
const sockets: FakeWs[] = [];
const mkconn = (srv: SendspinServer) => {
  const h = makeConn(srv);
  sockets.push(h.ws);
  return h;
};
const mklegacy = (srv: SendspinServer, payload: Record<string, any> = {}) => {
  const h = makeLegacyConn(srv, payload);
  sockets.push(h.ws);
  return h;
};
afterEach(() => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }
  setNowUsOverride(null);
});

describe("重拨抑制表:goodbye 后抑制自动重拨,但必须有限期(惰性过期)", () => {
  it("clearNoRedial 移除指定目标的抑制(运营商手动拨号即恢复)", () => {
    const { srv } = makeServer();
    srv.suppressRedial("10.0.0.9", 8928, "another_server");
    expect(srv.isRedialSuppressed("10.0.0.9", 8928)).toBe(true);
    srv.clearNoRedial("10.0.0.9", 8928);
    expect(srv.noRedialReason("10.0.0.9", 8928)).toBeNull();
    expect(srv.isRedialSuppressed("10.0.0.9", 8928)).toBe(false);
  });

  it("清除不存在的目标不抛(路由层无条件调用)", () => {
    const { srv } = makeServer();
    expect(() => srv.clearNoRedial("nope", 1)).not.toThrow();
    expect(srv.isRedialSuppressed("nope", 1)).toBe(false);
  });

  it("ttlMs<=0 → 不过期(Infinity,仅测试/特殊场景)", () => {
    const { srv } = makeServer();
    srv.suppressRedial("h", 9, "manual", 0);
    expect(srv.noRedialReason("h", 9)).toBe("manual");
    expect(srv.isRedialSuppressed("h", 9)).toBe(true);
  });

  it("★ 过期条目惰性清除:设备硬断电后重新上线不会被永久拉黑", () => {
    const { srv } = makeServer();
    // 直接构造一条「已过期」的抑制(免去真实等待,严格确定性)。
    srv.noAutoRedial.set("h:10", { reason: "another_server", until: Date.now() - 1 });
    expect(srv.noRedialReason("h", 10)).toBeNull();
    // 惰性删除:再查一次也不能复活。
    expect(srv.noAutoRedial.has("h:10")).toBe(false);
  });
});

describe("isConnectedTo:判「该目标是否已在线」,拨入按主机 / 拨出按 host:port", () => {
  it("空主机 / 无连接一律 false", () => {
    const { srv } = makeServer();
    expect(srv.isConnectedTo("", 1)).toBe(false);
    expect(srv.isConnectedTo("h", 1)).toBe(false);
  });

  it("拨出的连接按 host:port 精确匹配(端口错不算在线)", () => {
    const { srv } = makeServer();
    const { conn } = mkconn(srv);
    conn.dialed = true;
    conn.dialHost = "10.0.0.5";
    conn.dialPort = 8928;
    srv.clients.set("d1", conn);
    expect(srv.isConnectedTo("10.0.0.5", 8928)).toBe(true);
    expect(srv.isConnectedTo("10.0.0.5", 1234)).toBe(false);
    expect(srv.isConnectedTo("10.0.0.6", 8928)).toBe(false);
  });

  it("★ 拨入的连接只有 remoteHost(端口未知)→ 按主机匹配,任意端口都算在线", () => {
    const { srv } = makeServer();
    const { conn } = mkconn(srv);
    conn.remoteHost = "10.0.0.7";
    srv.clients.set("i1", conn);
    expect(srv.isConnectedTo("10.0.0.7", 7)).toBe(true);
    expect(srv.isConnectedTo("10.0.0.7", 65535)).toBe(true);
    expect(srv.isConnectedTo("10.0.0.8", 7)).toBe(false);
  });
});

describe("peersByHost:按对端 IP 反查连接(ESPHome 6053 桥接的派生入口)", () => {
  it("同一 host 折叠成数组;无 remoteHost 的连接被忽略", () => {
    const { srv } = makeServer();
    const a = mkconn(srv).conn;
    const b = mkconn(srv).conn;
    const c = mkconn(srv).conn;
    a.remoteHost = "10.0.0.1";
    b.remoteHost = "10.0.0.1";
    c.remoteHost = "";
    srv.clients.set("a", a);
    srv.clients.set("b", b);
    srv.clients.set("c", c);
    const m = srv.peersByHost();
    expect([...m.keys()]).toEqual(["10.0.0.1"]);
    expect(m.get("10.0.0.1")).toEqual([a, b]);
  });
});

describe("currentMedia:供 /status media 与 /queue currentMedia", () => {
  it("无组 / 组无当前曲 → undefined;有 → 只暴露媒体字段(不含 durationMs)", () => {
    const { srv } = makeServer();
    expect(srv.currentMedia("ghost")).toBeUndefined();
    const g = srv.group("g1");
    expect(srv.currentMedia("g1")).toBeUndefined();
    g.current = {
      songId: "s1",
      title: "T",
      artist: "A",
      album: "AL",
      coverArt: "cv",
      durationMs: 123,
    } as any;
    expect(srv.currentMedia("g1")).toEqual({ songId: "s1", title: "T", artist: "A", album: "AL", coverArt: "cv" });
  });
});

describe("group():同名取回同一实例", () => {
  it("不存在则建、存在则复用", () => {
    const { srv } = makeServer();
    expect(srv.group("x")).toBe(srv.group("x"));
  });
});

describe("broadcastGroupState:逐成员下发 server/state", () => {
  it("每个成员各收到一份,含组 id / 成员表 / 音量 / 静音 / 位置 / 公共 send_ahead", () => {
    const { srv } = makeServer();
    const g = srv.group("g-state");
    const sent: Array<[string, any]> = [];
    const mk = (id: string, gain = 100, muted = false) => ({
      clientId: id,
      codec: "pcm",
      appliedGain: () => gain,
      muted,
      supportsCommand: () => false,
      sendJson: (t: string, p: any) => sent.push([t, p]),
    });
    g.members.add(mk("m1"));
    g.members.add(mk("m2") as any);
    g.positionMs = 4321;
    g.muted = false;
    srv.broadcastGroupState(g);
    expect(sent.length).toBe(2);
    const [type, p] = sent[0]!;
    expect(type).toBe("server/state");
    expect(p.group.id).toBe("g-state");
    expect(p.group.members.map((m: any) => m.client_id)).toEqual(["m1", "m2"]);
    expect(p.volume).toBe(100);
    expect(p.muted).toBe(false);
    expect(p.position_ms).toBe(4321);
    // 未上报 client/state 时公共 send_ahead = 保守缺省 800ms(向后兼容旧固件)。
    expect(p.send_ahead).toBe(800_000);
    // ⚠️ 当前口径:`timestamp` 是 nowUs() 的 **bigint**。若将来把本函数接进真实
    //    sendJson,JSON.stringify(bigint) 会抛 TypeError —— 已记入缺陷报告(本函数
    //    当前全仓无调用方)。这里只锁"该字段存在",不锁错误行为。
    expect("timestamp" in p).toBe(true);
  });
});

describe("syncVolume:把组音量/静音下发给听众(成员 + 裸设备连接)", () => {
  it("★ 支持 volume+mute 的成员各收两条 server/command,计数正确", () => {
    const { srv } = makeServer();
    const g = srv.group("gv");
    const h = mklegacy(srv); // 宣告 volume/mute,且 legacy ⇒ 出站是明文 JSON,便于断言
    g.add(h.conn);
    h.ws.sent.length = 0;
    expect(srv.syncVolume(g)).toBe(1);
    const cmds = h.ws.jsonOf("server/command");
    expect(cmds.length).toBe(2);
    // 顺序即语义:先 volume 后 mute("取消静音"那一拍不会闪旧音量)。
    expect(cmds[0]!.payload.player).toEqual({ command: "volume", volume: 100 });
    expect(cmds[1]!.payload.player).toEqual({ command: "mute", mute: false });
  });

  it("★ 未入组但同名裸设备的连接也算听众(bare 分支:改音量不再等起播)", () => {
    const { srv } = makeServer();
    const h = mklegacy(srv); // clientId = "LEGACY-1"
    srv.clients.set("LEGACY-1", h.conn);
    const g = srv.group("LEGACY-1"); // 组名 = 裸 clientId 的既有约定
    h.ws.sent.length = 0;
    expect(srv.syncVolume(g)).toBe(1);
    expect(h.ws.jsonOf("server/command").length).toBe(2);
  });

  it("单台下发失败被吞,不连累其余成员(返回仍计成功台数)", () => {
    const { srv } = makeServer();
    const g = srv.group("gv2");
    const good = mklegacy(srv);
    g.add(good.conn);
    const boom = {
      clientId: "boom",
      codec: "pcm",
      volume: 100,
      muted: false,
      supportsCommand: () => true,
      sendPlayerCommand: () => {
        throw new Error("device bus dead");
      },
    };
    g.members.add(boom as any);
    good.ws.sent.length = 0;
    expect(srv.syncVolume(g)).toBe(1);
    expect(good.ws.jsonOf("server/command").length).toBe(2);
  });
});

describe("onConnectionActivated / onConnectionClosed:注册-回收生命周期", () => {
  it("★ 激活即注册并回调;此时同名组已存在 → 立刻补发权威音量(上线即对齐)", () => {
    const activated: any[] = [];
    const { srv } = makeServer({ onActivated: (c) => activated.push(c) });
    srv.group("LEGACY-1"); // 激活前该 clientId 名下已有组(持久音量恢复/掉线重连)
    const h = mklegacy(srv);
    expect(srv.clients.get("LEGACY-1")).toBe(h.conn);
    expect(activated).toEqual([h.conn]);
    expect(h.ws.jsonOf("server/command").length).toBe(2);
  });

  it("★ 断开即注销;组空 → 停 pump + 关编码器 + 回收组(不做就是内存/CPU 双泄漏)", () => {
    const closed: any[] = [];
    const { srv, logs } = makeServer({ onClosed: (c) => closed.push(c) });
    const { conn } = mkconn(srv);
    conn.clientId = "cx";
    srv.clients.set("cx", conn);
    const g = srv.group("gx");
    (g as any).encoders.set("pcm:100", { close() {} });
    conn.group = g;
    g.members.add(conn);

    srv.onConnectionClosed(conn);
    expect(srv.clients.has("cx")).toBe(false);
    expect(conn.group).toBeNull();
    expect(g.members.size).toBe(0);
    expect(srv.groups.has("gx")).toBe(false);
    expect(closed).toEqual([conn]);
    expect(logs.some(([, m]) => m.includes("空了"))).toBe(true);
  });

  it("组内仍有其他成员 → 组不回收(只摘掉离开的那条)", () => {
    const { srv } = makeServer();
    const g = srv.group("gy");
    const a = mkconn(srv).conn;
    const b = mkconn(srv).conn;
    a.clientId = "cy";
    b.clientId = "cz";
    a.group = g;
    b.group = g;
    g.members.add(a);
    g.members.add(b);
    srv.onConnectionClosed(a);
    expect(srv.groups.has("gy")).toBe(true);
    expect(g.members.has(a)).toBe(false);
    expect(g.members.has(b)).toBe(true);
  });

  it("无 clientId / 无组时静默收尾(不抛、不误删)", () => {
    const { srv } = makeServer();
    const { conn } = mkconn(srv);
    expect(() => srv.onConnectionClosed(conn)).not.toThrow();
    expect(srv.clients.size).toBe(0);
  });
});

describe("SendspinServer.create:identity 缺失才落盘生成", () => {
  it("★ 空私钥 + identityDir → loadOrCreateIdentity 生成并落盘", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-sv1-id-"));
    try {
      const srv = await SendspinServer.create({
        pairkeys: { privateKey: new Uint8Array(0), serverId: "" },
        identityDir: dir,
      });
      expect(srv.identity.privateKey.length).toBe(32);
      expect(srv.serverId.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(dir, "sendspin", "identity.key"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("已有私钥 → 不落盘(不覆盖既有身份)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-sv1-id2-"));
    try {
      const srv = await SendspinServer.create({ pairkeys: makeIdentity(), identityDir: path.join(dir, "none") });
      expect(fs.existsSync(path.join(dir, "none"))).toBe(false);
      expect(srv.serverId.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SendspinGroup.flushAnnounceFor / announcePending:延迟 stream/start 的兑现", () => {
  const member = (
    id: string,
    opts: { wants?: boolean; throwAnnounce?: boolean; onAnnounce?: () => void } = {},
  ) => ({
    clientId: id,
    codec: "pcm",
    appliedGain: () => 100,
    supportsCommand: () => false,
    clientWantsStream: () => opts.wants !== false,
    announceStream: () => {
      if (opts.throwAnnounce) throw new Error("announce boom");
      opts.onAnnounce?.();
    },
  });

  it("★ 去重兑现:同一 conn 被压入多次只发一次 stream/start", () => {
    const { srv } = makeServer();
    const g = srv.group("gf");
    const calls: string[] = [];
    const a = member("a", { onAnnounce: () => calls.push("a") });
    g.members.add(a as any);
    g.pendingAnnounces.push(a as any, a as any, a as any);
    g.flushAnnounceFor(a as any);
    expect(calls).toEqual(["a"]);
    expect(g.pendingAnnounces.length).toBe(0);
  });

  it("设备明确报 available:false → 本轮不宣告,条目留在队列等下一帧", () => {
    const { srv } = makeServer();
    const g = srv.group("gf2");
    const b = member("b", { wants: false });
    g.pendingAnnounces.push(b as any);
    g.flushAnnounceFor(b as any);
    expect(g.pendingAnnounces).toContain(b);
  });

  it("不在队列中的 conn 直接返回(幂等)", () => {
    const { srv } = makeServer();
    const g = srv.group("gf3");
    expect(() => g.flushAnnounceFor(member("z") as any)).not.toThrow();
  });

  it("单成员宣告抛错被吞,条目仍被移除(不卡死后续)", () => {
    const { srv } = makeServer();
    const g = srv.group("gf4");
    const d = member("d", { throwAnnounce: true });
    g.pendingAnnounces.push(d as any);
    expect(() => g.flushAnnounceFor(d as any)).not.toThrow();
    expect(g.pendingAnnounces).not.toContain(d);
  });

  it("announcePending:兜底兑现全部,单台抛错不连累其余", () => {
    const { srv } = makeServer();
    const g = srv.group("gp");
    const calls: string[] = [];
    g.pendingAnnounces.push(member("e", { onAnnounce: () => calls.push("e") }) as any);
    g.pendingAnnounces.push(member("f", { throwAnnounce: true }) as any);
    g.announcePending();
    expect(calls).toEqual(["e"]);
    expect(g.pendingAnnounces.length).toBe(0);
  });
});

describe("SendspinGroup.pruneRecent:late-join 缓存只留「未来还没播的」", () => {
  it("★ 超总时长上限时从头部裁剪(剩余在窗口内)", () => {
    setNowUsOverride(() => 1_000_000_000n);
    const { srv } = makeServer();
    const g = srv.group("gr");
    const ring: any[] = (g as any).ringFor("pcm:100");
    for (let i = 0; i < 40; i++) {
      ring.push({ tsUs: 1_000_000_000n + BigInt(i) * 1_000_000n, durUs: 1_000_000, data: new Uint8Array(1) });
    }
    const firstTs = ring[0].tsUs;
    (g as any).pruneRecent();
    expect(ring.length).toBeLessThan(40);
    expect(ring[0].tsUs).toBeGreaterThan(firstTs);
    // 保留量被钳在 35s 上限附近(含跨界的最后一项,允许一帧过冲)。
    const total = ring.reduce((s, r) => s + r.durUs, 0);
    expect(total).toBeLessThanOrEqual(36_000_000);
  });

  it("整环都已播过 → 清空并从 map 移除(不留空桶)", () => {
    setNowUsOverride(() => 1_000_000_000n);
    const { srv } = makeServer();
    const g = srv.group("gr2");
    const ring: any[] = (g as any).ringFor("pcm:100");
    ring.push({ tsUs: 0n, durUs: 1, data: new Uint8Array(1) });
    (g as any).pruneRecent();
    expect((g as any).recentByGroup.has("pcm:100")).toBe(false);
  });
});

describe("SendspinGroup.pushFrame:编码异常必须带上下文再抛", () => {
  it("★ 编码器抛错 → 包装为含 codec/gain/members 的错误(上游才能区分「编码器坏了」与「连接断了」)", async () => {
    setNowUsOverride(() => 0n);
    const { srv } = makeServer();
    const g = srv.group("ge");
    (g as any).encoders.set("pcm:100", {
      encode: async () => {
        throw new Error("libFLAC boom");
      },
    });
    g.members.add({
      clientId: "m",
      codec: "pcm",
      appliedGain: () => 100,
      supportsCommand: () => false,
    } as any);
    await expect(g.pushFrame(0n, new Float32Array(4))).rejects.toThrow(
      /encode failed \(codec=pcm gain=100 members=1\): libFLAC boom/,
    );
  });
});
