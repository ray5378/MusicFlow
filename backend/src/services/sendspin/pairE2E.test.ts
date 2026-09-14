// 真机配对 e2e:官方 aiosendspin 9.x 客户端走 static 静态码全流程。
//
// 链路:测试服(18928) ← 9.x sim(静态 PIN=12345678,窗口已开)
//   REST→start(static) → pair-init → REST→code → PAKE → finalize → 落盘 →
//   re-handshake 切长 PSK → playback 激活。
// 需要本机 python 3.12 + aiosendspin(见 /tmp/opencode/sendspin-venv);缺失则跳过。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer } from "./index.js";
import { getPeerManager } from "../peer.js";

const PORT = 18928;
const PY = process.env.MF_SENDSPIN_E2E_PY || "/tmp/opencode/sendspin-venv/bin/python";
const SIM = path.join(import.meta.dirname, "..", "..", "..", "scripts", "sendspin-sim-player.py");
const PIN = "12345678";

async function waitFor(fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("sendspin static 配对真机 e2e", () => {
  let tmpDir: string;
  let child: ChildProcess | null = null;
  let clientId = "";

  beforeAll(async () => {
    if (!fs.existsSync(PY) || !fs.existsSync(SIM)) {
      console.warn("skip: python sim 不可用");
      return;
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-pair-e2e-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
    child = spawn(PY, ["-u", SIM, `ws://127.0.0.1:${PORT}/sendspin`, PIN], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d: Buffer) => {
      const m = /client_id=([A-Za-z0-9_-]{43})/.exec(d.toString());
      if (m) clientId = m[1];
    });
    child.stderr?.on("data", () => {});
    await waitFor(() => clientId.length === 43, 30000, "sim 上线");
    const srv = getSendspinServer()!;
    await waitFor(() => !!srv.clients.get(clientId), 15000, "server 建连");
  }, 60000);

  afterAll(async () => {
    try { child?.kill("SIGKILL"); } catch { /* ignore */ }
    await stopSendspinService();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("static 码配对 → 落盘 → re-handshake 切长 PSK → peer 激活", async () => {
    if (!child) return; // 环境缺 sim,跳过
    const srv = getSendspinServer()!;
    expect(srv.pairing).toBeTruthy();
    await srv.pairing!.start(clientId, "static_pairing_code");
    await waitFor(() => srv.pairing!.getAttempt(clientId)?.state === "await_code", 30000, "等 pair-init");
    await srv.pairing!.enterCode(clientId, PIN);
    await waitFor(() => !!srv.pairingStore?.getRecord(clientId), 60000, "等配对落盘");
    const rec = srv.pairingStore!.getRecord(clientId)!;
    expect(rec.pskHex).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.pskId.length).toBe(43);
    // re-handshake 已切长 PSK 会话
    await waitFor(() => srv.clients.get(clientId)?.handshakePskCategory === "lt", 30000, "等 re-handshake");
    // peer 注册(名=hello 名)
    await waitFor(() => {
      const p = getPeerManager().get(`sendspin:${clientId}`);
      return !!p && p.available === true;
    }, 15000, "等 peer 注册");
    const peer = getPeerManager().get(`sendspin:${clientId}`)!;
    expect(peer.name).toBe("MF-Test-Speaker");
    expect(srv.pairing!.getAttempt(clientId)).toBeUndefined();
  }, 150000);
});
