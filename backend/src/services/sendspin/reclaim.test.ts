// sendspin 内存回收:组空即停 pump + 关编码器(杀 ffmpeg),pcm 释放;
// idle reclaimer 兜底 sweep 上报。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import {
  setSendspinIdentityDir,
  startSendspinService,
  stopSendspinService,
  getSendspinServer,
  reclaimSendspinOrphans,
} from "./index.js";
import { pumpFor, overridePumpSource } from "./streamEngine.js";
// 注意:必须静态导入 peer(与 legacy.test.ts 同式),否则 afterAll 里动态
// 导入 player/index 会与 sendspin/protocolPlayer 的循环卡死(vite-node)。
import { getPeerManager } from "../peer.js";

const PORT = 18936;
const URL = `ws://127.0.0.1:${PORT}/sendspin`;
const CID = "RECLAIM-E2E-1";

async function waitFor(fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function connectLegacy(clientId: string, name: string): Promise<WebSocket> {
  const ws = new WebSocket(URL);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no hello")), 5000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "client/hello", payload: { client_id: clientId, name, version: 1, supported_roles: ["player@v1"] } })));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        if (JSON.parse(data.toString("utf8"))?.type === "server/hello") { clearTimeout(timer); resolve(); }
      } catch { /* ignore */ }
    });
    ws.on("error", reject);
  });
  return ws;
}

function procDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe("sendspin 内存回收", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-reclaim-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
    overridePumpSource(async () => ({ pcm: new Float32Array(48000 * 2 * 30), durationMs: 30000 }));
  }, 60000);

  afterAll(async () => {
    overridePumpSource(null);
    await stopSendspinService();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("最后一个成员离开:停 pump + 放 pcm + 关编码器杀 ffmpeg + 摘组", async () => {
    const srv = getSendspinServer()!;
    const ws = await connectLegacy(CID, "reclaim-test");
    try {
      await waitFor(() => !!srv.clients.get(CID), 5000, "legacy conn");
      const conn = srv.clients.get(CID)!;
      const g = srv.group(CID);
      conn.group = g;
      g.add(conn);
      // 起 pump(30s 静音) + 建一个 flac 编码器
      // ⚠️ 2026-09-17:flac 编码器已从「常驻 ffmpeg 子进程」改为**进程内 libFLAC**
      //   (`LibFlacEncoder`),不再有 `p.pid` 可查。回收断言相应改为
      //   「编码器 `closed` 标志被置位」(等价语义:资源已释放)。
      const pump = pumpFor(srv, g);
      const enc: any = g.encoderFor({ clientId: CID, codec: "flac" } as any);
      expect(enc.closed).toBe(false);
      await pump.play("reclaim-song");
      await waitFor(() => pump.active, 5000, "pump 起播");
      expect((pump as any).pcm).not.toBeNull();

      ws.terminate();
      await waitFor(() => !srv.groups.has(CID), 8000, "组摘除");
      // pump 停了,pcm 放了,编码器关了
      expect(pump.active).toBe(false);
      expect((pump as any).pcm).toBeNull();
      expect(enc.closed).toBe(true);
    } finally {
      try { ws.terminate(); } catch { /* ignore */ }
    }
  }, 60000);

  it("reclaim 兜底 sweep:清无成员组并上报", async () => {
    const srv = getSendspinServer()!;
    const g = srv.group("SWEEP-EMPTY-1");
    g.encoderFor({ clientId: "SWEEP-EMPTY-1", codec: "flac" } as any);
    expect(srv.groups.has("SWEEP-EMPTY-1")).toBe(true);
    const report = reclaimSendspinOrphans();
    expect(report).toMatch(/1空组/);
    expect(srv.groups.has("SWEEP-EMPTY-1")).toBe(false);
  }, 30000);
});
