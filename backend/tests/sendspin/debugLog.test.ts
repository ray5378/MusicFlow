// 解码链路 debug 日志(batch46)回归守卫:
// - 开关关闭 → record 全 no-op(零文件、零内存);
// - 开关开启 → 内存环形缓冲 + JSONL 文件逐条落盘(时间 ISO、字段结构化);
// - 保留 1 天:内存 24h TTL 清理 + 文件按 mtime 清理 + 单文件超限轮转 .1;
// - ffmpeg 非正常退出事件真实取证(退出码 + stderr)。
// 每个用例 vi.resetModules() 取**全新模块实例**——debugLog 是有状态单例,避免用例间串味。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp = "";

beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mf-dbg-"));
  process.env.DATA_DIR = tmp;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.DATA_DIR;
  delete process.env.SENDSPIN_DEBUG_MAX_FILE_BYTES;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("recordSendspinDebug 开关语义", () => {
  it("关闭时 record 全 no-op(无内存条目、无文件)", async () => {
    const dbg = await import("../../src/services/sendspin/debugLog.js");
    expect(dbg.isSendspinDebugEnabled()).toBe(false);
    dbg.recordSendspinDebug("k", "不应被记录", { a: 1 });
    expect(dbg.getSendspinDebugSnapshot().entries).toHaveLength(0);
    expect(fs.existsSync(dbg.debugFilePath())).toBe(false);
  });

  it("开启后:内存 + 文件各记一条,字段结构化、时间 ISO", async () => {
    const dbg = await import("../../src/services/sendspin/debugLog.js");
    dbg.setSendspinDebugEnabled(true);
    dbg.recordSendspinDebug("ffmpeg.abnormal_exit", "ffmpeg 异常退出(code=1)", {
      code: 1,
      decodedSec: 12.5,
      stderrTail: "Invalid data found",
    });
    const snap = dbg.getSendspinDebugSnapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].kind).toBe("ffmpeg.abnormal_exit");
    expect(Number.isNaN(Date.parse(snap.entries[0].ts))).toBe(false);
    expect(snap.entries[0].fields).toMatchObject({ code: 1, decodedSec: 12.5 });
    // 文件 JSONL 可逐行解析
    const raw = fs.readFileSync(dbg.debugFilePath(), "utf8").trim().split("\n");
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0])).toMatchObject({ kind: "ffmpeg.abnormal_exit", fields: { code: 1 } });
  });

  it("内存环形缓冲上限 2000 条:只留最新", async () => {
    const dbg = await import("../../src/services/sendspin/debugLog.js");
    dbg.setSendspinDebugEnabled(true);
    for (let i = 0; i < 2050; i++) dbg.recordSendspinDebug("k", `m${i}`);
    const snap = dbg.getSendspinDebugSnapshot();
    expect(snap.entries.length).toBeLessThanOrEqual(2000);
    expect(snap.entries.at(-1)?.msg).toBe("m2049");
  });

  it("保留 1 天:内存 24h TTL 清理旧条目", async () => {
    const dbg = await import("../../src/services/sendspin/debugLog.js");
    dbg.setSendspinDebugEnabled(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    dbg.recordSendspinDebug("old", "一天前的事件");
    vi.setSystemTime(new Date("2026-10-09T10:00:01Z")); // 前进 24h+1s
    dbg.recordSendspinDebug("new", "刚刚的事件");
    const snap = dbg.getSendspinDebugSnapshot();
    expect(snap.entries.map((e) => e.kind)).toEqual(["new"]);
  });

  it("文件保留 1 天:超 24h 的 sendspin-debug* 按 mtime 清理,新文件保留", async () => {
    const dbg = await import("../../src/services/sendspin/debugLog.js");
    const dir = dbg.debugDir();
    fs.mkdirSync(dir, { recursive: true });
    const oldFile = path.join(dir, "sendspin-debug.log.1");
    fs.writeFileSync(oldFile, "old");
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, new Date(stale), new Date(stale));
    const freshFile = dbg.debugFilePath();
    fs.writeFileSync(freshFile, "fresh");
    dbg.pruneDebugFiles(dir, Date.now());
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it("单文件超上限轮转为 .1(留一份)", async () => {
    process.env.SENDSPIN_DEBUG_MAX_FILE_BYTES = "200";
    const dbg = await import("../../src/services/sendspin/debugLog.js");
    dbg.setSendspinDebugEnabled(true);
    for (let i = 0; i < 30; i++) dbg.recordSendspinDebug("k", "x".repeat(50));
    expect(fs.existsSync(`${dbg.debugFilePath()}.1`)).toBe(true);
    expect(fs.statSync(dbg.debugFilePath()).size).toBeLessThanOrEqual(200 + 120); // 上限+一条
  });
});

describe("ffmpeg 生命周期事件真实取证", () => {
  it("源不可达 → ffmpeg.abnormal_exit(退出码 + stderr)", async () => {
    // 先导入 debugLog(注册新实例),再导入静态依赖它的 streamSource —— 两者共享同一实例。
    const dbg = await import("../../src/services/sendspin/debugLog.js");
    const { PcmWindow } = await import("../../src/services/sendspin/streamSource.js");
    dbg.setSendspinDebugEnabled(true);
    const w = new PcmWindow({ input: "http://127.0.0.1:9/refused" }, 0, { highSec: 30 });
    const deadline = Date.now() + 20_000;
    while (!w.failedReason && Date.now() < deadline) await sleep(100);
    expect(w.failedReason).toBeTruthy();
    const ev = dbg.getSendspinDebugSnapshot().entries.find((e) => e.kind === "ffmpeg.abnormal_exit");
    expect(ev).toBeTruthy();
    expect(ev!.fields!.code).not.toBe(0);
    expect(typeof ev!.fields!.stderrTail).toBe("string");
    // spawn 事件也应在册(生命周期起点)
    expect(dbg.getSendspinDebugSnapshot().entries.some((e) => e.kind === "ffmpeg.spawn")).toBe(true);
  });
});
