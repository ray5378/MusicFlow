// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
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

// ==================== B 项回归锁:ffmpeg 出流看门狗 ====================
//
// serveFfmpegPipe 起的 ffmpeg 若上游卡住(既不产字节、也不退出、也不 abort),会一直
// 占着并发槽(再播别的就报「并发已满」)且常驻内存。看门狗 = 模块级注册表 + 周期对账器:
//   · 命中「连续 FFMPEG_IDLE_KILL_MS 无 stdout 字节」或「超 FFMPEG_HARD_MAX_MS」
//     → SIGKILL 并注销;
//   · stdout 每有字节刷新 lastDataAt;
//   · exit/error 自动注销。
// 本文件直接驱动注册表/对账器(不启动 setInterval),用真实子进程验证三件事:
//   ① 卡死 → 强杀并注销;② 持续有字节的健康流不被误杀;③ 正常结束自动注销。

/** 起一个「绝不写 stdout」的长命子进程(模拟卡死的 ffmpeg)。 */
function spawnSilent(): any {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  return child;
}

/** 起一个「每 40ms 写一个字节 stdout」的子进程(模拟健康出流)。 */
function spawnChatty(): any {
  const child = spawn(process.execPath, ["-e", "setInterval(() => process.stdout.write('x'), 40)"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  return child;
}

function waitExit(child: any, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    child.once("exit", () => { clearTimeout(t); resolve(true); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("B:ffmpeg 出流看门狗(兜底回收僵死进程)", () => {
  afterEach(() => { _resetFfmpegPipesForTest(); });

  it("idle 超时:连续无 stdout 字节的进程被对账器 SIGKILL 并注销", async () => {
    const child = spawnSilent();
    registerFfmpegPipe(child, { source: "test-idle" });
    expect(_ffmpegPipeCountForTest()).toBe(1);

    // 注入「距 lastDataAt 已超 idle 阈值」的假时刻 → 命中卡死判定。
    const killed = reconcileFfmpegPipes(Date.now() + FFMPEG_IDLE_KILL_MS + 1000);
    expect(killed).toBe(1);
    expect(_ffmpegPipeCountForTest()).toBe(0); // 已注销
    expect(await waitExit(child)).toBe(true);  // 进程确实被杀
  });

  it("正常播放(持续有 stdout 字节)不被误杀", async () => {
    const child = spawnChatty();
    registerFfmpegPipe(child, { source: "test-healthy" });
    await sleep(250); // 期间持续有字节 → lastDataAt 不断刷新
    // 真实 now 对账:距最近一次字节只有几十 ms ≪ idle 阈值 → 不得命中。
    expect(reconcileFfmpegPipes()).toBe(0);
    expect(_ffmpegPipeCountForTest()).toBe(1);
    expect(child.exitCode).toBeNull(); // 仍在播
  });

  it("正常结束:进程退出后自动注销,不再被对账器命中", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('x'); process.exit(0)"], { stdio: ["ignore", "pipe", "pipe"] });
    registerFfmpegPipe(child, { source: "test-end" });
    expect(await waitExit(child)).toBe(true);
    expect(_ffmpegPipeCountForTest()).toBe(0); // exit 监听已注销
    // 即便把时钟拨到远超硬性总时长,也不该再命中(注册表已空)。
    expect(reconcileFfmpegPipes(Date.now() + 10 * FFMPEG_HARD_MAX_MS)).toBe(0);
  });
});
