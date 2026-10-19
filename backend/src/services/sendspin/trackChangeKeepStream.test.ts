// P2 门禁:切歌(track change)只发 `stream/clear`,绝不 `stream/end`。
//
// 依据(两处权威):
//  1. MA `providers/sendspin/player.py:1454` 注释原文:
//     "The spec reserves stream/end for queue-empty, not track changes."
//  2. MA `providers/sendspin/playback.py` `cancel(keep_stream=True)`
//     → `PushStream.clear()` + `ps.stop(keep_stream=True)`(清缓冲,流不结束)。
//
// 安全阀(同款):`playback.py:405-423` —— legacy/非合规客户端在场时强制
// `keep_stream=False`,因为它们可能错误处理 `stream/clear`。MusicFlow 同样:
// 组内任一 legacy 成员 → 整组退回 `stream/end` + stopped 旧路径。
//
// ⚠️ 2026-10-19 现场修正:上述安全阀依据的假设(legacy 客户端「可能」误处理
//   stream/clear)已被真机推翻 —— esp32-player2(legacy=true) 恰恰**需要**一条
//   `stream/clear` 来解「固件把 `group/update -> stopped` 镜像成组播放器 IDLE、
//   约 2s 内拒收 `stream/start`」的闩锁(用户拖动 seek 即刻出声即此因)。
//   故即便走 `KEEP_STREAM_LEGACY=0` 安全阀路径(旧流仍以 `stream/end` 收尾),
//   新流宣告前也会补发一条兜底 `stream/clear`(见 server.ts `flushAnnounceFor`)。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer } from "./index.js";
import { playCore } from "./playerCore.js";
import { overridePumpSource } from "./streamEngine.js";
import { SendspinGroup } from "./server.js";

const PORT = 18961;
const URL = `ws://127.0.0.1:${PORT}/sendspin`;

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

const hasAudio = (binaries: Buffer[]): boolean => binaries.some((b) => b.length > 9 && b[0] === 0x04);

/** 最小 group(不启真服务):只验证门禁与 clear 的下发内容。 */
function fakeGroup(): { g: SendspinGroup; sent: Map<string, string[]>; add: (id: string, legacy: boolean) => void } {
  const sent = new Map<string, string[]>();
  const g = new SendspinGroup("UT-KEEP", { log: () => {}, clients: new Map() } as any);
  const add = (id: string, legacy: boolean) => {
    const buf: string[] = [];
    sent.set(id, buf);
    g.members.add({
      clientId: id,
      legacy,
      sendJson: (t: string) => buf.push(t),
      sendGroupUpdate: () => buf.push("group/update"),
    } as any);
  };
  return { g, sent, add };
}

describe("sendspin 切歌 keep_stream(P2:stream/end 只留给队列空)", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-keepstream-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
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

  it("canKeepStream 门禁(严格档 KEEP_STREAM_LEGACY=0):空组/含 legacy 一律 false", () => {
    const prevEnv = process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY;
    process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY = "0";
    const a = fakeGroup();
    expect(a.g.canKeepStream()).toBe(false); // 空组
    a.add("M1", false);
    expect(a.g.canKeepStream()).toBe(true);
    a.add("M2", true); // 混入 legacy
    expect(a.g.canKeepStream()).toBe(false);
    if (prevEnv === undefined) delete process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY;
    else process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY = prevEnv;
  });

  it("实验态(默认放行):KEEP_STREAM_LEGACY 未设置时 legacy 成员也过门禁", () => {
    const prevEnv = process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY;
    delete process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY;
    const a = fakeGroup();
    a.add("M1", true); // 纯 legacy 组
    expect(a.g.canKeepStream()).toBe(true);
    if (prevEnv === undefined) delete process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY;
    else process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY = prevEnv;
  });

  it("clearPlayback:只发 stream/clear,不发 stream/end、不报 stopped", () => {
    const { g, sent, add } = fakeGroup();
    add("M1", false);
    add("M2", false);
    g.clearPlayback();
    for (const buf of sent.values()) {
      expect(buf).toContain("stream/clear");
      expect(buf).not.toContain("stream/end");
      // 组状态(playing)由起播侧负责,清缓冲这一步不得让设备看到 stopped。
      expect(buf).not.toContain("group/update");
    }
  });

  it("合规客户端切歌:只 stream/clear,绝不 stream/end", async () => {
    const srv = getSendspinServer()!;
    const ws = await connectHello("TC-OK");
    try {
      await waitFor(() => !!srv.clients.get("TC-OK"), 5000, "conn");
      const conn = srv.clients.get("TC-OK")!;
      // 明文 client/hello 直连 = legacy;这里显式声明为合规客户端,验证 keep_stream 主路径。
      conn.legacy = false;
      const sent: string[] = [];
      // 不真发(非 legacy 走加密帧,本连接没做 Noise 握手)—— 只验证 playCore 选路。
      conn.sendJson = ((type: string) => { sent.push(type); }) as any;

      const g = srv.group("TC-OK");
      // ① 首播:无 current → 完整重建(允许 stream/end 收尾)
      playCore(srv, "TC-OK", { songId: "tc-1", title: "t1", duration: 30 } as any);
      await waitFor(() => g.current?.songId === "tc-1", 8000, "首播 current");

      // ② 切歌:有旧曲在播 + 组过门禁 → 只清缓冲
      const mark = sent.length;
      playCore(srv, "TC-OK", { songId: "tc-2", title: "t2", duration: 30 } as any);
      const after = sent.slice(mark);
      expect(after).toContain("stream/clear");
      expect(after).not.toContain("stream/end");
    } finally {
      ws.terminate();
    }
  }, 30_000);

  it("legacy 客户端切歌:置 KEEP_STREAM_LEGACY=0 → 退回 stream/end,新流宣告前仍补发兜底 stream/clear", async () => {
    const prevEnv = process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY;
    process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY = "0"; // 回到 MA 同款严格安全阀
    const srv = getSendspinServer()!;
    const ws = await connectHello("TC-LEGACY");
    const c = collect(ws);
    try {
      await waitFor(() => !!srv.clients.get("TC-LEGACY"), 5000, "conn");
      const g = srv.group("TC-LEGACY");
      playCore(srv, "TC-LEGACY", { songId: "tl-1", title: "t1", duration: 30 } as any);
      await waitFor(() => hasAudio(c.binaries), 15000, "首帧");
      await waitFor(() => g.current?.songId === "tl-1", 8000, "首播 current");

      const mark = c.texts.length;
      playCore(srv, "TC-LEGACY", { songId: "tl-2", title: "t2", duration: 30 } as any);
      await waitFor(() => c.texts.slice(mark).some((m) => m?.type === "stream/end"), 8000, "legacy 切歌 stream/end");
      const after = c.texts.slice(mark).map((m) => m?.type);
      expect(after).toContain("stream/end");
      // ⚠️ 2026-10-19 真机实测修正:本用例原断言「安全阀下绝不发 stream/clear」,依据是
      // MA `playback.py:405-423` 的保守假设(legacy 客户端「可能」误处理 stream/clear)。
      // 真机 esp32-player2(legacy=true) 实测恰相反:它把 `group/update -> stopped` 镜像成
      // 组播放器 IDLE,约 2s 内不再接受 `stream/start`,必须靠一条与 start **紧邻**的
      // `stream/clear` 解闩锁。故兜底 clear **对 legacy 成员同样下发**,旧断言修正为
      // 「clear 只出现在 stream/end 之后、且紧邻 start 前」。
      expect(after).toContain("stream/clear");
      expect(after.indexOf("stream/end")).toBeLessThan(after.indexOf("stream/clear"));
    } finally {
      ws.terminate();
      if (prevEnv === undefined) delete process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY;
      else process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY = prevEnv;
    }
  }, 30_000);

  it("实验态(默认放行):legacy 客户端切歌同样只发 stream/clear", async () => {
    const prevEnv = process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY;
    delete process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY; // 未设置 = 放行 legacy
    const srv = getSendspinServer()!;
    const ws = await connectHello("TC-LEGACY-OPEN");
    const c = collect(ws);
    try {
      await waitFor(() => !!srv.clients.get("TC-LEGACY-OPEN"), 5000, "conn");
      const g = srv.group("TC-LEGACY-OPEN");
      playCore(srv, "TC-LEGACY-OPEN", { songId: "to-1", title: "t1", duration: 30 } as any);
      await waitFor(() => hasAudio(c.binaries), 15000, "首帧");
      await waitFor(() => g.current?.songId === "to-1", 8000, "首播 current");
      const mark = c.texts.length;
      playCore(srv, "TC-LEGACY-OPEN", { songId: "to-2", title: "t2", duration: 30 } as any);
      await waitFor(() => c.texts.slice(mark).some((m) => m?.type === "stream/clear"), 8000, "legacy 放行 stream/clear");
      const after = c.texts.slice(mark).map((m) => m?.type);
      expect(after).toContain("stream/clear");
      expect(after).not.toContain("stream/end");
    } finally {
      ws.terminate();
      if (prevEnv === undefined) delete process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY;
      else process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY = prevEnv;
    }
  }, 30_000);
});
// ---------------------------------------------------------------------------
// P3 兜底(过渡):新流宣告前必发 `stream/clear`(2026-10-19 真机实测)。
//
// 病灶场景:上一轮走的是 else 复位分支(自然曲终收尾,或 KEEP_STREAM_LEGACY=0 且组内
// 有 legacy 成员)→ 末态 `stream/end` + `group/update -> stopped`。真机固件把 stopped
// 镜像成组播放器 IDLE,约 2s 内不再接受 `stream/start`;而服务端把 start 绑在「首帧
// 产出」上,本地快源 0.15~1.0s 就出首帧 ⇒ start 太早被固件 `pending_start_` 吞掉
// ⇒ 报文链路全绿但无声,且坏态跨曲目持续。唯一解闩锁手段是一条与 start 紧邻的
// `stream/clear`(用户拖动 seek 能立刻出声即此因)。
//
// 这组用例只碰纯内存,不启服务:直接对 `flushAnnounceFor` 断言下发的**报文序**。
// ⚠️ 过渡语义:MA 对齐改造(自动切歌 keep_stream 连续化)落地后本组用例随之更新。
describe("P3 兜底:flushAnnounceFor 新流宣告前必发 stream/clear", () => {
  /** 造一个只记报文类型的成员(不启真连接:不握手、不编码)。 */
  function preclearMember(id: string, available = true) {
    const buf: string[] = [];
    const m: any = {
      clientId: id,
      legacy: true,
      clientWantsStream: () => available,
      sendJson: (t: string) => buf.push(t),
      sendGroupUpdate: () => buf.push("group/update"),
      announceStream: () => buf.push("stream/start"),
    };
    const g = new SendspinGroup("UT-PRECLEAR", { log: () => {}, clients: new Map() } as any);
    g.members.add(m);
    return { g, m, buf };
  }

  it("clear 必须紧邻在 start 之前(顺序不可倒置)", () => {
    const { g, m, buf } = preclearMember("M1");
    g.pendingAnnounces.push(m);
    g.flushAnnounceFor(m);
    expect(buf).toEqual(["stream/clear", "stream/start"]);
  });

  it("重复入队只兑现一次(去重后仍是一对 clear→start)", () => {
    const { g, m, buf } = preclearMember("M1");
    g.pendingAnnounces.push(m, m, m);
    g.flushAnnounceFor(m);
    expect(buf).toEqual(["stream/clear", "stream/start"]);
    expect(g.pendingAnnounces).toHaveLength(0);
  });

  it("设备明确报 available:false 时既不 clear 也不 start(条目留队重试)", () => {
    const { g, m, buf } = preclearMember("M1", false);
    g.pendingAnnounces.push(m);
    g.flushAnnounceFor(m);
    expect(buf).toEqual([]);
    expect(g.pendingAnnounces).toContain(m);
  });

  it("该成员不在待宣告队列时静默返回(不得凭空补 clear)", () => {
    const { g, m, buf } = preclearMember("M1");
    g.flushAnnounceFor(m);
    expect(buf).toEqual([]);
  });
});
