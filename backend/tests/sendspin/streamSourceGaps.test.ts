// streamSource.ts(PcmWindow)覆盖补测:进程起不来 / 进程错误 / 非零退出 / 等数超时 /
// 背压滞回恢复。这些是「静默无声」类事故的收口点,必须锁死。
//
// 策略:真实 ffmpeg 走不到的分支用**假 ffmpeg 脚本**(挂在 FFMPEG_PATH)驱动;
// spawn 同步抛错无法用真实二进制诱发 → 只在需要时把 node:child_process.spawn 换成抛错桩。
import "../plugins/_env.js";

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const ctl = vi.hoisted(() => ({ spawnThrows: false }));

// 保留真实 child_process,只在 ctl.spawnThrows 时让 spawn 同步抛错
// (对应「ffmpeg 起不来」必须收口为 failed,而不是把异常抛穿构造函数的契约)。
vi.mock("node:child_process", async (orig) => {
  const actual: any = await (orig as any)();
  return {
    ...actual,
    spawn: (...args: any[]) => {
      if (ctl.spawnThrows) throw new Error("spawn boom");
      return (actual.spawn as any)(...args);
    },
  };
});

import {
  PcmWindow,
  WindowFailedError,
  WINDOW_HIGH_SEC,
} from "../../src/services/sendspin/streamSource.js";
import { SAMPLE_RATE, CHANNELS } from "../../src/services/sendspin/encoding.js";

const SPOOK = (sec: number) => Math.floor(sec * SAMPLE_RATE * CHANNELS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmpDir = "";
/** 写一个假 ffmpeg 脚本并返回路径;FFMPEG_PATH 的保存/还原由各用例自理。 */
function fakeFfmpeg(name: string, body: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, ["#!/bin/sh", ...body.split("\n"), ""].join("\n"));
  fs.chmodSync(p, 0o755);
  return p;
}

async function withFfmpeg<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = bin; // 必须在 PcmWindow 构造(spawn)之前生效
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prev;
  }
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-gaps-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PcmWindow 失败收口(不静默)", () => {
  it("ffmpeg spawn 同步抛错 → 记 failed(=ffmpeg 启动失败),在飞等数者立刻收到 WindowFailedError", async () => {
    const hang = fakeFfmpeg("hang-for-spawnfail.sh", ["sleep 30"].join("\n"));
    await withFfmpeg(hang, async () => {
      const w = new PcmWindow({ input: "ignored", loudness: { enabled: false } });
      // 先让一个等数者挂上(slice 会阻塞在 waitFor)
      const pending = w.slice(0, SPOOK(1), 8000);
      await sleep(20);
      ctl.spawnThrows = true; // 重定位要重起 ffmpeg → 此处同步抛错
      try {
        await w.seekTo(10_000);
        // 契约:失败必须收口成 WindowFailedError,而不是把异常抛穿 seekTo
        await expect(pending).rejects.toBeInstanceOf(WindowFailedError);
        expect(w.failedReason).toMatch(/ffmpeg 启动失败/);
      } finally {
        ctl.spawnThrows = false;
        w.close();
      }
    });
  }, 20_000);

  it("ffmpeg 二进制不存在(spawn 'error')→ 收口为 failed,ready 抛 WindowFailedError", async () => {
    const missing = path.join(tmpDir, "no-such-ffmpeg-binary");
    await withFfmpeg(missing, async () => {
      const w = new PcmWindow({ input: "ignored", loudness: { enabled: false } });
      try {
        await expect(w.ready(4000)).rejects.toBeInstanceOf(WindowFailedError);
        expect(w.failedReason).toMatch(/ffmpeg 进程错误/);
        expect(w.eof).toBe(false); // 错误退出绝不能当 EOF(否则会被当成"播完")
      } finally {
        w.close();
      }
    });
  }, 15_000);

  it("ffmpeg 非零退出 → failed 带退出码与 stderr 尾(不当成正常 EOF)", async () => {
    const bad = fakeFfmpeg("exit3.sh", ['cat > /dev/null', 'echo "decoder exploded" >&2', "exit 3"].join("\n"));
    await withFfmpeg(bad, async () => {
      const w = new PcmWindow({ input: "ignored", loudness: { enabled: false } });
      try {
        await expect(w.ready(6000)).rejects.toBeInstanceOf(WindowFailedError);
        expect(w.failedReason).toMatch(/ffmpeg 异常退出\(3\)/);
        expect(w.failedReason).toContain("decoder exploded");
        expect(w.eof).toBe(false);
      } finally {
        w.close();
      }
    });
  }, 20_000);

  it("ffmpeg 不吐数据 → slice 等数超时抛错(调用方按 stall 处理)", async () => {
    const hang = fakeFfmpeg("hang.sh", ["sleep 30"].join("\n"));
    await withFfmpeg(hang, async () => {
      const w = new PcmWindow({ input: "ignored", loudness: { enabled: false } });
      try {
        await expect(w.slice(0, SPOOK(0.05), 300)).rejects.toThrow(/PcmWindow 等数超时\(300ms\)/);
      } finally {
        w.close();
      }
    });
  }, 20_000);
});

describe("PcmWindow 背压滞回(maybeResume)", () => {
  it("积压被消费到低水位之下后恢复读取(不永久憋死 ffmpeg)", async () => {
    // 素材必须长于 WINDOW_HIGH_SEC(300s),否则先到 EOF 就测不到背压。
    const w = new PcmWindow({
      input: "sine=frequency=440:duration=400:sample_rate=48000",
      inputFormat: "lavfi",
    });
    try {
      // 1) 等到解码停滞(已被高水位 pause)
      const high = SPOOK(WINDOW_HIGH_SEC - 15);
      const deadline = Date.now() + 30_000;
      let prev = -1;
      for (;;) {
        const cur = w.decoded;
        if (cur >= high && cur === prev) break;
        if (Date.now() > deadline) break;
        prev = cur;
        await sleep(250);
      }
      expect(w.decoded).toBeGreaterThanOrEqual(high);
      const choked = w.decoded;

      // 2) 消费掉 >10s 积压(高水位 300s − 低水位 290s = 滞回宽度)→ 触发 resume
      const got = await w.slice(0, SPOOK(20), 20_000);
      expect(got.length).toBeGreaterThan(0);

      // 3) 恢复读取:decoded 必须继续增长(证明 stdout.resume() 生效)
      const t0 = Date.now();
      let grew = false;
      while (Date.now() - t0 < 20_000) {
        if (w.decoded > choked + SPOOK(2)) {
          grew = true;
          break;
        }
        await sleep(200);
      }
      expect(grew).toBe(true);
    } finally {
      w.close();
    }
  }, 90_000);
});
