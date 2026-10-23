// ==================== AP2 配对(pair-setup,HAP/SRP 交给二进制)====================
//
// 我们**不实现** SRP/Curve25519/ChaCha20 —— cliairplay 自己做 HAP pair-setup:
//   1. spawn `cliairplay --pair-setup <ip> --port <p> --dacp <id>`;
//      二进制随即 POST /pair-pin-start,设备屏幕显示 4 位 PIN;
//   2. 我们把用户输入的 PIN 写进进程 stdin;
//   3. 二进制完成 SRP 交换,stdout 打印 `CREDENTIALS: <192 hex>`,退出码 0。
//
// 之后推流带 `--auth <凭据>` 走 pair-verify。**DACP ID 必须与配对时一致**
// (pairing identity 由它派生),所以两边都用 `deriveDacpId(deviceId)`。
//
// 为什么要两段式 HTTP:第一步只是"让设备显示 PIN",要等用户看屏幕;第二步才拿凭据。
// 做成一个同步接口的话,路由会被用户的思考时间占住(PIN 超时 60s),所以这里存会话。
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { createLogger } from "../../../utils/logger.js";
import { deriveDacpId } from "./cliSink.js";
import { checkCliBinary } from "./binary.js";

const log = createLogger("AIRPLAY-AP2");

/** 等凭据的上限(README:SRP 交换超时为 60s)。 */
const PAIR_TIMEOUT_MS = 60_000;
/** 会话从 spawn 起算的总寿命:超过就回收(防止用户关掉弹窗后进程常驻)。 */
const SESSION_TTL_MS = 5 * 60_000;

export interface PairStartResult {
  sessionId: string;
  /** 提示文案(前端直接展示):设备应已显示 PIN。 */
  hint: string;
}

export interface PairSubmitResult {
  credentials: string;
}

interface PairSession {
  id: string;
  deviceId: string;
  proc: ChildProcess;
  createdAt: number;
  /** stdout 累积(按行解析 CREDENTIALS)。 */
  stdoutBuf: string;
  stderrTail: string[];
  /** 凭据解析完成的 await 句柄。 */
  waiter: { resolve: (v: string) => void; reject: (e: Error) => void } | null;
  finished: boolean;
}

const sessions = new Map<string, PairSession>();

function cleanup(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { s.proc.kill("SIGKILL"); } catch { /* ignore */ }
}

/** 起一次配对会话:设备随即显示 PIN。 */
export function startPairSetup(deviceId: string, host: string, port: number): PairStartResult {
  const bin = checkCliBinary();
  if (!bin) throw new Error("cliairplay 不可用,无法进行 AP2 配对");

  // 同一设备重复发起:先收掉旧会话(旧 PIN 已失效,不能两条进程抢同一设备)。
  for (const [id, s] of sessions) if (s.deviceId === deviceId) cleanup(id);

  const id = randomUUID();
  const args = ["--pair-setup", host, "--port", String(port || 7000), "--dacp", deriveDacpId(deviceId)];
  log.info(`[ap2-pair] 起配对会话 device=${deviceId} host=${host}:${port}`);
  const proc = spawn(bin.path, args, { stdio: ["pipe", "pipe", "pipe"] });
  const sess: PairSession = {
    id,
    deviceId,
    proc,
    createdAt: Date.now(),
    stdoutBuf: "",
    stderrTail: [],
    waiter: null,
    finished: false,
  };
  sessions.set(id, sess);

  // 设备显示 PIN 后,进程就在等 stdin;这里只负责把凭据/错误捞出来。
  proc.stdout?.on("data", (c: Buffer) => {
    sess.stdoutBuf += c.toString("utf8");
    let idx: number;
    while ((idx = sess.stdoutBuf.indexOf("\n")) >= 0) {
      const line = sess.stdoutBuf.slice(0, idx).trim();
      sess.stdoutBuf = sess.stdoutBuf.slice(idx + 1);
      if (line.startsWith("CREDENTIALS:")) {
        const creds = line.split(":", 2)[1]?.trim() ?? "";
        sess.finished = true;
        if (creds.length === 192) sess.waiter?.resolve(creds);
        else sess.waiter?.reject(new Error(`配对产出的凭据长度非法(${creds.length},应为 192)`));
      }
    }
  });
  proc.stderr?.on("data", (c: Buffer) => {
    for (const line of c.toString("utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      sess.stderrTail.push(t);
      if (sess.stderrTail.length > 30) sess.stderrTail.shift();
      if (t.includes("[STATUS]")) log.info(`[ap2-pair] ${t.replace(/^\[STATUS\]\s*/, "")}`);
    }
  });
  proc.once("exit", (code) => {
    if (!sess.finished) {
      const tail = sess.stderrTail.slice(-4).join(" | ");
      sess.waiter?.reject(new Error(`配对进程退出 code=${code}${tail ? `: ${tail}` : ""}`));
    }
    // 退出后保留几秒让 submitPin 拿到已有结果,再回收。
    setTimeout(() => cleanup(id), 5_000).unref?.();
  });
  proc.once("error", (e) => {
    sess.waiter?.reject(new Error(`配对进程启动失败: ${e.message}`));
    cleanup(id);
  });

  // TTL 兜底:用户关掉弹窗就再也不回来,进程必须自己收。
  const ttl = setTimeout(() => {
    if (sessions.has(id)) {
      log.warn(`[ap2-pair] 会话 ${id} 超过 ${SESSION_TTL_MS / 1000}s 未完成,回收`);
      cleanup(id);
    }
  }, SESSION_TTL_MS);
  ttl.unref?.();

  return { sessionId: id, hint: "设备屏幕上应已显示 4 位 PIN,请在 60 秒内输入" };
}

/** 提交 PIN,拿 192 hex 凭据。 */
export function submitPairPin(sessionId: string, pin: string): Promise<PairSubmitResult> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("配对会话不存在或已超时,请重新发起");
  const clean = String(pin || "").replace(/\s+/g, "");
  if (!/^\d{4}$/.test(clean)) throw new Error("PIN 必须是 4 位数字");

  return new Promise<PairSubmitResult>((resolve, reject) => {
    let settled = false;
    const done = (creds: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.info(`[ap2-pair] 设备 ${s.deviceId} 配对成功(${creds.length} hex)`);
      resolve({ credentials: creds });
    };
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.warn(`[ap2-pair] 设备 ${s.deviceId} 配对失败: ${e.message}`);
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error(`配对超时(${PAIR_TIMEOUT_MS / 1000}s),请重试`)), PAIR_TIMEOUT_MS);
    timer.unref?.();

    s.waiter = { resolve: done, reject: fail };
    try {
      s.proc.stdin?.write(`${clean}\n`);
    } catch (e: any) {
      fail(new Error(`PIN 写入配对进程失败: ${e?.message || e}`));
    }
  });
}

/** 取消/回收一个配对会话(前端关弹窗时)。 */
export function cancelPairSetup(sessionId: string): void {
  cleanup(sessionId);
}

/** 进程退出清理(airplay 子进程停止时调用)。 */
export function cancelAllPairing(): void {
  for (const id of [...sessions.keys()]) cleanup(id);
}
