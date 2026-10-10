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
});
