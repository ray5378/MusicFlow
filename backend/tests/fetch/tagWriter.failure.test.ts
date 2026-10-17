// tagWriter 失败/超时/异常分支单测（不真跑 ffmpeg）。
//
// 通过 mock `node:child_process` 的 spawn（保留其余真实导出），用可控的假子进程
// 精确覆盖 runFfmpeg 的「spawn 抛错 / 'error' 事件 / 超时 kill / stderr 超长截断 /
// 非 0 退出 / 产物缺失」分支，以及 writeTags 的「源文件不存在」「不支持容器+另存」
// 「目标扩展名不可识别回落源扩展名」「m4a 歌词告警」等分支。
// 确定性、不联网、不依赖真实 ffmpeg 行为。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnMock = vi.hoisted(() => vi.fn());
// 仅替换 spawn，其余 child_process 导出保持真实（避免影响 transcode.js 的 import）。
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { writeTags } from "../../src/services/fetch/tagWriter.js";

/** 可控假子进程：stderr 是 EventEmitter，close/error 由测试手动 emit。 */
function fakeChild(): EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

/** 让 spawn 返回一个「写产物 → close(0)」的成功假进程（产物路径取 args 末项=tmp）。 */
function succeedMock(write = "out-bytes"): void {
  spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
    const c = fakeChild();
    setImmediate(() => {
      writeFileSync(args[args.length - 1], write);
      c.emit("close", 0);
    });
    return c;
  });
}

let DIR = "";

beforeEach(() => {
  spawnMock.mockReset();
  DIR = mkdtempSync(join(tmpdir(), "mf-tagw2-"));
});

afterEach(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

function makeFile(name: string, content = "fLaC-fake-audio"): string {
  const p = join(DIR, name);
  writeFileSync(p, content);
  return p;
}

describe("writeTags — 失败/超时/异常分支（mock spawn）", () => {
  it("spawn 抛错 → TAG_FAILED（无法启动 ffmpeg）", async () => {
    const f = makeFile("a.flac");
    spawnMock.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    await expect(writeTags(f, { title: "x" })).rejects.toMatchObject({ code: "TAG_FAILED" });
  });

  it("子进程 'error' 事件 → TAG_FAILED（ffmpeg 启动失败）", async () => {
    const f = makeFile("b.flac");
    spawnMock.mockImplementationOnce(() => {
      const c = fakeChild();
      setImmediate(() => c.emit("error", new Error("spawn ENOENT")));
      return c;
    });
    await expect(writeTags(f, { title: "x" })).rejects.toMatchObject({ code: "TAG_FAILED" });
  });

  it("超时 → TIMEOUT，且清理掉已生成的临时文件", async () => {
    const f = makeFile("c.flac");
    let tmpOut = "";
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      tmpOut = args[args.length - 1];
      writeFileSync(tmpOut, "partial");
      return fakeChild(); // 永不 close → 触发超时 kill
    });
    await expect(writeTags(f, { title: "x" }, { timeoutMs: 20 })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(tmpOut.length).toBeGreaterThan(0);
    expect(existsSync(tmpOut)).toBe(false); // 临时文件被 finally 清理
  });

  it("stderr 超长被截断 + 非 0 退出 → TAG_FAILED", async () => {
    const f = makeFile("d.flac");
    spawnMock.mockImplementationOnce(() => {
      const c = fakeChild();
      setImmediate(() => {
        c.stderr.emit("data", Buffer.alloc(40 * 1024, 0x61));
        c.stderr.emit("data", Buffer.alloc(40 * 1024, 0x62)); // 累计 > 64KB → 触发截断
      });
      setImmediate(() => c.emit("close", 1));
      return c;
    });
    await expect(writeTags(f, { title: "x" })).rejects.toMatchObject({ code: "TAG_FAILED" });
  });

  it("退出码 0 但产物缺失/为空 → TAG_FAILED", async () => {
    const f = makeFile("e.flac");
    spawnMock.mockImplementationOnce(() => {
      const c = fakeChild();
      setImmediate(() => c.emit("close", 0));
      return c;
    });
    await expect(writeTags(f, { title: "x" })).rejects.toMatchObject({ code: "TAG_FAILED" });
  });

  it("mock ffmpeg 成功：写入 tmp 后 close 0 → rename 生效、原路径即产物", async () => {
    const f = makeFile("f.mp3");
    succeedMock("ok-bytes");
    const r = await writeTags(f, { title: "x" });
    expect(r.ok).toBe(true);
    expect(r.file).toBe(f);
  });

  it("m4a 带歌词 → 仅给『未做实测验证』告警，仍写入成功", async () => {
    const f = makeFile("g.m4a");
    succeedMock();
    const r = await writeTags(f, { title: "x", lyric: "歌词一行" });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("|")).toContain("未做实测验证");
  });

  it("不支持内嵌标签的容器(wav) + 另存 → 复制源到 dst 并跳过，不拉进程", async () => {
    const src = makeFile("h.wav", "RIFF-fake-audio-bytes");
    const dst = join(DIR, "h-out.wav");
    const r = await writeTags(src, { title: "x" }, { dstPath: dst });
    expect(r.ok).toBe(true);
    expect(r.file).toBe(dst);
    expect(existsSync(dst)).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(r.warnings.join("|")).toContain("不支持内嵌标签");
  });

  it("目标扩展名不可识别 → 回落用源扩展名判定容器（flac 可写）", async () => {
    const src = makeFile("i.flac");
    const dst = join(DIR, "i.bin"); // .bin 未知 → containerOf(dst)=undefined → 用 src=flac
    succeedMock();
    const r = await writeTags(src, { title: "x" }, { dstPath: dst });
    expect(r.ok).toBe(true);
    expect(r.file).toBe(dst);
  });

  it("显式 timeoutMs>0 走传入值（覆盖默认超时分支）", async () => {
    const f = makeFile("j.flac");
    succeedMock();
    const r = await writeTags(f, { title: "x" }, { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
  });
});
