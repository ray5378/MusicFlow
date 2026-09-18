// 拨号目标持久化 + 重启重拨:记住的目标落盘,服务重启自动拨回。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  setSendspinIdentityDir,
  startSendspinService,
  stopSendspinService,
  getSendspinServer,
  rememberDialTarget,
  forgetDialTarget,
  listDialTargets,
} from "./index.js";
import { getPeerManager } from "../peer.js";

const PORT = 18932;
const LISTEN_PORT = 18933;
const PY = process.env.MF_SENDSPIN_E2E_PY || "/tmp/opencode/sendspin-venv/bin/python";
const SIM = path.join(import.meta.dirname, "..", "..", "..", "scripts", "sendspin-sim-listener.py");

async function waitFor(fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function peerPresent(): boolean {
  return getPeerManager().list().some((p) => p.kind === "sendspin" && p.available);
}

describe("sendspin 拨号目标持久化", () => {
  let tmpDir: string;
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    if (!fs.existsSync(PY) || !fs.existsSync(SIM)) {
      console.warn("skip: python sim 不可用");
      return;
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sendspin-remember-"));
    setSendspinIdentityDir(tmpDir);
    child = spawn(PY, ["-u", SIM, String(LISTEN_PORT), "Remember-Speaker"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr?.on("data", () => {});
    // 等 listener 端口拉起
    await new Promise((r) => setTimeout(r, 3000));
  }, 60000);

  afterAll(async () => {
    try { child?.kill("SIGKILL"); } catch { /* ignore */ }
    await stopSendspinService();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("remember → 落盘 → 重启服务自动重拨;forget 清掉", async () => {
    if (!child) return;
    await rememberDialTarget("127.0.0.1", LISTEN_PORT);
    expect(await listDialTargets()).toEqual([
      expect.objectContaining({ host: "127.0.0.1", port: LISTEN_PORT }),
    ]);
    // 幂等:重复记住不翻倍
    await rememberDialTarget("127.0.0.1", LISTEN_PORT);
    expect((await listDialTargets()).length).toBe(1);

    await startSendspinService(PORT);
    // 启动即拨(后台):peer 出现
    await waitFor(peerPresent, 30000, "等开机重拨");
    const srv = getSendspinServer()!;
    const peer = getPeerManager().list().find((p) => p.kind === "sendspin" && p.available)!;
    expect(peer.name).toBe("Remember-Speaker");

    // 文件落盘验证
    const file = JSON.parse(fs.readFileSync(path.join(tmpDir, "sendspin", "dial_targets.json"), "utf8"));
    const arr = Array.isArray(file) ? file : file.targets;
    expect(arr.some((t: any) => t.host === "127.0.0.1" && t.port === LISTEN_PORT)).toBe(true);

    // forget:删记录 + 断开在线连接
    expect(await forgetDialTarget("127.0.0.1", LISTEN_PORT)).toBe(true);
    expect((await listDialTargets()).length).toBe(0);
    await waitFor(() => !peerPresent(), 15000, "等忘掉后断开");
    expect(await forgetDialTarget("127.0.0.1", LISTEN_PORT)).toBe(false);
    void srv;
  }, 120000);
});
