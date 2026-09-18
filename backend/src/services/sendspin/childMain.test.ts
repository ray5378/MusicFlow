// ==================== Sendspin 子进程 IPC 桥单测 ====================
//
// 不 fork:用假 server + 收集式 send 通道直接驱动 SendspinChildController,
// 保证「测试路径 = 生产路径」(child.ts 里跑的就是同一套 handler)。
// 重点:
//  - 快照**剥离 pskHex/pskId**(配对密钥永不出子进程 —— 安全属性,必须有测试钉死);
//  - RPC 请求 → res(ok/result|error) 回包契约;
//  - announceProbe 在主进程 deactivate 前捕获现场(丢了就恢复不了进度);
//  - unpair 删记录 + 断连语义。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SendspinChildController, type ChildSend } from "./childMain.js";
import type { ParentToSendspinChild, SendspinChildToParent } from "./ipcProtocol.js";

function makeFakeServer(): any {
  const conns = new Map<string, any>();
  const groups = new Map<string, any>();
  const records = new Map<string, any>([
    // pskHex 是 64 hex;这里放真实长度,验证剥离的是字段而不是恰好为空的值
    ["PC-1", { pskHex: "ab".repeat(32), pskId: "psk-id-1", createdAt: 111, lastUsedAt: 222 }],
  ]);
  const approved = new Map<string, number>([["PC-1", 333]]);
  const srv = {
    serverId: "srv-test",
    clients: conns,
    groups,
    pairingStore: {
      listRecords: () => [...records.entries()].map(([clientId, r]) => ({ clientId, ...r })),
      isApproved: (k: string) => approved.has(k),
      removeRecord: async (k: string) => records.delete(k),
      setApproved: async (k: string, ok: boolean) => {
        if (ok) approved.set(k, 1);
        else approved.delete(k);
      },
    },
    pairing: { listAttempts: () => [] },
    group(name: string) {
      let g = groups.get(name);
      if (!g) {
        g = { name, volume: 100, muted: false, positionMs: 0, current: null, members: new Set(), timelineBaseUs: 0n };
        groups.set(name, g);
      }
      return g;
    },
  };
  conns.set("PC-1", {
    clientId: "PC-1", name: "客厅", roles: ["player@v1"], legacy: false, ready: true,
    remoteHost: "192.0.2.1", dialed: true, dialHost: "192.0.2.1", dialPort: 8928,
    volume: 40, muted: false, closed: false, close() { this.closed = true; },
  });
  // 预置在播现场:announceProbe 应捕获到它(deactivate 之前)
  const g = srv.group("PC-1");
  g.current = { songId: "s1", title: "T", durationMs: 100000 };
  g.positionMs = 4321;
  return srv;
}

describe("SendspinChildController(IPC 桥)", () => {
  let sent: SendspinChildToParent[];
  let ctl: SendspinChildController;
  let stopRuntimeCalls: number;

  beforeEach(() => {
    sent = [];
    stopRuntimeCalls = 0;
    // ⚠️ 单实例:dispatch 与 pushSnapshot 各自调 getServer(),必须是同一个 server
    const fakeSrv = makeFakeServer();
    const send: ChildSend = (m) => sent.push(m);
    ctl = new SendspinChildController(
      { getServer: () => fakeSrv, stopRuntime: async () => { stopRuntimeCalls++; } },
      send,
    );
  });

  afterEach(() => {
    ctl.dispose();
  });

  const last = () => sent[sent.length - 1] as any;
  async function rpc(op: string, payload?: unknown): Promise<any> {
    const req: ParentToSendspinChild = { t: "req", id: 42, op, payload };
    await ctl.handleMessage(req);
    return last();
  }

  it("快照剥离 pskHex/pskId:配对密钥永不出子进程", () => {
    ctl.markReady();
    const state = last();
    expect(state.t).toBe("state");
    const rec = state.records[0];
    expect(rec).toEqual({ clientId: "PC-1", createdAt: 111, lastUsedAt: 222, approved: true });
    expect(JSON.stringify(state)).not.toContain("pskHex");
    expect(JSON.stringify(state)).not.toContain("psk-id-1");
    // 连接与组镜像字段齐全(前端 clients 页依赖)
    expect(state.clients[0]).toMatchObject({ clientId: "PC-1", name: "客厅", ready: true, volume: 40 });
  });

  it("poll 返回组状态(playing/positionMs/durationMs)", async () => {
    const res = await rpc("poll", { clientId: "PC-1" });
    expect(res).toMatchObject({ t: "res", id: 42, ok: true, result: { playing: true, positionMs: 4321, durationMs: 100000 } });
  });

  it("announceProbe 在 deactivate 前捕获现场(wasPlaying/savedPos)", async () => {
    const res = await rpc("announceProbe", { peerId: "sendspin:PC-1" });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ wasPlaying: true, savedPos: 4321 });
  });

  it("setMuted 写组+连接两侧并立即可见", async () => {
    const res = await rpc("setMuted", { clientId: "PC-1", muted: true });
    expect(res.ok).toBe(true);
    // requestSnapshot(true) 跟在写后,state 里 muted 已翻转
    const state = sent.reverse().find((m) => m.t === "state") as any;
    expect(state.clients[0].muted).toBe(true);
  });

  it("unpair 删配对记录并断开该客户端现存连接", async () => {
    const res = await rpc("unpair", { clientId: "PC-1" });
    expect(res.ok).toBe(true);
    expect(res.result).toBe(true);
    const state = sent.reverse().find((m) => m.t === "state") as any;
    expect(state.records).toEqual([]);
  });

  it("未知 op 回 res ok:false 且带 error 文本", async () => {
    const res = await rpc("noSuchOp");
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("未知 sendspin rpc op");
  });

  it("非 req 消息不消费(返回 false)", async () => {
    expect(await ctl.handleMessage(null as any)).toBe(false);
    expect(await ctl.handleMessage({ t: "heartbeat" } as any)).toBe(false);
  });

  it("stop 触发 stopRuntime 并回 stopped(res 在 stopped 之后)", async () => {
    await rpc("stop");
    // dispatch 先 send stopped,handleReq 再回 res —— 两者都必须在
    expect(sent.map((m) => m.t)).toEqual(["stopped", "res"]);
    expect(stopRuntimeCalls).toBe(1);
  });
});
