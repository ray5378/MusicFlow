// 失败语义归正（2026-10-12 · A+C）——**错误码专测**。
//
// 为什么单独一个文件：`verifyIntegrity` 的 probe 档要走到「能解析但拿不到时长」这条
// 分支，需要一个「解析成功、durationSec 为空」的样本 —— 现场造不出来（ffmpeg 生成的
// 容器都会写时长）。所以本文件把 `probeFile` 换成桩；真实的解析行为由 probe.test.ts /
// integrity.test.ts 覆盖。`vi.mock` 是**文件级**的，放这里才不会污染那两个真实用例。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFfmpeg } from "../../src/services/transcode.js";

vi.mock("../../src/services/fetch/probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/fetch/probe.js")>();
  return {
    ...actual,
    // 桩：能解析出音频流，但**读不出时长**（模拟部分 Ogg/Opus 容器）。
    probeFile: vi.fn(async (file: string) => ({
      path: file,
      bytes: 4096,
      container: "ogg",
      bitrateKbps: 128,
      hasCover: false,
    })),
  };
});

const { verifyIntegrity } = await import("../../src/services/fetch/integrity.js");
const { isPermanentFailureCode } = await import("../../src/services/fetch/attempts.js");

const DIR = mkdtempSync(join(tmpdir(), "mf-icodes-"));
const TMO = { timeout: 90_000 };
const MP3 = join(DIR, "ok.mp3");

beforeAll(() => {
  execFileSync(
    resolveFfmpeg(),
    ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", "-b:a", "320k", MP3],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}, TMO.timeout);

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("verifyIntegrity — 错误码语义", () => {
  it("非音频响应体（错误页）→ SOURCE_INVALID，且不进永久失效白名单", async () => {
    const f = join(DIR, "err.txt");
    writeFileSync(f, "Failed to fetch the resource");
    const r = await verifyIntegrity(f, "magic");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("SOURCE_INVALID");
    expect(r.code).not.toBe("INTEGRITY_FAILED");
    expect(isPermanentFailureCode(r.code)).toBe(false);
  });

  it("能解析但拿不到时长 → DURATION_UNKNOWN，且不进永久失效白名单", async () => {
    const r = await verifyIntegrity({ file: MP3, expect: { durationSec: 200, durationToleranceSec: 3 } }, "probe");
    expect(r.ok).toBe(false);
    expect(r.level).toBe("probe");
    expect(r.code).toBe("DURATION_UNKNOWN");
    expect(r.code).not.toBe("INTEGRITY_FAILED");
    expect(isPermanentFailureCode(r.code)).toBe(false);
  });

  it("没给期望时长时，读不出时长不算失败（只在有基准时才判）", async () => {
    const r = await verifyIntegrity(MP3, "probe");
    expect(r.ok).toBe(true);
  });
});
