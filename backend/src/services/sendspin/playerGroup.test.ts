// 用户组多房间:共享组＋单 pump 同一时间线推 N 成员。
// 真服务＋legacy 明文客户端,+注入微缩 PCM,不碰网络曲库。
// 断言:双成员首帧同 ts(同步契约)＋直播沿加入/摘除。
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer } from "./index.js";
import { playGroupCore, joinGroupCore, leaveGroupCore, sendspinGroupName } from "./playerCore.js";
import { overridePumpSource } from "./streamEngine.js";

const PORT = 18941;
const URL = `ws://127.0.0.1:${PORT}/sendspin`;
const GNAME = sendspinGroupName("UT-GROUP-1");

function connectHello(clientId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error("no server/hello")); }, 5000);
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    ws.on("open", () => ws.send(JSON.stringify({
      type: "client/hello",
      payload: { client_id: clientId, name: clientId, version: 1, supported_roles: ["player@v1"] },
    })));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        if (JSON.parse(data.toString("utf8"))?.type === "server/hello") { clearTimeout(timer); resolve(ws); }
      } catch { /* ignore */ }
    });
  });
}

async function waitFor(fn: () => boolean, ms = 8000, what = ""): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function collect(ws: WebSocket) {
  const texts: any[] = [];
  const binaries: Buffer[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) binaries.push(Buffer.from(data as Buffer));
    else {
      try { texts.push(JSON.parse(data.toString("utf8"))); } catch { /* ignore */ }
    }
  });
  return { texts, binaries };
}

const firstAudioTs = (binaries: Buffer[]): bigint | null => {
  const f = binaries.find((b) => b.length > 9 && b[0] === 0x04);
  return f ? f.readBigInt64BE(1) : null;
};

describe("sendspin 用户组多房间", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-group-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
    // 30s 正弦(预填充灌满后仍按实时推,播中加入才能收到直播帧)(FLAC 首块 4096 样本 ≈ 85ms,必出帧)
    const rate = 48000;
    const n = rate * 30;
    const pcm = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const v = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
      pcm[i * 2] = v; pcm[i * 2 + 1] = v;
    }
    overridePumpSource(async () => ({ pcm, durationMs: 30000 }));
  }, 60_000);

  afterAll(async () => {
    await stopSendspinService();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    // 组状态跨用例清理(同进程内复用 server)
    const srv = getSendspinServer();
    if (srv) {
      for (const g of [...srv.groups.values()]) {
        try { g.finishPlayback(); } catch { /* ignore */ }
        g.members.clear();
        g.current = null;
        g.pendingAnnounces.length = 0;
      }
    }
  });

  it("双成员同 pump 首帧同 ts(同步契约)", async () => {
    const srv = getSendspinServer()!;
    const ws1 = await connectHello("GRP-G1");
    const ws2 = await connectHello("GRP-G2");
    const c1 = collect(ws1);
    const c2 = collect(ws2);
    try {
      await waitFor(() => !!srv.clients.get("GRP-G1") && !!srv.clients.get("GRP-G2"), 5000, "双 conn");
      playGroupCore(srv, GNAME, ["GRP-G1", "GRP-G2", "OFFLINE-NOBODY"], {
        songId: "g-song-1", title: "t", duration: 30,
      } as any);
      await waitFor(() => firstAudioTs(c1.binaries) !== null, 15000, "G1 首帧");
      await waitFor(() => firstAudioTs(c2.binaries) !== null, 15000, "G2 首帧");
      // 同一批首块同一 ts:多房间同步的最小契约
      expect(firstAudioTs(c1.binaries)).toBe(firstAudioTs(c2.binaries));
      // 离线成员被跳过,不影响在线成员
      expect(srv.group(GNAME).members.size).toBe(2);
    } finally {
      ws1.terminate(); ws2.terminate();
    }
  }, 60_000);

  it("空闲加入仅登记＋播中加入走直播沿＋摘除收 stream/end", async () => {
    const srv = getSendspinServer()!;
    const ws3 = await connectHello("GRP-G3");
    const c3 = collect(ws3);
    const ws4 = await connectHello("GRP-G4");
    const c4 = collect(ws4);
    try {
      await waitFor(() => !!srv.clients.get("GRP-G3") && !!srv.clients.get("GRP-G4"), 5000, "双 conn");
      // 空闲加入:登记但无流
      const r1 = joinGroupCore(srv, GNAME, "GRP-G3");
      expect(r1).toEqual({ joined: true, live: false });
      expect(c3.texts.some((m) => m?.type === "stream/start")).toBe(false);
      // 幂等
      expect(joinGroupCore(srv, GNAME, "GRP-G3").joined).toBe(false);
      // 离线 conn 拒绝
      expect(joinGroupCore(srv, GNAME, "NOBODY").joined).toBe(false);
      // 起播(G3 在组内 + G4 新起)
      playGroupCore(srv, GNAME, ["GRP-G3", "GRP-G4"], { songId: "g-song-2", title: "t", duration: 30 } as any);
      await waitFor(() => firstAudioTs(c4.binaries) !== null, 15000, "G4 首帧");
      // 播中摘除 G4:收到 stream/end,组内只剩 G3
      expect(leaveGroupCore(srv, GNAME, "GRP-G4")).toBe(true);
      await waitFor(() => c4.texts.some((m) => m?.type === "stream/end"), 5000, "G4 stream/end");
      expect([...srv.group(GNAME).members].map((c: any) => c.clientId).sort()).toEqual(["GRP-G3"]);
      // 摘不存在的返回 false
      expect(leaveGroupCore(srv, GNAME, "GRP-G4")).toBe(false);
    } finally {
      ws3.terminate(); ws4.terminate();
    }
  }, 60_000);

  it("播中加入从直播沿收帧(无需历史)", async () => {
    const srv = getSendspinServer()!;
    const ws5 = await connectHello("GRP-G5");
    const c5 = collect(ws5);
    const ws6 = await connectHello("GRP-G6");
    const c6 = collect(ws6);
    try {
      await waitFor(() => !!srv.clients.get("GRP-G5") && !!srv.clients.get("GRP-G6"), 5000, "双 conn");
      playGroupCore(srv, GNAME, ["GRP-G5"], { songId: "g-song-3", title: "t", duration: 30 } as any);
      await waitFor(() => firstAudioTs(c5.binaries) !== null, 15000, "G5 首帧");
      // G6 播中加入:live,立即拿 stream/start,随后收到直播帧
      const r = joinGroupCore(srv, GNAME, "GRP-G6");
      expect(r).toEqual({ joined: true, live: true });
      // ★ stream/start 必须**延后到该成员首块音频就绪**,不能在加入瞬间就发
      //   (2026-09-24 真机:FLAC 块编码器要攒满一块才吐首帧,先宣告会留下空窗,
      //    设备据此丢弃该流 → 播放中加入的新成员无声;PCM 首批即有产出故不受影响)。
      //   下面两句同步执行,推流循环没机会插入,判定是确定的。
      expect(c6.texts.some((m) => m?.type === "stream/start")).toBe(false);
      expect(srv.group(GNAME).pendingAnnounces.some((c: any) => c.clientId === "GRP-G6")).toBe(true);
      await waitFor(() => c6.texts.some((m) => m?.type === "stream/start"), 5000, "G6 stream/start");
      await waitFor(() => firstAudioTs(c6.binaries) !== null, 15000, "G6 直播帧");
      // 首帧(含空包被跳过的情形)之后:宣告必然已兑现且不再挂起,不会重复发第二份。
      expect(srv.group(GNAME).pendingAnnounces.some((c: any) => c.clientId === "GRP-G6")).toBe(false);
    } finally {
      ws5.terminate(); ws6.terminate();
    }
  }, 60_000);
});
