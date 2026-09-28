// 覆盖率长尾补充:services/transcode.ts 的残余分支。
//   - spawnTranscoder:真实拉起子进程 + stderr 常开排空(无读者时管道满会憋住 ffmpeg)
//   - spawnTranscoderWithArgs:绕过命令拼装、直接透传 argv(138-140)
//   - acquireTranscodeSlot:池满 + **已 abort** 的 signal ⇒ 立刻 reject,不占槽不排队
// 用 FFMPEG_PATH 指向一个必然立刻退出的真实可执行(当前 node 自身)来代替 ffmpeg:
// 不依赖容器里有 ffmpeg,也不产生真实转码。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, afterEach } from "vitest";
import {
  spawnTranscoder,
  spawnTranscoderWithArgs,
  acquireTranscodeSlot,
  activeTranscodeCount,
  slotLimit,
  TranscodeSlotAborted,
} from "../../src/services/transcode.js";

const leases: Array<() => void> = [];
afterEach(() => {
  // 槽是模块级状态:本文件申请到的租约必须全部归还,否则泄漏给后续用例。
  while (leases.length) leases.pop()!();
  expect(activeTranscodeCount()).toBe(0);
});

describe("spawnTranscoder", () => {
  it("真实拉起子进程并立即挂 stderr 排空,子进程退出后不留句柄", async () => {
    const prev = process.env.FFMPEG_PATH;
    // 指向 node 自身:参数是 ffmpeg 语法 ⇒ node 会报错并立刻退出,
    // 但 spawn 成功 + stderr 有数据,正好覆盖"拉起 + 排空"两条路径。
    process.env.FFMPEG_PATH = process.execPath;
    try {
      const child = spawnTranscoder({ source: "/m/a.flac", format: "mp3", bitrateKbps: 192 });
      expect(typeof child.pid).toBe("number");
      // 必须真的用了 FFMPEG_PATH 指定的二进制(resolveFfmpeg 的环境变量分支),
      // 否则会把 ffmpeg-static / PATH 里的 ffmpeg 拉起来,运维注入失效。
      expect(child.spawnfile).toBe(process.execPath);
      // stderr 必须可读且已被 resume(否则管道 64KB 满会憋死长会话)。
      expect(child.stderr.readableFlowing).toBe(true);
      const code = await new Promise<number | null>((resolve) => {
        child.on("close", (c) => resolve(c));
        child.on("error", () => resolve(null));
      });
      expect(code === null || typeof code === "number").toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = prev;
    }
  }, 20_000);

  it("spawnTranscoderWithArgs:绕过命令拼装、直接按给定 argv 拉起(138-140)", async () => {
    const prev = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = process.execPath;
    try {
      // 空 argv:node 立即退出,只验证「用 resolveFfmpeg 的二进制 + 原样透传 argv」。
      const child = spawnTranscoderWithArgs(["-e", "0"]);
      expect(child.spawnfile).toBe(process.execPath);
      expect(child.spawnargs).toContain("-e");
      const code = await new Promise<number | null>((resolve) => {
        child.on("close", (c) => resolve(c));
        child.on("error", () => resolve(null));
      });
      expect(code === null || typeof code === "number").toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = prev;
    }
  }, 20_000);
});

describe("acquireTranscodeSlot: 池满 + 预先 abort", () => {
  it("池占满后用**已 abort** 的 signal 申请 → 立刻 reject,不排队、不占槽", async () => {
    const limit = slotLimit("pipeline");
    for (let i = 0; i < limit; i++) {
      leases.push(await acquireTranscodeSlot("pipeline"));
    }
    expect(activeTranscodeCount("pipeline")).toBe(limit);

    const ac = new AbortController();
    ac.abort();
    // 关键语义:排队者必须在进入等待队列**之前**就被拒,否则调用方(flow 会话)
    // 会被永久挂住、槽也会被慢慢吃光(注释里的 D24)。
    await expect(acquireTranscodeSlot("pipeline", ac.signal)).rejects.toBeInstanceOf(TranscodeSlotAborted);
    expect(activeTranscodeCount("pipeline")).toBe(limit); // 没有多占一个槽

    // 释放后池可正常回到 0(证明上面的 reject 没有在 waiters 里留下幽灵。
    while (leases.length) leases.pop()!();
    expect(activeTranscodeCount("pipeline")).toBe(0);
  });

  it("池未满但 signal 已 abort → 同样立刻 reject(不进池)", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(acquireTranscodeSlot("quality", ac.signal)).rejects.toBeInstanceOf(TranscodeSlotAborted);
    expect(activeTranscodeCount("quality")).toBe(0);
  });
});
