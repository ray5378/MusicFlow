// 服务端主动拨号 e2e:测试服拨监听模式 9.x 客户端(:18931)。
// dial → client/init → Noise → hello/activate → peer 注册(名=hello 名)。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { setSendspinIdentityDir, startSendspinService, stopSendspinService, getSendspinServer } from "./index.js";
import { getPeerManager } from "../peer.js";

const PORT = 18930;
const LISTEN_PORT = 18931;
const PY = process.env.MF_SENDSPIN_E2E_PY || "/tmp/opencode/sendspin-venv/bin/python";
const SIM = "/tmp/opencode/mf-listen-player.py";

async function waitFor(fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("sendspin 服务端拨号 e2e", () => {
  let tmpDir: string;
  let child: ChildProcess | null = null;
  let clientId = "";

  beforeAll(async () => {
    if (!fs.existsSync(PY) || !fs.existsSync(SIM)) {
      console.warn("skip: python sim 不可用");
      return;
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-dial-e2e-"));
    setSendspinIdentityDir(tmpDir);
    await startSendspinService(PORT);
    child = spawn(PY, ["-u", SIM, String(LISTEN_PORT), "MF-Listen-Speaker"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d: Buffer) => {
      const m = /client_id=([A-Za-z0-9_-]{43})/.exec(d.toString());
      if (m) clientId = m[1];
    });
    child.stderr?.on("data", () => {});
    await waitFor(() => clientId.length === 43, 30000, "listener sim 上线");
  }, 60000);

  afterAll(async () => {
    try { child?.kill("SIGKILL"); } catch { /* ignore */ }
    await stopSendspinService();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dial → 激活 → peer 注册", async () => {
    if (!child) return;
    const srv = getSendspinServer()!;
    const conn = await srv.dialPlayer(`ws://127.0.0.1:${LISTEN_PORT}/sendspin`);
    expect(conn.clientId).toBe(clientId);
    expect(conn.legacy).toBe(false);
    await waitFor(() => {
      const p = getPeerManager().get(`sendspin:${clientId}`);
      return !!p && p.available === true;
    }, 15000, "等 peer 注册");
    const peer = getPeerManager().get(`sendspin:${clientId}`)!;
    expect(peer.name).toBe("MF-Listen-Speaker");
    expect(peer.unencrypted).toBeUndefined();
  }, 120000);

  it("dial 不存在的端口报错", async () => {
    if (!child) return;
    const srv = getSendspinServer()!;
    await expect(srv.dialPlayer("ws://127.0.0.1:18939/sendspin", 3000)).rejects.toThrow();
  }, 30000);
});
