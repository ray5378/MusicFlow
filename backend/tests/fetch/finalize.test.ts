import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_NAMING_CONFIG } from "../../src/services/fetch/naming.js";
import { resolveFetchConfig, type FetchConfig } from "../../src/services/fetch/config.js";
import { finalizeFile } from "../../src/services/fetch/finalize.js";

let DL = "";
let CA = "";

beforeEach(() => {
  DL = mkdtempSync(join(tmpdir(), "mf-fin-dl-"));
  CA = mkdtempSync(join(tmpdir(), "mf-fin-ca-"));
});

afterEach(() => {
  rmSync(DL, { recursive: true, force: true });
  rmSync(CA, { recursive: true, force: true });
});

function cfg(partial: Partial<FetchConfig> = {}): FetchConfig {
  return resolveFetchConfig({ downloadRoot: DL, cacheRoot: CA, ...partial });
}

/** 在缓存目录造一个假音频文件，返回其路径。 */
function makeCache(name = "tmp.mp3", content = "AUDIO-BYTES"): string {
  const p = join(CA, name);
  writeFileSync(p, content);
  return p;
}

const TARGET = { title: "T", artist: "A", album: "Al" };
const REL = "A/Al/T - A.mp3";

describe("finalizeFile", () => {
  it("正常落盘：从 cache 搬到目标、内容一致、权限 0644、缓存文件消失", () => {
    const cache = makeCache();
    const r = finalizeFile({
      cachePath: cache,
      target: TARGET,
      probed: { container: "mp3" },
      config: cfg(),
    });
    expect(r.action).toBe("write");
    expect(r.finalPath).toBe(join(DL, REL));
    expect(r.relativePath).toBe(REL);
    expect(existsSync(r.finalPath as string)).toBe(true);
    expect(readFileSync(r.finalPath as string, "utf8")).toBe("AUDIO-BYTES");
    expect(existsSync(cache)).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(r.finalPath as string).mode & 0o777).toBe(0o644);
    }
  });

  it("扩展名优先级：probed.container > containerHint > cachePath 后缀（含 .part）", () => {
    const cache = makeCache("t.flac.part", "X");
    const r = finalizeFile({
      cachePath: cache,
      target: TARGET,
      probed: { container: "flac" },
      containerHint: "mp3",
      config: cfg(),
    });
    expect(r.finalPath?.endsWith(".flac")).toBe(true);

    // 无 probed.container，只有 containerHint → 取 hint；缓存文件须真实存在（真做 rename）。
    const cache2 = makeCache("onlyhint.part", "X");
    const r2 = finalizeFile({
      cachePath: cache2,
      target: TARGET,
      containerHint: "wav",
      config: cfg(),
    });
    expect(r2.finalPath?.endsWith(".wav")).toBe(true);
  });

  it("rename 策略：已存在时产出 'xxx (1).ext'，旧文件未被破坏", () => {
    const target = join(DL, REL);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "OLD");
    const oldStat = statSync(target);

    const cache = makeCache("tmp.mp3", "NEW");
    const r = finalizeFile({
      cachePath: cache,
      target: TARGET,
      probed: { container: "mp3" },
      config: cfg({ fileConflictPolicy: "rename" }),
    });

    expect(r.action).toBe("write");
    expect(r.finalPath?.endsWith("T - A (1).mp3")).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("OLD");
    expect(statSync(target).mtimeMs).toBe(oldStat.mtimeMs);
    expect(readFileSync(r.finalPath as string, "utf8")).toBe("NEW");
  });

  it("rename 策略：(1) 也已存在 → 递增到 (2)", () => {
    const target = join(DL, REL);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "OLD");
    writeFileSync(join(DL, "A/Al/T - A (1).mp3"), "OLD1");

    const cache = makeCache("tmp.mp3", "NEW");
    const r = finalizeFile({
      cachePath: cache,
      target: TARGET,
      probed: { container: "mp3" },
      config: cfg({ fileConflictPolicy: "rename" }),
    });
    expect(r.finalPath?.endsWith("T - A (2).mp3")).toBe(true);
  });

  it("keepBetter + newIsBetter=false → action keep，旧文件与缓存文件都原样", () => {
    const target = join(DL, REL);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "OLD");
    const oldStat = statSync(target);

    const cache = makeCache("tmp.mp3", "NEW");
    const r = finalizeFile({
      cachePath: cache,
      target: TARGET,
      probed: { container: "mp3" },
      config: cfg({ fileConflictPolicy: "keepBetter" }),
      newIsBetter: false,
    });

    expect(r.action).toBe("keep");
    expect(r.reusedExisting).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("OLD");
    expect(statSync(target).mtimeMs).toBe(oldStat.mtimeMs);
    // 缓存文件不该被删（删不删由调用方决定）。
    expect(existsSync(cache)).toBe(true);
    expect(readFileSync(cache, "utf8")).toBe("NEW");
  });

  it("keepBetter + newIsBetter=true → 覆盖写入", () => {
    const target = join(DL, REL);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "OLD");

    const cache = makeCache("tmp.mp3", "NEW");
    const r = finalizeFile({
      cachePath: cache,
      target: TARGET,
      probed: { container: "mp3" },
      config: cfg({ fileConflictPolicy: "keepBetter" }),
      newIsBetter: true,
    });
    expect(r.action).toBe("write");
    expect(readFileSync(target, "utf8")).toBe("NEW");
  });

  it("skip 策略：已存在 → 不动任何文件", () => {
    const target = join(DL, REL);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "OLD");

    const cache = makeCache("tmp.mp3", "NEW");
    const r = finalizeFile({
      cachePath: cache,
      target: TARGET,
      probed: { container: "mp3" },
      config: cfg({ fileConflictPolicy: "skip" }),
    });
    expect(r.action).toBe("skip");
    expect(readFileSync(target, "utf8")).toBe("OLD");
    expect(existsSync(cache)).toBe(true);
  });

  it("目录模板缺 year 时不产生空目录/空括号", () => {
    // {year} 缺失 → '(...)' 整组消去；'({year})' 不能留下 '()'。
    const config = cfg({
      naming: { ...DEFAULT_NAMING_CONFIG, dirTemplate: "{albumArtist}/{album} ({year})" },
    });
    const r = finalizeFile({
      cachePath: makeCache("x.mp3", "X"),
      target: TARGET,
      probed: { container: "mp3" },
      config,
    });
    expect(r.finalPath).toBe(join(DL, REL));
    expect(r.finalPath).not.toContain("()");

    // 整段为空的目录层被消去，不产生空目录层级。
    const config2 = cfg({
      naming: { ...DEFAULT_NAMING_CONFIG, dirTemplate: "{albumArtist}/{year}" },
    });
    const r2 = finalizeFile({
      cachePath: makeCache("x.mp3", "X"),
      target: TARGET,
      probed: { container: "mp3" },
      config: config2,
    });
    expect(r2.finalPath).toBe(join(DL, "A/T - A.mp3"));
  });

  it("禁止原地覆盖：最终路径 == cachePath 时抛错", () => {
    const config = cfg({
      naming: { ...DEFAULT_NAMING_CONFIG, dirTemplate: "", fileTemplate: "same" },
    });
    const cache = join(DL, "same.mp3");
    writeFileSync(cache, "X");
    expect(() =>
      finalizeFile({ cachePath: cache, target: TARGET, probed: { container: "mp3" }, config }),
    ).toThrow(/原地覆盖/);
  });

  it("destDirOverride：原地替换 —— 成品落到指定目录（文件名取模板）", () => {
    const dest = join(DL, "orig/Artist/Album");
    mkdirSync(dest, { recursive: true });
    const cache = makeCache("x.flac", "LOSSLESS");
    const r = finalizeFile({
      cachePath: cache,
      target: TARGET,
      probed: { container: "flac" },
      config: cfg(),
      destDirOverride: dest,
    });
    expect(r.action).toBe("write");
    expect(dirname(r.finalPath!)).toBe(dest);
    expect(r.finalPath).toMatch(/\.flac$/);
    expect(existsSync(r.finalPath!)).toBe(true);
  });

  it("无法确定扩展名时抛错", () => {
    expect(() =>
      finalizeFile({
        cachePath: join(CA, "noext"),
        target: TARGET,
        config: cfg(),
      }),
    ).toThrow(/扩展名/);
  });
});
