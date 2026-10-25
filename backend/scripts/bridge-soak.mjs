#!/usr/bin/env node
/** bridge-soak:Phase 2 出口判据 ③(RSS soak,QA 执行)。
 *
 *  起真 bridge server 子进程 + 发送端子进程(node --import tsx),按参数化时长/码率
 *  推 48k s16le PCM,周期采样两端进程 RSS,输出 CSV 行:
 *    t_sec,sender_rss_kb,server_rss_kb
 *  结束打印峰值汇总(exit 0)。判据:连续 192KB/s × 10min,RSS 增长 < 10MB。
 *
 *  用法(backend 目录):
 *    node scripts/bridge-soak.mjs [--duration-sec 600] [--bytes-per-sec 192000] [--interval-sec 10]
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
function argNum(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
}
const durationSec = argNum("duration-sec", 600);
const bytesPerSec = argNum("bytes-per-sec", 192_000); // 48k × s16le × 2ch
const intervalSec = Math.max(1, argNum("interval-sec", 10));

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, "..");
const childTs = path.join(here, "bridge-soak-child.ts");

const n = `${process.pid}`;
const socketPath = path.join(os.tmpdir(), `mfab-soak-${n}.sock`);
if (Buffer.byteLength(socketPath, "utf8") >= 100) {
  console.error(`socket path too long (${Buffer.byteLength(socketPath)}B): ${socketPath}`);
  process.exit(2);
}
const baseEnv = {
  ...process.env,
  MFAB_DEVICE_ID: `soak-${n}`,
  MFAB_TOKEN: `soak-${n}`,
  MFAB_SOCKET_PATH: socketPath,
  MFAB_PROTOCOL: "raop",
};

function rssKb(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+) kB/m);
    if (m) return Number(m[1]);
  } catch { /* /proc 不可用时跳过该采样点 */ }
  return null;
}

function die(msg) {
  console.error(`[bridge-soak] ${msg}`);
  process.exit(2);
}

// ① server 子进程
const server = spawn(process.execPath, ["--import", "tsx", childTs], {
  cwd: backendRoot,
  env: { ...baseEnv, MFAB_MODE: "server" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

// ② 等 server ready(listening)
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server not ready in 15s")), 15_000);
  server.stdout.on("data", (d) => {
    process.stdout.write(`[server] ${d}`);
    if (String(d).includes("ready")) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code})`)); });
});

ready.then(() => {
  // ③ sender 子进程
  const sender = spawn(process.execPath, ["--import", "tsx", childTs], {
    cwd: backendRoot,
    env: {
      ...baseEnv,
      MFAB_MODE: "sender",
      MFAB_BYTES_PER_SEC: String(bytesPerSec),
      MFAB_DURATION_MS: String(durationSec * 1000),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  sender.stderr.on("data", (d) => process.stderr.write(`[sender] ${d}`));
  sender.stdout.on("data", (d) => process.stdout.write(`[sender] ${d}`));

  console.log(`# bridge-soak duration=${durationSec}s bytesPerSec=${bytesPerSec} interval=${intervalSec}s`);
  console.log("t_sec,sender_rss_kb,server_rss_kb");

  const started = Date.now();
  let maxSender = 0;
  let maxServer = 0;
  let firstSender = null;
  let firstServer = null;
  const sampler = setInterval(() => {
    const t = Math.round((Date.now() - started) / 1000);
    const s = rssKb(sender.pid);
    const v = rssKb(server.pid);
    if (s !== null) { maxSender = Math.max(maxSender, s); if (firstSender === null) firstSender = s; }
    if (v !== null) { maxServer = Math.max(maxServer, v); if (firstServer === null) firstServer = v; }
    console.log(`${t},${s ?? ""},${v ?? ""}`);
    if (t >= durationSec) finish("duration reached");
  }, intervalSec * 1000);

  let done = false;
  function finish(reason) {
    if (done) return;
    done = true;
    clearInterval(sampler);
    const grow = (a, b) => (a === null || b === null ? "n/a" : `${b - a}kB`);
    console.log(`# summary reason=${reason}`);
    console.log(`# sender rss: first=${firstSender ?? "n/a"}kB max=${maxSender}kB growth=${grow(firstSender, maxSender)}`);
    console.log(`# server rss: first=${firstServer ?? "n/a"}kB max=${maxServer}kB growth=${grow(firstServer, maxServer)}`);
    console.log(`# criterion ③: growth < 10MB → ${grow(firstSender, maxSender) === "n/a" ? "UNKNOWN" : (maxSender - (firstSender ?? 0) < 10 * 1024 && maxServer - (firstServer ?? 0) < 10 * 1024 ? "PASS" : "FAIL")}`);
    try { sender.kill("SIGTERM"); } catch { /* 已退出 */ }
    try { server.kill("SIGTERM"); } catch { /* 已退出 */ }
    setTimeout(() => process.exit(0), 200);
  }
  sender.once("exit", (code) => finish(`sender exited (code=${code})`));
  server.once("exit", (code) => finish(`server exited (code=${code})`));
}, (err) => die(err instanceof Error ? err.message : String(err))).finally(() => {
  // ready promise reject 时确保 server 进程不悬挂
});
