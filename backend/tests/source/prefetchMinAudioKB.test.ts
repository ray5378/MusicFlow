// ==================== 判官「中段缓冲」兜底（2026-10-27 二次补刀） ====================
//
// 事故（240 实测《纵身一跃》）：`minAudioKB` 是 settings 可调项，240 上被调到 **2048**。
// 上游给的是 972KB 的**真音频**（129kbps 的 60s 试听），按 2MB 阈值落进 too-small 分支，
// 而我按 32kbps 地板算的硬下界（217s×4KB=868KB）**装得下它** ⇒ 按弱信号放行 ⇒ 照播
// 60s 假歌。体积判据跟着可调项一起漂，光靠它必然漏掉「够小但内容仍不完整」的源。
//
// 本文件锁住修复后的语义：**≥64KB 的缓冲 music-metadata 解析是可靠的** —— 解析出
// 真实时长且比基准短超判死线 ⇒ 照 preview 档判死；解析失败/解不出时长才保守放过。
// DATA_DIR 隔离由 vitest 的 tests/setup.ts 统一负责（每文件独立 SQLite 库）。
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { initDatabase, sqlite } from "../../../src/db/index.js";
import { judgePrefetchedBuffer } from "../../../src/services/source/prefetchCache.js";

const KEY = "prefetch.settings";
/** 240 生产实例的实际值（minAudioKB=2048）。 */
const SETTINGS_240 = JSON.stringify({
  lookahead: 1,
  concurrency: 1,
  budgetRatio: 0.5,
  deadlineSec: 120,
  stallSec: 30,
  entryTtlSec: 600,
  maxAltSources: 4,
  integrityDeltaSec: 30,
  integrityBitrateDeltaSec: 80,
  minAudioKB: 2048,
  integrityEnabled: true,
});

// music-metadata 的 parseBuffer 由本文件控制（判官时长档的输入）。
const mm = vi.hoisted(() => ({ duration: 60, fail: false }));
vi.mock("music-metadata", () => ({
  parseBuffer: async () => {
    if (mm.fail) throw new Error("mock parse failure");
    return {
      format: { duration: mm.duration, bitrate: 128000, container: "mp3" },
      common: {},
    };
  },
}));

/** 合法音频头的 mp3（ID3v2 + 静音填充）—— magic 认它是音频。 */
function mp3Bytes(bytes: number): Buffer {
  const head = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 0)]);
}

beforeAll(() => {
  initDatabase();
  sqlite
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(KEY, SETTINGS_240);
});

afterEach(() => {
  mm.duration = 60;
  mm.fail = false;
});

afterAll(() => {
  sqlite.prepare("DELETE FROM settings WHERE key = ?").run(KEY);
});

describe("minAudioKB=2048：972KB 的真实 60s 试听必须判死", () => {
  it("972KB 真音频(解析 60s) vs 期望 217s ⇒ preview 判死（落进 too-small 分支也照判）", async () => {
    const v = await judgePrefetchedBuffer(mp3Bytes(972 * 1000), 217);
    expect(v.dead).toBe(true);
    expect(v.reason).toBe("preview");
    expect(v.via).toBe("metadata");
    expect(v.actualSec).toBe(60);
    expect(v.expectedSec).toBe(217);
  });

  it("972KB 但 metadata 解析失败 ⇒ 保守放过（弱信号 too-small，同规则 4）", async () => {
    mm.fail = true;
    const v = await judgePrefetchedBuffer(mp3Bytes(972 * 1000), 217);
    expect(v.dead).toBe(true);
    expect(v.reason).toBe("too-small");
  });

  it("972KB 且头声明 217s（内容被裁但 metadata 报全长）⇒ 保守放过（已知盲区，宁漏不错杀）", async () => {
    mm.duration = 217;
    const v = await judgePrefetchedBuffer(mp3Bytes(972 * 1000), 217);
    expect(v.dead).toBe(true);
    expect(v.reason).toBe("too-small");
  });

  it("<64KB 仍走硬算术下界：10KB vs 期望 217s ⇒ too-small-hard（不依赖 metadata）", async () => {
    const v = await judgePrefetchedBuffer(mp3Bytes(10 * 1024), 217);
    expect(v.dead).toBe(true);
    expect(v.reason).toBe("too-small-hard");
  });

  it("短于 minAudioKB 但内容完整（972KB 解析 10s / 期望 10s）⇒ 仍是 too-small（播放侧回退直通，音量档语义不变）", async () => {
    mm.duration = 10;
    const v = await judgePrefetchedBuffer(mp3Bytes(972 * 1000), 10);
    expect(v.dead).toBe(true);
    expect(v.reason).toBe("too-small");
  });
});
