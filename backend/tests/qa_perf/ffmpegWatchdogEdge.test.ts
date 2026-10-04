// QA 独立验证 · B ffmpeg 出流看门狗边界(不依赖工程师测试)
//
// 直接驱动模块级注册表 + 对账器(不启动 setInterval),用真实子进程验证:
//   ① idle 边界:88s 不杀 / 92s 杀(工程师用 90s+1s,这里贴边强杀验证 <90s 不误杀);
//   ② 健康流(持续 stdout 字节)不被误杀;
//   ③ 正常结束自动注销且不再被对账器命中;
//   ④ 注册表计数与 kill 返回数一致。
import "../plugins/_env.js";

import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import {
  registerFfmpegPipe,
  reconcileFfmpegPipes,
  FFMPEG_IDLE_KILL_MS,
  FFMPEG_HARD_MAX_MS,
  _resetFfmpegPipesForTest,
  _ffmpegPipeCountForTest,
} from "../../src/routes/rest/index.js";

function spawnSilent(): any {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  return child;
}
function spawnChatty(): any {
  const child = spawn(process.execPath, ["-e", "setInterval(() => process.stdout.write('x'), 40)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.resume();
  return child;
}
function waitExit(child: any, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("B ffmpeg 看门狗边界", () => {
  afterEach(() => {
    _resetFfmpegPipesForTest();
  });

  it("常量符合设计:IDLE=90s / HARD_MAX=6h", () => {
    expect(FFMPEG_IDLE_KILL_MS).toBe(90_000);
    expect(FFMPEG_HARD_MAX_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("idle 边界:距最后字节 89s 不杀、91s 杀", async () => {
    const child = spawnSilent();
    registerFfmpegPipe(child, { source: "qa-idle-boundary" });
    const base = Date.now();
    expect(_ffmpegPipeCountForTest()).toBe(1);

    expect(reconcileFfmpegPipes(base + 89_000)).toBe(0); // 89s < 90s → 不杀
    expect(_ffmpegPipeCountForTest()).toBe(1);
    expect(child.exitCode).toBeNull();

    expect(reconcileFfmpegPipes(base + 91_000)).toBe(1); // 91s ≥ 90s → 强杀
    expect(_ffmpegPipeCountForTest()).toBe(0);
    expect(await waitExit(child)).toBe(true);
    // eslint-disable-next-line no-console
    console.log("[B] idle 边界:89s→0 kill, 91s→1 kill(进程确退出)");
  });

  it("健康流(持续 stdout 字节)永不被 idle 判据误杀", async () => {
    const child = spawnChatty();
    registerFfmpegPipe(child, { source: "qa-healthy" });
    await sleep(260);
    expect(reconcileFfmpegPipes()).toBe(0); // 距最近字节几十 ms ≪ 90s
    expect(_ffmpegPipeCountForTest()).toBe(1);
    expect(child.exitCode).toBeNull();
    // 再次真实对账:距 lastDataAt 仍在持续刷新 → 仍存活
    expect(reconcileFfmpegPipes()).toBe(0);
    expect(_ffmpegPipeCountForTest()).toBe(1);
  });

  it("正常结束:进程退出后自动注销,即便时钟拨到远超 6h 也不再命中", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('x'); process.exit(0)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerFfmpegPipe(child, { source: "qa-end" });
    expect(await waitExit(child)).toBe(true);
    expect(_ffmpegPipeCountForTest()).toBe(0);
    expect(reconcileFfmpegPipes(Date.now() + 10 * FFMPEG_HARD_MAX_MS)).toBe(0);
  });

  it("多条在途:真实时钟下均未到期则一条都不杀", async () => {
    const silent = spawnSilent();
    const chatty = spawnChatty();
    registerFfmpegPipe(silent, { source: "qa-silent" });
    registerFfmpegPipe(chatty, { source: "qa-chatty" });
    await sleep(200);
    expect(_ffmpegPipeCountForTest()).toBe(2);
    // 用真实时钟:silent 已 idle ~200ms 但远 < 90s → 都不该杀
    expect(reconcileFfmpegPipes()).toBe(0);
    expect(_ffmpegPipeCountForTest()).toBe(2);
  });
});
