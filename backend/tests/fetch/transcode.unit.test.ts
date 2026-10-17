// fetch/transcode 单元测试（不真跑 ffmpeg）
//
// 覆盖三块：
//   1) 纯函数：defaultDstPath / tmpPathFor / resolveOutDepth / buildLoudnessFilter
//      / buildTranscodeArgs / parseLoudnormMeasurement —— 锁定命令形态、位深口径与滤镜顺序；
//   2) runFfmpeg 的进程层（mock node:child_process.spawn）：spawn 抛错 / 'error' 事件 /
//      超时 kill / stderr 超长截断 / 非 0 退出 / 产物缺失或为空 —— 失败与边界路径；
//   3) transcodeFile 主流程：源缺失 / 探针失败降级 / 已是目标容器跳过 / 需重采样 /
//      显式 dstPath / 响度归一化（两遍成功、两遍失败降级、单遍、wav 不写 osf）/ rename 落地。
//
// 探针层 mock（probe.js）：本文件只关心 transcode.ts 自身行为，源属性直接给定，
// 不依赖真实音频字节。spawn 一律用可控假子进程，确定性、不联网。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnMock = vi.hoisted(() => vi.fn());
// 仅替换 spawn，其余 child_process 导出保持真实。
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

const probeMock = vi.hoisted(() => vi.fn());
// 仅替换 probeFile，源属性由用例给定（真实探针依赖音频字节，本文件不关心）。
vi.mock("../../src/services/fetch/probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/fetch/probe.js")>();
  return { ...actual, probeFile: probeMock };
});

import {
  buildLoudnessFilter,
  buildTranscodeArgs,
  defaultDstPath,
  FetchTranscodeError,
  parseLoudnormMeasurement,
  resolveOutDepth,
  tmpPathFor,
  transcodeFile,
} from "../../src/services/fetch/transcode.js";

type FakeChild = EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };

/** 可控假子进程：stderr 是 EventEmitter，close/error 由测试手动 emit。 */
function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  return c;
}

/** 让 spawn 返回一个「把 args 末项（=tmp 输出）写入内容 → close(code)」的假进程。 */
function succeedMock(content = "transcoded-bytes", code = 0): void {
  spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
    const c = fakeChild();
    setImmediate(() => {
      writeFileSync(args[args.length - 1], content);
      c.emit("close", code);
    });
    return c;
  });
}

/** loudnorm 第一遍的完整 JSON 报告（走 AV_LOG_INFO，格式与 ffmpeg 一致）。 */
const LOUDNORM_JSON =
  '[Parsed_loudnorm_0 @ 0x55] \n{\n\t"input_i" : "-14.20",\n\t"input_lra" : "1.50",\n' +
  '\t"input_tp" : "-1.30",\n\t"input_thresh" : "-24.80",\n\t"target_offset" : "0.20"\n}\n';

/**
 * 组装「先测后编」两遍法的 spawn 实现：末项为 "-" 的调用视为测量遍（`-f null -`），
 * 其余为转码遍。返回每次调用的 args，便于断言第二遍用的滤镜。
 */
function twoPassMock(measure: "ok" | "nonzero" | "throw" | "error", write: string | null = "transcoded-bytes"): string[][] {
  const seen: string[][] = [];
  spawnMock.mockImplementation((_cmd: string, args: string[]) => {
    seen.push(args);
    const isMeasure = args[args.length - 1] === "-";
    if (isMeasure) {
      if (measure === "throw") throw new Error("ENOENT");
      const c = fakeChild();
      setImmediate(() => {
        if (measure === "ok") {
          c.stderr.emit("data", Buffer.from(LOUDNORM_JSON));
          c.emit("close", 0);
        } else if (measure === "error") {
          c.emit("error", new Error("spawn ENOENT"));
        } else {
          c.emit("close", 1);
        }
      });
      return c;
    }
    const c = fakeChild();
    setImmediate(() => {
      if (write !== null) writeFileSync(args[args.length - 1], write);
      c.emit("close", 0);
    });
    return c;
  });
  return seen;
}

let DIR = "";

beforeEach(() => {
  spawnMock.mockReset();
  probeMock.mockReset();
  DIR = mkdtempSync(join(tmpdir(), "mf-trcd-"));
});

afterEach(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

function makeFile(name: string, content = "fake-audio"): string {
  const p = join(DIR, name);
  writeFileSync(p, content);
  return p;
}

/** 让探针返回给定源属性（缺省 mp3 / 44100 / 16bit / 无封面）。 */
function probeOk(
  over: Partial<{ container: string; sampleRateHz: number | undefined; bitDepth: number | undefined; hasCover: boolean }> = {},
): void {
  probeMock.mockResolvedValue({
    container: "mp3",
    sampleRateHz: 44100,
    bitDepth: 16,
    hasCover: false,
    ...over,
  });
}

describe("纯函数：defaultDstPath / tmpPathFor", () => {
  it("defaultDstPath 替换扩展名；alac 落 .m4a", () => {
    expect(defaultDstPath("/m/a.mp3", "flac")).toBe("/m/a.flac");
    expect(defaultDstPath("/m/a.mp3", "alac")).toBe("/m/a.m4a");
  });

  it("defaultDstPath 无扩展名时直接追加", () => {
    expect(defaultDstPath("/m/noext", "wav")).toBe("/m/noext.wav");
  });

  it("tmpPathFor 把标记插在扩展名之前", () => {
    expect(tmpPathFor("/m/o.flac", "trtmp")).toBe("/m/o.trtmp.flac");
  });

  it("tmpPathFor 无扩展名时直接追加标记", () => {
    expect(tmpPathFor("/m/o", "trtmp")).toBe("/m/o.trtmp");
  });
});

describe("纯函数：resolveOutDepth", () => {
  it("显式 16 / 24 生效（忽略源位深）", () => {
    expect(resolveOutDepth(16, 24)).toBe(16);
    expect(resolveOutDepth(24, 16)).toBe(24);
  });

  it("auto 跟随源：≥24bit → 24；16bit 或拿不到 → 16", () => {
    expect(resolveOutDepth("auto", 24)).toBe(24);
    expect(resolveOutDepth("auto", 32)).toBe(24);
    expect(resolveOutDepth("auto", 16)).toBe(16);
    expect(resolveOutDepth("auto", undefined)).toBe(16);
    expect(resolveOutDepth(undefined, undefined)).toBe(16);
  });
});

describe("纯函数：buildLoudnessFilter", () => {
  it("无实测 → 单遍动态；osf=s16 带三角抖动；osr 复位", () => {
    const f = buildLoudnessFilter({ targetLufs: -14, targetSampleRateHz: 48000, osf: "s16" });
    expect(f).toContain("loudnorm=I=-14:TP=-2:LRA=10");
    expect(f).toContain("offset=0.0");
    expect(f).not.toContain("linear=true");
    expect(f).toContain("aresample=resampler=swr:osr=48000");
    expect(f).toContain("osf=s16:dither_method=triangular_hp");
  });

  it("有实测 → linear 静态增益（含 measured_* 与 offset）；osf=s32", () => {
    const f = buildLoudnessFilter({
      targetLufs: -14,
      truePeakDb: -3,
      rangeLu: 9,
      targetSampleRateHz: 44100,
      osf: "s32",
      measured: { i: -13.5, lra: 2.1, tp: -0.8, thresh: -24, offset: 0.4 },
    });
    expect(f).toContain("loudnorm=I=-14:TP=-3:LRA=9");
    expect(f).toContain("measured_I=-13.5");
    expect(f).toContain("measured_LRA=2.1");
    expect(f).toContain("linear=true");
    expect(f).toContain("offset=0.4");
    expect(f).toContain("osf=s32");
  });

  it("实测 offset 非有限 → offset 归 0", () => {
    const f = buildLoudnessFilter({
      targetLufs: -14,
      targetSampleRateHz: 48000,
      measured: { i: -13, lra: 2, tp: -1, thresh: -24, offset: Infinity },
    });
    expect(f).toContain("linear=true");
    expect(f).toContain(":offset=0:");
  });

  it("实测缺字段（非有限）→ 回落单遍动态", () => {
    const f = buildLoudnessFilter({
      targetLufs: -14,
      targetSampleRateHz: 48000,
      measured: { i: NaN, lra: 1, tp: 1, thresh: 1, offset: 0 },
    });
    expect(f).toContain("offset=0.0");
    expect(f).not.toContain("linear=true");
  });

  it("truePeakDb / rangeLu 非有限 → 回落缺省；目标 LUFS 越界被夹；osr 取整", () => {
    const f = buildLoudnessFilter({ targetLufs: -999, truePeakDb: NaN, rangeLu: Infinity, targetSampleRateHz: 22050.7 });
    expect(f).toContain("loudnorm=I=-30:TP=-2:LRA=10");
    expect(f).toContain("osr=22050");
    expect(f).not.toContain("osf=");
  });
});

describe("纯函数：buildTranscodeArgs", () => {
  it("flac 缺省：outDepth=16 → 含 -sample_fmt s16、-map_metadata 0、-vn", () => {
    const a = buildTranscodeArgs({ src: "in.mp3", out: "o.trtmp.flac", target: "flac", outDepth: 16 });
    expect(a).toEqual([
      "-y", "-hide_banner", "-loglevel", "error", "-i", "in.mp3",
      "-map", "0:a", "-map_metadata", "0",
      "-c:a", "flac", "-sample_fmt", "s16",
      "-vn", "o.trtmp.flac",
    ]);
  });

  it("flac + 封面 + 压缩等级：带 0:v / attached_pic / compression_level；outDepth=24 无 s16", () => {
    const a = buildTranscodeArgs({
      src: "in.mp3", out: "o.trtmp.flac", target: "flac", outDepth: 24, hasCover: true, compressionLevel: 6,
    });
    expect(a).toContain("0:v");
    expect(a[a.indexOf("-c:v") + 1]).toBe("copy");
    expect(a[a.indexOf("-disposition:v:0") + 1]).toBe("attached_pic");
    expect(a[a.indexOf("-compression_level") + 1]).toBe("6");
    expect(a).not.toContain("-sample_fmt");
    expect(a).not.toContain("-vn");
  });

  it("compressionLevel 越界（>12 / <0）或非数字 → 不下发该参数", () => {
    const over = buildTranscodeArgs({ src: "a", out: "o.flac", target: "flac", outDepth: 16, compressionLevel: 13 });
    const under = buildTranscodeArgs({ src: "a", out: "o.flac", target: "flac", outDepth: 16, compressionLevel: -1 });
    const none = buildTranscodeArgs({ src: "a", out: "o.flac", target: "flac", outDepth: 16 });
    expect(over).not.toContain("-compression_level");
    expect(under).not.toContain("-compression_level");
    expect(none).not.toContain("-compression_level");
  });

  it("旧参数 keepBitDepth16：false→24（无 s16）/ true→16（有 s16）/ 缺省→16", () => {
    expect(buildTranscodeArgs({ src: "a", out: "o.flac", target: "flac", keepBitDepth16: false })).not.toContain("-sample_fmt");
    expect(buildTranscodeArgs({ src: "a", out: "o.flac", target: "flac", keepBitDepth16: true })).toContain("-sample_fmt");
    expect(buildTranscodeArgs({ src: "a", out: "o.flac", target: "flac" })).toContain("-sample_fmt");
  });

  it("keepTags=false → map_metadata -1 且丢封面（无 0:v / -c:v）", () => {
    const a = buildTranscodeArgs({ src: "a", out: "o.flac", target: "flac", outDepth: 16, hasCover: true, keepTags: false });
    expect(a[a.indexOf("-map_metadata") + 1]).toBe("-1");
    expect(a).not.toContain("0:v");
    expect(a).not.toContain("-c:v");
    expect(a).toContain("-vn");
  });

  it("alac → -c:a alac -f ipod（并按 outDepth 决定 s16）", () => {
    const a = buildTranscodeArgs({ src: "a", out: "o.trtmp.m4a", target: "alac", outDepth: 16 });
    expect(a[a.indexOf("-c:a") + 1]).toBe("alac");
    expect(a[a.indexOf("-f") + 1]).toBe("ipod");
    expect(a).toContain("-sample_fmt");
  });

  it("wav → 位深定死 pcm_s16le / pcm_s24le", () => {
    expect(buildTranscodeArgs({ src: "a", out: "o.trtmp.wav", target: "wav", outDepth: 24 })).toContain("pcm_s24le");
    expect(buildTranscodeArgs({ src: "a", out: "o.trtmp.wav", target: "wav", outDepth: 16 })).toContain("pcm_s16le");
  });

  it("sampleRateHz>0 下发 -ar；=0/负值 不下发；af 排在输出文件之前", () => {
    const a = buildTranscodeArgs({
      src: "a", out: "o.trtmp.flac", target: "flac", outDepth: 16, sampleRateHz: 48000, af: "loudnorm=I=-14,aresample=x",
    });
    expect(a[a.indexOf("-ar") + 1]).toBe("48000");
    expect(a.indexOf("-af")).toBeLessThan(a.indexOf("o.trtmp.flac"));

    const b = buildTranscodeArgs({ src: "a", out: "o.flac", target: "flac", outDepth: 16, sampleRateHz: 0 });
    expect(b).not.toContain("-ar");
    const c = buildTranscodeArgs({ src: "a", out: "o.flac", target: "flac", outDepth: 16, sampleRateHz: -5 });
    expect(c).not.toContain("-ar");
  });
});

describe("纯函数：parseLoudnormMeasurement", () => {
  it("空串 / 无标记 / 有标记无 { / 有 { 无 } → undefined", () => {
    expect(parseLoudnormMeasurement("")).toBeUndefined();
    expect(parseLoudnormMeasurement("hello world")).toBeUndefined();
    expect(parseLoudnormMeasurement("[Parsed_loudnorm_0] xyz")).toBeUndefined();
    expect(parseLoudnormMeasurement('[Parsed_loudnorm_0] {"a":1')).toBeUndefined();
  });

  it("合法 JSON → 解析出全部五值", () => {
    expect(parseLoudnormMeasurement(LOUDNORM_JSON)).toMatchObject({
      i: -14.2, lra: 1.5, tp: -1.3, thresh: -24.8, offset: 0.2,
    });
  });

  it("必要字段非有限 → undefined", () => {
    expect(
      parseLoudnormMeasurement('[Parsed_loudnorm_0] {"input_i":"N/A","input_lra":"1","input_tp":"1","input_thresh":"1"}'),
    ).toBeUndefined();
  });

  it("JSON 解析抛错 → undefined", () => {
    expect(parseLoudnormMeasurement('[Parsed_loudnorm_0] {"input_i": }')).toBeUndefined();
  });

  it("target_offset 缺失 → offset 归 0", () => {
    const r = parseLoudnormMeasurement(
      '[Parsed_loudnorm_0] {"input_i":"-14","input_lra":"1","input_tp":"-1","input_thresh":"-24"}',
    );
    expect(r?.offset).toBe(0);
  });

  it("多处标记 → 取最后一块", () => {
    const raw =
      '[Parsed_loudnorm_0] {"input_i":"-99","input_lra":"1","input_tp":"1","input_thresh":"1"}\n' +
      '[Parsed_loudnorm_1] {"input_i":"-14","input_lra":"2","input_tp":"-1","input_thresh":"-24","target_offset":"1"}';
    expect(parseLoudnormMeasurement(raw)?.i).toBe(-14);
  });
});

describe("transcodeFile", () => {
  it("源文件不存在 → FetchTranscodeError(TAG_FAILED)，不拉进程", async () => {
    await expect(transcodeFile(join(DIR, "missing.flac"), { target: "flac" })).rejects.toBeInstanceOf(FetchTranscodeError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("探针失败 → 记警告后继续（不 skip）并成功转码", async () => {
    const src = makeFile("a.mp3");
    probeMock.mockRejectedValueOnce(new Error("probe boom"));
    succeedMock();
    const r = await transcodeFile(src, { target: "flac" });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(false);
    expect(r.warnings.join("|")).toContain("源探针失败");
    expect(r.dstPath).toBe(defaultDstPath(src, "flac"));
    expect(r.bytes).toBeGreaterThan(0);
  });

  it("源已是目标容器、无需重采样、未开响度归一化 → 跳过（不拉进程）", async () => {
    const src = makeFile("b.flac");
    probeOk({ container: "flac" });
    const r = await transcodeFile(src, { target: "flac" });
    expect(r.skipped).toBe(true);
    expect(r.dstPath).toBe(src);
    expect(r.bytes).toBeGreaterThan(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("开启响度归一化时绝不 skip（源已是目标容器）→ 走两遍法", async () => {
    const src = makeFile("c.flac");
    probeOk({ container: "flac", sampleRateHz: 44100, bitDepth: 16 });
    const seen = twoPassMock("ok");
    const r = await transcodeFile(src, {
      target: "flac",
      loudnessNormalize: true,
      loudnessTruePeakDb: -1.5,
      loudnessRangeLu: 7,
    });
    expect(r.skipped).toBe(false);
    expect(seen.length).toBe(2);
    expect(seen[1].join(" ")).toContain("linear=true");
  });

  it("需要重采样（显式采样率≠源）→ 不 skip", async () => {
    const src = makeFile("d.flac");
    probeOk({ container: "flac", sampleRateHz: 44100 });
    succeedMock();
    const r = await transcodeFile(src, { target: "flac", sampleRateHz: 48000 });
    expect(r.skipped).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("显式 dstPath → 不 skip 且写入指定路径", async () => {
    const src = makeFile("e.flac");
    probeOk({ container: "flac" });
    succeedMock("newbytes");
    const dst = join(DIR, "e-out.flac");
    const r = await transcodeFile(src, { target: "flac", dstPath: dst });
    expect(r.dstPath).toBe(dst);
    expect(r.skipped).toBe(false);
    expect(existsSync(dst)).toBe(true);
  });

  it("非 0 退出（stderr 超长被截断）→ TAG_FAILED", async () => {
    const src = makeFile("f.mp3");
    probeOk();
    spawnMock.mockImplementationOnce(() => {
      const c = fakeChild();
      setImmediate(() => {
        c.stderr.emit("data", Buffer.alloc(40 * 1024, 0x61));
        c.stderr.emit("data", Buffer.alloc(40 * 1024, 0x62)); // 累计 >64KB → 触发截断
        c.emit("close", 1);
      });
      return c;
    });
    await expect(transcodeFile(src, { target: "flac" })).rejects.toMatchObject({ code: "TAG_FAILED" });
  });

  it("退出码 0 但产物缺失 → TAG_FAILED", async () => {
    const src = makeFile("g.mp3");
    probeOk();
    spawnMock.mockImplementationOnce(() => {
      const c = fakeChild();
      setImmediate(() => c.emit("close", 0));
      return c;
    });
    await expect(transcodeFile(src, { target: "flac" })).rejects.toMatchObject({ code: "TAG_FAILED" });
  });

  it("产物存在但为空 → TAG_FAILED", async () => {
    const src = makeFile("h.mp3");
    probeOk();
    succeedMock("", 0);
    await expect(transcodeFile(src, { target: "flac" })).rejects.toMatchObject({ code: "TAG_FAILED" });
  });

  it("spawn 抛错 → TAG_FAILED（无法启动 ffmpeg）", async () => {
    const src = makeFile("i.mp3");
    probeOk();
    spawnMock.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    await expect(transcodeFile(src, { target: "flac" })).rejects.toMatchObject({ code: "TAG_FAILED" });
  });

  it("子进程 'error' 事件 → TAG_FAILED；已 settle 后再 close 走守卫", async () => {
    const src = makeFile("j.mp3");
    probeOk();
    let child!: FakeChild;
    spawnMock.mockImplementationOnce(() => {
      child = fakeChild();
      setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });
    await expect(transcodeFile(src, { target: "flac" })).rejects.toMatchObject({ code: "TAG_FAILED" });
    child.emit("close", 0); // settled 后 close → close 处理器提前 return
  });

  it("超时 → TIMEOUT，kill 子进程并清理临时文件；已 settle 后再 error 走守卫", async () => {
    const src = makeFile("k.mp3");
    probeOk();
    let child!: FakeChild;
    let tmpOut = "";
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      tmpOut = args[args.length - 1];
      writeFileSync(tmpOut, "partial");
      child = fakeChild();
      child.kill.mockImplementation(() => {
        throw new Error("kill boom"); // 覆盖 kill 抛错的 catch 分支
      });
      return child; // 永不 close → 触发定时器 kill
    });
    await expect(transcodeFile(src, { target: "flac", timeoutMs: 20 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(existsSync(tmpOut)).toBe(false);
    child.emit("error", new Error("late")); // settled 后 error → error 处理器提前 return
  });

  it("两遍法：第一遍测量非 0 → 降级单遍并记 warning，仍转码成功", async () => {
    const src = makeFile("l.mp3");
    probeOk();
    const seen = twoPassMock("nonzero");
    const r = await transcodeFile(src, { target: "flac", loudnessNormalize: true });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("|")).toContain("降级为单遍动态");
    expect(seen[1].join(" ")).toContain("offset=0.0");
    expect(seen[1].join(" ")).not.toContain("linear=true");
  });

  it("两遍法：第一遍 spawn 抛错 → measure 内部 catch → 降级", async () => {
    const src = makeFile("m.mp3");
    probeOk();
    const seen = twoPassMock("throw");
    const r = await transcodeFile(src, { target: "flac", loudnessNormalize: true });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("|")).toContain("降级为单遍动态");
    expect(seen.length).toBe(2);
  });

  it("两遍法：第一遍子进程 error 事件 → 降级", async () => {
    const src = makeFile("n.mp3");
    probeOk();
    twoPassMock("error");
    const r = await transcodeFile(src, { target: "flac", loudnessNormalize: true });
    expect(r.warnings.join("|")).toContain("降级为单遍动态");
  });

  it("单遍模式（loudnessTwoPass:false）只跑一次 ffmpeg", async () => {
    const src = makeFile("o.mp3");
    probeOk();
    succeedMock();
    const r = await transcodeFile(src, {
      target: "flac",
      loudnessNormalize: true,
      loudnessTwoPass: false,
      loudnessTargetLufs: -16,
    });
    expect(r.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("wav 目标 + 响度归一化：osf 不写出流位深（wav 由 -c:a 定死）", async () => {
    const src = makeFile("p.mp3");
    probeOk({ bitDepth: 24 });
    let afArg = "";
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      afArg = args[args.indexOf("-af") + 1];
      const c = fakeChild();
      setImmediate(() => {
        writeFileSync(args[args.length - 1], "wave");
        c.emit("close", 0);
      });
      return c;
    });
    const r = await transcodeFile(src, { target: "wav", loudnessNormalize: true, loudnessTwoPass: false });
    expect(r.ok).toBe(true);
    expect(afArg).toContain("aresample");
    expect(afArg).not.toContain("osf=");
  });

  it("bitDepth=16 显式覆盖源 24bit → af 用 osf=s16", async () => {
    const src = makeFile("q.mp3");
    probeOk({ bitDepth: 24 });
    let afArg = "";
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      afArg = args[args.indexOf("-af") + 1];
      const c = fakeChild();
      setImmediate(() => {
        writeFileSync(args[args.length - 1], "x");
        c.emit("close", 0);
      });
      return c;
    });
    const r = await transcodeFile(src, {
      target: "flac", loudnessNormalize: true, loudnessTwoPass: false, bitDepth: 16,
    });
    expect(r.ok).toBe(true);
    expect(afArg).toContain("osf=s16:dither_method=triangular_hp");
  });

  it("源 24bit 且 auto → af 用 osf=s32", async () => {
    const src = makeFile("r.flac");
    probeOk({ container: "flac", bitDepth: 24 });
    let afArg = "";
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      afArg = args[args.indexOf("-af") + 1];
      const c = fakeChild();
      setImmediate(() => {
        writeFileSync(args[args.length - 1], "x");
        c.emit("close", 0);
      });
      return c;
    });
    const r = await transcodeFile(src, { target: "alac", loudnessNormalize: true, loudnessTwoPass: false });
    expect(r.ok).toBe(true);
    expect(afArg).toContain("osf=s32");
  });

  it("源采样率缺失 → osr 回落 48000", async () => {
    const src = makeFile("u.mp3");
    probeOk({ sampleRateHz: undefined, bitDepth: 16 });
    let afArg = "";
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      afArg = args[args.indexOf("-af") + 1];
      const c = fakeChild();
      setImmediate(() => {
        writeFileSync(args[args.length - 1], "x");
        c.emit("close", 0);
      });
      return c;
    });
    const r = await transcodeFile(src, { target: "flac", loudnessNormalize: true, loudnessTwoPass: false });
    expect(r.ok).toBe(true);
    expect(afArg).toContain("osr=48000");
  });

  it("旧参数 keepBitDepth16=false → 24bit 输出（args 无 -sample_fmt）", async () => {
    const src = makeFile("s.mp3");
    probeOk({ bitDepth: 16 });
    let args0: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      args0 = args;
      const c = fakeChild();
      setImmediate(() => {
        writeFileSync(args[args.length - 1], "x");
        c.emit("close", 0);
      });
      return c;
    });
    const r = await transcodeFile(src, { target: "flac", keepBitDepth16: false });
    expect(r.ok).toBe(true);
    expect(args0).not.toContain("-sample_fmt");
  });

  it("旧参数 keepBitDepth16=true → 16bit（args 含 -sample_fmt）", async () => {
    const src = makeFile("t.mp3");
    probeOk({ bitDepth: 24 });
    let args0: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      args0 = args;
      const c = fakeChild();
      setImmediate(() => {
        writeFileSync(args[args.length - 1], "x");
        c.emit("close", 0);
      });
      return c;
    });
    const r = await transcodeFile(src, { target: "flac", keepBitDepth16: true });
    expect(r.ok).toBe(true);
    expect(args0).toContain("-sample_fmt");
  });
});
