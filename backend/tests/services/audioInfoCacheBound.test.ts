// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ==================== 源位深探测缓存的「有界性」守卫 ====================
//
// `services/source/audioInfo.ts` 的缓存是**进程级、按文件路径**记的：每首歌
// 只解析一次文件头，命中后出流热路径上只剩一次 statSync。
//
// 为什么必须钉住上限：这是一个**长跑服务**。一个上万首的曲库，把每一首播过的
// 歌都永久留在 Map 里 = 无界增长；而删掉那行 `cache.clear()` 不会有任何测试
// 变红（既有用例只探两三首歌，永远到不了 4096）。
//
// 判定手法（不依赖任何私有导出）：
//   ① 探 f0 → 解析 1 次；再探 f0 → **命中缓存**，仍是 1 次（证明缓存真的生效）；
//   ② 再探满 CACHE_MAX 个**新**路径 —— 第 CACHE_MAX 个会触发「整表清空」；
//   ③ 回头再探 f0 → 若上限生效，f0 已被清掉 ⇒ **必须重新解析**（调用数 +1）。
//      若上限被删掉，f0 仍在缓存里 ⇒ 调用数不变 ⇒ 用例转红。
//
// `parseFile` 用替身换掉：本文件测的是**缓存边界**，不是解析能力 ——
// 真解析（现造 16/24bit WAV 验文件头）在 tests/services/playerOutputBits.test.ts。
// 换掉之后 4097 次探测只剩「statSync + 记账」的成本，亚秒级完成。
const parseFileMock = vi.hoisted(() => vi.fn());
vi.mock("music-metadata", () => ({ parseFile: parseFileMock }));

import { _clearSourceBitsCache, probeSourceBits } from "../../src/services/source/audioInfo.js";

/** 从源码读上限，避免「改常量 → 用例失效」。改大了也必须在合理量级内。 */
const SOURCE = fs.readFileSync(new URL("../../src/services/source/audioInfo.ts", import.meta.url), "utf8");
const CACHE_MAX = Number(/const CACHE_MAX = (\d+)/.exec(SOURCE)?.[1] ?? NaN);

let tmpDir = "";
let linkPaths: string[] = [];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b49-cache-"));
  const target = path.join(tmpDir, "target.wav");
  fs.writeFileSync(target, Buffer.alloc(300));
  // 上限之外的每个路径都指向同一个真文件：statSync 认路径、内容一致，
  // 于是「缓存键不同」这件事被隔离出来（正是要测的）。
  linkPaths = [];
  for (let i = 0; i <= CACHE_MAX; i++) {
    const p = path.join(tmpDir, `f${i}`);
    // `type` 参数在 Windows 上需要显式给（跨平台 CI 友好）
    fs.symlinkSync(target, p, "file");
    linkPaths.push(p);
  }
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

beforeEach(() => {
  _clearSourceBitsCache();
  parseFileMock.mockReset();
  parseFileMock.mockImplementation(async () => ({ format: { bitsPerSample: 16 } }));
});

describe("源位深探测缓存：命中 + 有界", () => {
  it("CACHE_MAX 必须是合理量级（进程级文件元数据缓存，不该无界）", () => {
    expect(Number.isFinite(CACHE_MAX), "audioInfo.ts 里必须还有 CACHE_MAX 常量").toBe(true);
    expect(CACHE_MAX).toBeGreaterThan(0);
    expect(CACHE_MAX).toBeLessThanOrEqual(8192);
  });

  it("命中缓存不重复解析；超过上限后整表清空（最早那条被逐出，必须重新解析）", async () => {
    const at = (i: number) => ({ path: `l:src:${linkPaths[i]}`, type: "local" });

    // ① 首次解析 + 缓存命中
    expect(await probeSourceBits(at(0))).toBe(16);
    expect(parseFileMock).toHaveBeenCalledTimes(1);
    expect(await probeSourceBits(at(0))).toBe(16);
    expect(parseFileMock, "命中缓存不该再解析").toHaveBeenCalledTimes(1);

    // ② 探满 CACHE_MAX 个新路径（全部 miss）
    for (let i = 1; i <= CACHE_MAX; i++) {
      expect(await probeSourceBits(at(i))).toBe(16);
    }
    expect(parseFileMock, "每个新路径各解析一次").toHaveBeenCalledTimes(1 + CACHE_MAX);

    // ③ 回头看 f0：上限满过一次 ⇒ 已整表清空 ⇒ f0 必须重新解析
    expect(await probeSourceBits(at(0))).toBe(16);
    expect(
      parseFileMock,
      "上限没生效：f0 仍在缓存里，说明 cache.size >= CACHE_MAX 时没有清空（长跑服务会无界增长）",
    ).toHaveBeenCalledTimes(2 + CACHE_MAX);
  });
});
