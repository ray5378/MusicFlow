// 切歌「空转 stopped」修复回归守卫(2026-10)。
//
// 真机事故:Sendspin 群组在线播放器「下一曲/切歌后无声」。设备(ESPHome)日志:
//   服务端每次切歌对同一成员发 `group/update -> stopped` 后 **亚毫秒** 发 `playing`,
//   设备把这个 stopped 镜像成组播放器 IDLE;随后 playing 不足以把它拉回 →
//   卡成「实体 PLAYING + 流已 ended」= 无声(输入侧仍在按实时解码,即 11.72 块/秒)。
//
// 修复:切歌/借流这类「紧邻 playing」的过渡,`finishPlayback` 走 `silentState` ——
//   只发 `stream/end` 收尾旧流,**不发 group/update(stopped)**。
//   终态停止(曲终/stop)行为不变(仍发 stopped)。
//
// 本文件断言**同一成员的消息序**:切歌窗口内不得出现 `group/update{stopped}`
//   紧跟 `group/update{playing}`(同组)。用真服务 + 明文(legacy)客户端直接抓文本帧。
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer } from "./index.js";
import { playGroupCore, sendspinGroupName } from "./playerCore.js";
import { overridePumpSource } from "./streamEngine.js";

const PORT = 18947;
const URL = `ws://127.0.0.1:${PORT}/sendspin`;
const GNAME = sendspinGroupName("UT-TRACKCHANGE-1");

function connectHello(clientId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } reject(new Error("no server/hello")); }, 5000);
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
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    try { texts.push(JSON.parse(data.toString("utf8"))); } catch { /* ignore */ }
  });
  return { texts };
}

describe("切歌消息序:stopped 不得紧跟 playing(空转 stopped 修复)", () => {
  let tmpDir: string;
  const savedKeep = process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY;

  beforeAll(async () => {
    // 强制走**非 keep_stream 回退路径**(= 修复前恰好会发 stopped 的那条;真机即走此路)
    process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY = "0";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-tc-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
    // 30s 正弦(FLAC 首块 4096 样本 ≈ 85ms,必出帧 → 能观测到 stream/start)
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
    if (savedKeep === undefined) delete process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY;
    else process.env.MUSICFLOW_SENDSPIN_KEEP_STREAM_LEGACY = savedKeep;
  });

  afterEach(() => {
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

  it("切歌窗口内不出现 group/update{stopped}(更不得紧跟 playing)", async () => {
    const srv = getSendspinServer()!;
    const ws = await connectHello("TC-1");
    const c = collect(ws);
    try {
      await waitFor(() => !!srv.clients.get("TC-1"), 5000, "conn");

      // 第一曲:起播并等首帧(让 conn 成为组内成员、g.current 就位)
      playGroupCore(srv, GNAME, ["TC-1"], { songId: "tc-1", title: "t", duration: 30 } as any);
      await waitFor(() => c.texts.some((t) => t?.type === "stream/start"), 15000, "曲1 stream/start");

      // 自证确实走的是**非 keep_stream 回退路径**(否则本用例无判别意义)
      expect(srv.group(GNAME).canKeepStream()).toBe(false);

      // 切歌窗口起点
      const from = c.texts.length;
      playGroupCore(srv, GNAME, ["TC-1"], { songId: "tc-2", title: "t", duration: 30 } as any);

      // 等切歌后的 playing 出现(组状态先行)
      await waitFor(
        () => c.texts.slice(from).some((t) => t?.type === "group/update" && t?.payload?.playback_state === "playing"),
        8000,
        "曲2 playing",
      );

      const updates = c.texts
        .slice(from)
        .filter((t) => t?.type === "group/update")
        .map((t) => t.payload?.playback_state);

      // 修复后:切歌过渡不再发 stopped(旧实现恰好发 1 次 stopped,且紧跟 playing)
      expect(updates).not.toContain("stopped");
      // 兜底不变量:任何相邻对都不得是 stopped -> playing
      for (let i = 0; i < updates.length - 1; i++) {
        expect(`${updates[i]}->${updates[i + 1]}`).not.toBe("stopped->playing");
      }
      // 旧流收尾仍保留:切歌确实发了 stream/end(仅去掉了 group/update(stopped))
      expect(c.texts.slice(from).some((t) => t?.type === "stream/end")).toBe(true);
      // 且确实发了 playing(否则上面的"不得出现 stopped"会因空窗口而假绿)
      expect(updates).toContain("playing");
    } finally {
      ws.terminate();
    }
  }, 60_000);
});
