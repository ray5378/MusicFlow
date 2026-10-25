/** 【QA 出口判据④】落盘复核:48k s16le 1kHz 正弦(5s,音乐性信号非直流)→
 *  BridgeServer 落盘模式(raop → 44.1k 重采样)→ 独立校验输出文件:
 *    - 时长 ≈ 输入时长(±0.5%)→ 等效采样率 44100(±0.5%);
 *    - RMS > -40dBFS(非静音);
 *    - 过零率反推频率 ≈ 1kHz(±5%,证明是音乐性信号而非直流/噪声)。
 *  用法:node --import tsx scripts/qa-dump-check.ts [dumpPath]
 */
import { readFileSync, rmSync } from "node:fs";

import { bridgeSocketPath } from "../src/services/airplay/bridgeChannel.js";
import { BridgeServer } from "../src/services/airplay/bridgeServer.js";
import { BridgeMember } from "../src/services/sendspin/bridgeMember.js";

const deviceId = "qa-dump";
const token = "qa-dump";
const dumpPath = process.argv[2] ?? "/workspace/qa_dump_44k.pcm";
const SECONDS = 5;
const IN_RATE = 48000;
const FREQ = 1000;
const AMP = 20000;

async function until(cond: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

try { rmSync(dumpPath, { force: true }); } catch { /* 忽略 */ }

const server = new BridgeServer(
  { deviceId, token, protocol: "raop", dumpPath },
  { log: () => { /* 静默 */ } },
);
await server.listen(bridgeSocketPath(deviceId, token));

const member = new BridgeMember({ deviceId, socketPath: bridgeSocketPath(deviceId, token), token, protocol: "raop" });
member.start();
await until(() => member.source.state === "live", "live");

// 5s 1kHz 正弦,100ms/帧(19200B),共 50 帧
const totalSampleFrames = IN_RATE * SECONDS;
const perFrame = 4800;
let pushed = 0;
for (let off = 0; off < totalSampleFrames; off += perFrame) {
  const n = Math.min(perFrame, totalSampleFrames - off);
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * FREQ * (off + i)) / IN_RATE) * AMP);
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  member.pushAudio(buf, BigInt(Math.round((off / IN_RATE) * 1e6)));
  pushed++;
}
await until(() => server.stats().framesReceived >= pushed + 1, "all audio frames received"); // +1 = CONFIG
await new Promise((r) => setTimeout(r, 300)); // 等写盘缓冲

member.stop();
await server.close();

// ── 独立校验(纯手工解析,不依赖任何桥接代码)──
const data = readFileSync(dumpPath);
const sampleFrames = Math.floor(data.length / 4); // s16le 立体声
const durationSec = sampleFrames / 44100;
const expectedSec = totalSampleFrames / IN_RATE;
let sumSq = 0;
let crossings = 0;
let prev = 0;
for (let i = 0; i < sampleFrames; i++) {
  const v = data.readInt16LE(i * 4);
  sumSq += v * v;
  if ((v >= 0) !== (prev >= 0)) crossings++;
  prev = v;
}
const rms = Math.sqrt(sumSq / sampleFrames);
const rmsDbfs = 20 * Math.log10(rms / 32768);
const freqEst = crossings / 2 / durationSec;

const verdict = {
  fileBytes: data.length,
  sampleFrames,
  durationSec: Number(durationSec.toFixed(4)),
  durationErrorPct: Number((Math.abs(durationSec - expectedSec) / expectedSec * 100).toFixed(3)),
  equivalentRate: Math.round(sampleFrames / expectedSec),
  rmsDbfs: Number(rmsDbfs.toFixed(2)),
  freqEstHz: Number(freqEst.toFixed(1)),
  checks: {
    durationWithin05pct: Math.abs(durationSec - expectedSec) / expectedSec <= 0.005,
    rmsAboveMinus40dBFS: rmsDbfs > -40,
    freqNear1kHz: Math.abs(freqEst - FREQ) / FREQ <= 0.05,
  },
};
verdict.checks;
console.log(JSON.stringify(verdict, null, 2));
const pass = Object.values(verdict.checks).every(Boolean);
console.log(pass ? "QA-DUMP-CHECK: PASS" : "QA-DUMP-CHECK: FAIL");
process.exit(pass ? 0 : 1);
