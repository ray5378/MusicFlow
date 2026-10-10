import * as fs from "node:fs";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureWritableDir, resetWritableVerify } from "../../src/services/fetch/writable.js";

describe("ensureWritableDir 写目录预检", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "mf-writable-"));
    resetWritableVerify();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    resetWritableVerify();
  });

  it("目录不存在时递归创建并探针通过；记忆命中可重复调用；fresh 强制重探可重建", () => {
    const dir = path.join(base, "a", "b", "c");
    ensureWritableDir(dir);
    expect(existsSync(dir)).toBe(true);
    // 幂等：记忆命中后重复调用不抛
    ensureWritableDir(dir);
    // fresh 重探：目录被外力删除后强制重探会重建
    rmSync(dir, { recursive: true, force: true });
    ensureWritableDir(dir, { fresh: true });
    expect(existsSync(dir)).toBe(true);
  });

  it("探针文件不残留", () => {
    const dir = path.join(base, "probe-clean");
    ensureWritableDir(dir);
    expect(existsSync(path.join(dir, `.mf_write_probe_${process.pid}`))).toBe(false);
  });

  it("路径父级是普通文件时快速失败（fail-fast 契约）", () => {
    const file = path.join(base, "not-a-dir");
    writeFileSync(file, "x");
    expect(() => ensureWritableDir(path.join(file, "child"))).toThrow(/child|ENOTDIR|not-a-dir/);
  });

  it("空路径直接抛出明确错误", () => {
    expect(() => ensureWritableDir("")).toThrow(/写目录为空/);
  });

  it("cleanCacheRootContents：清空子目录与文件、保留根目录", async () => {
    const { cleanCacheRootContents } = await import("../../src/services/fetch/writable.js");
    const cache = path.join(base, "cache");
    const dl = path.join(base, "dl");
    fs.mkdirSync(path.join(cache, "lib_a"), { recursive: true });
    fs.writeFileSync(path.join(cache, "lib_a", "t.part"), "x");
    fs.writeFileSync(path.join(cache, "stray.bin"), "y");
    fs.mkdirSync(path.join(dl, "album"), { recursive: true });
    fs.writeFileSync(path.join(dl, "album", "song.flac"), "z");
    const n = cleanCacheRootContents(cache, dl);
    expect(n).toBe(2);
    expect(existsSync(cache)).toBe(true);
    expect(fs.readdirSync(cache).length).toBe(0);
    // 成品目录不受影响
    expect(existsSync(path.join(dl, "album", "song.flac"))).toBe(true);
  });

  it("cleanCacheRootContents：防御路径（根/浅层/与成品同目录）一律不清", async () => {
    const { cleanCacheRootContents } = await import("../../src/services/fetch/writable.js");
    const dl = path.join(base, "dl2");
    fs.mkdirSync(dl, { recursive: true });
    fs.writeFileSync(path.join(dl, "keep.flac"), "z");
    expect(cleanCacheRootContents("", dl)).toBe(0);
    expect(cleanCacheRootContents("/", dl)).toBe(0);
    expect(cleanCacheRootContents(dl, dl)).toBe(0); // 同目录
    expect(existsSync(path.join(dl, "keep.flac"))).toBe(true);
  });
});
