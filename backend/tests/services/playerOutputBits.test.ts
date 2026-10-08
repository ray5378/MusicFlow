// ==================== batch49 契约锁：输出位深（手动 16/24，自动=跟随源位深） ====================
//
// 背景：链里有 `loudnorm`，它内部走浮点 ⇒ **不显式指定 `osf` 时编码器恒吃 f32、
// FLAC 恒落 24bit**（230 实测：16bit 源经线上链出参 `s32 (24 bit)`）。所以
// 「跟随源位深」必须显式把源位深换算成 `osf=s16` / `osf=s32` 挂到出流侧那条
// `aresample` 上。230 同链实测 `osf=s16:dither_method=triangular_hp` → 出参 `s16`
// 且体积减半。
//
// 本文件锁四件事：
//   ① **归一化**：手动位深只认 16/24（防手滑）；源位深归档 20 位以上算 24；
//   ② **存取键独立**：只提交 `bits` 不会把采样率冲掉，反之亦然（两个下拉各改各的）；
//   ③ **群组取最低且跳过自动档**：成员一 16 一 24 → 全组 16；全自动 → 还是自动；
//   ④ **接线**：配置 → `resolveRequestAf` 链上的 `osf` 真的出现/消失，且**源位深探测**
//      读的是真实文件头（本文件现造 16bit / 24bit WAV）。
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../../src/db/index.js";
import { playerGroups, playerOutputConfigs } from "../../src/db/schema.js";
import { resolveRequestAf } from "../../src/routes/rest/index.js";
import { getGroupManager } from "../../src/services/group/index.js";
import { setSetting } from "../../src/services/settings.js";
import {
  BITS_OPTIONS,
  classifySourceBits,
  getPlayerRateConfig,
  normalizeTargetBits,
  resolveDeviceBits,
  resolveTargetBits,
  setPlayerRate,
} from "../../src/services/playerRate.js";
import { _clearSourceBitsCache, probeSourceBits } from "../../src/services/source/audioInfo.js";

const A = "dlna:bits-device-a";
const B = "sendspin:bits-device-b";
/** 无测量行 ⇒ 走实时 loudnorm（链里必然有 loudnorm，才会触发那段回落）。 */
const UNMEASURED = { id: "bits-unmeasured-song" };

/** 那条降采样回升的整条 aresample 片段。 */
function afFilter(af: string[]): string | undefined {
  return af.find((x) => x.includes("aresample="));
}

function seedGroup(id: string, members: string[]): void {
  db.insert(playerGroups)
    .values({ id, ownerUserId: "", name: `g-${id}`, memberIds: JSON.stringify(members), volume: 20, createdAt: "", updatedAt: "" })
    .run();
  getGroupManager().loadFromDb();
}

/** 现造一个最小合法 WAV（PCM），位深可控 —— 用来验「真的去读了文件头」。 */
function buildWav(bits: number, frames = 64): Buffer {
  const channels = 2;
  const rate = 44100;
  const bytesPerSample = bits / 8;
  const dataSize = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

let tmpDir = "";
let wav16 = "";
let wav24 = "";

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b49-bits-"));
  wav16 = path.join(tmpDir, "src16.wav");
  wav24 = path.join(tmpDir, "src24.wav");
  fs.writeFileSync(wav16, buildWav(16));
  fs.writeFileSync(wav24, buildWav(24));
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

beforeEach(() => {
  db.delete(playerOutputConfigs).run();
  db.delete(playerGroups).run();
  getGroupManager().loadFromDb();
  _clearSourceBitsCache();
  setSetting("pipeline.enabled", "1");
  setSetting("pipeline.http", "1");
  setSetting("pipeline.dlna", "1");
  setSetting("loudness.normalization", "1");
});

describe("位深归一化与源位深归档", () => {
  it("手动档位只认 16 / 24（数字与数字字符串都收），其余一律 null", () => {
    expect(BITS_OPTIONS).toEqual([16, 24]);
    expect(normalizeTargetBits(16)).toBe(16);
    expect(normalizeTargetBits(24)).toBe(24);
    expect(normalizeTargetBits("16")).toBe(16);
    expect(normalizeTargetBits("24")).toBe(24);
    for (const bad of [8, 20, 32, 0, -1, 15, 25, "abc", NaN, Infinity]) {
      expect(normalizeTargetBits(bad), `bits=${String(bad)}`).toBeNull();
    }
    // null / undefined / 空串 = 「清除手动位深」= 回到自动
    expect(normalizeTargetBits(null)).toBeNull();
    expect(normalizeTargetBits(undefined)).toBeNull();
    expect(normalizeTargetBits("")).toBeNull();
  });

  it("源位深归档：20 位以上算 24（FLAC 上限就是 24），拿不到 → null", () => {
    expect(classifySourceBits(16)).toBe(16);
    expect(classifySourceBits(24)).toBe(24);
    expect(classifySourceBits(32)).toBe(24);
    expect(classifySourceBits(20)).toBe(24);
    expect(classifySourceBits("24")).toBe(24);
    for (const bad of [undefined, null, 0, 4, "abc"]) {
      expect(classifySourceBits(bad), `src=${String(bad)}`).toBeNull();
    }
  });
});

describe("位深存取：与采样率各改各的（键独立）", () => {
  it("只提交 bits 不动采样率；只提交 rate 不动位深；都清空才删行", () => {
    setPlayerRate(A, { rate: 96000, bits: 24 });
    expect(getPlayerRateConfig(A)).toEqual({ manualRate: 96000, probedRate: null, manualBits: 24 });

    setPlayerRate(A, { bits: 16 }); // 只改位深
    expect(getPlayerRateConfig(A).manualRate, "只改位深不该把采样率冲掉").toBe(96000);
    expect(getPlayerRateConfig(A).manualBits).toBe(16);

    setPlayerRate(A, { rate: 48000 }); // 只改采样率
    expect(getPlayerRateConfig(A).manualBits, "只改采样率不该把位深冲掉").toBe(16);

    setPlayerRate(A, { rate: null }); // 清采样率 → 位深还在
    expect(getPlayerRateConfig(A).manualRate).toBeNull();
    expect(getPlayerRateConfig(A).manualBits).toBe(16);
    expect(db.select().from(playerOutputConfigs).all()).toHaveLength(1);

    setPlayerRate(A, { bits: null }); // 两个都空 → 删行
    expect(db.select().from(playerOutputConfigs).all()).toEqual([]);
  });

  it("裸值仍按「只改采样率」解释（batch48 老调用/老用例兼容）", () => {
    setPlayerRate(A, 96000);
    expect(getPlayerRateConfig(A).manualRate).toBe(96000);
    expect(getPlayerRateConfig(A).manualBits).toBeNull();
    setPlayerRate(A, { bits: 24 });
    setPlayerRate(A, 48000); // 裸值不该把刚设的位深抹掉
    expect(getPlayerRateConfig(A).manualBits).toBe(24);
  });

  it("非法位深不落库；空 peerId 一律回 null（热路径永不抛）", () => {
    setPlayerRate(A, { bits: 32 });
    expect(db.select().from(playerOutputConfigs).all()).toEqual([]);
    expect(resolveDeviceBits("")).toBeNull();
    expect(resolveDeviceBits(null)).toBeNull();
    expect(resolveDeviceBits("dlna:never-written")).toBeNull();
    expect(resolveTargetBits("")).toBeNull();
  });
});

describe("位深群组取最低（跳过自动档）", () => {
  it("成员一 16 一 24 → 全组 16；全自动 → 还是自动（null）", () => {
    seedGroup("bg1", [A, B]);
    expect(resolveTargetBits(A)).toBeNull();
    expect(resolveTargetBits("group:bg1")).toBeNull();

    setPlayerRate(A, { bits: 24 });
    expect(resolveTargetBits(A)).toBe(24);
    expect(resolveTargetBits("group:bg1"), "另一个成员是自动 ⇒ 不该把组钉到 24").toBe(24);

    setPlayerRate(B, { bits: 16 });
    expect(resolveTargetBits(A), "组里来了 16bit 设备 → 全组 16").toBe(16);
    expect(resolveTargetBits(B)).toBe(16);
    expect(resolveTargetBits("group:bg1")).toBe(16);

    setPlayerRate(B, { bits: 24 });
    expect(resolveTargetBits("group:bg1")).toBe(24);
  });

  it("组外设备互不影响；不存在的 group: 回自动", () => {
    seedGroup("bg1", [A, B]);
    setPlayerRate(A, { bits: 16 });
    expect(resolveTargetBits("dlna:bits-device-other")).toBeNull();
    expect(resolveTargetBits("group:does-not-exist")).toBeNull();
  });
});

describe("源位深探测：真的读文件头", () => {
  it("16bit WAV → 16；24bit WAV → 24；命中缓存后结果一致", async () => {
    const p16 = `l:src:${wav16}`;
    const p24 = `l:src:${wav24}`;
    expect(await probeSourceBits({ path: p16, type: "local" })).toBe(16);
    expect(await probeSourceBits({ path: p24, type: "local" })).toBe(24);
    // 第二次走缓存，结论必须一致
    expect(await probeSourceBits({ path: p16, type: "local" })).toBe(16);
  });

  it("远端源 / 缺 path / 文件不存在 / 坏路径 一律回 null（绝不抛）", async () => {
    expect(await probeSourceBits(null)).toBeNull();
    expect(await probeSourceBits({})).toBeNull();
    expect(await probeSourceBits({ path: `l:src:${wav16}`, type: "web" })).toBeNull();
    expect(await probeSourceBits({ path: `l:src:${path.join(tmpDir, "nope.wav")}`, type: "local" })).toBeNull();
    expect(await probeSourceBits({ path: "garbage", type: "local" })).toBeNull();
  });
});

describe("位深接线：osf 真的落到出流链上", () => {
  it("自动档 + 无源信息 → 老行为（不带 osf，与 v4.2.3 逐字节一致）", async () => {
    const f = afFilter(await resolveRequestAf(UNMEASURED, A));
    expect(f).toBe("aresample=resampler=swr:osr=48000");
  });

  it("手动 16bit → osf=s16 + 三角高频抖动；手动 24bit → osf=s32", async () => {
    setPlayerRate(A, { bits: 16 });
    expect(afFilter(await resolveRequestAf(UNMEASURED, A))).toBe(
      "aresample=resampler=swr:osr=48000:osf=s16:dither_method=triangular_hp",
    );

    setPlayerRate(A, { bits: 24 });
    expect(afFilter(await resolveRequestAf(UNMEASURED, A))).toBe(
      "aresample=resampler=swr:osr=48000:osf=s32",
    );
  });

  it("自动档跟源：16bit 源 → osf=s16；24bit 源 → osf=s32（同一设备，唯一变量是源）", async () => {
    const af16 = await resolveRequestAf({ id: "s16", path: `l:src:${wav16}`, type: "local" }, A);
    expect(afFilter(af16)).toBe("aresample=resampler=swr:osr=48000:osf=s16:dither_method=triangular_hp");

    const af24 = await resolveRequestAf({ id: "s24", path: `l:src:${wav24}`, type: "local" }, A);
    expect(afFilter(af24)).toBe("aresample=resampler=swr:osr=48000:osf=s32");
  });

  it("手动压过自动：源是 16bit 但手设 24 → 出 s32（用户说了算）", async () => {
    setPlayerRate(A, { bits: 24 });
    const af = await resolveRequestAf({ id: "s16", path: `l:src:${wav16}`, type: "local" }, A);
    expect(afFilter(af)).toBe("aresample=resampler=swr:osr=48000:osf=s32");
  });

  it("成组取最低**真的落到链上**：组里一台 16bit → 全组出 s16", async () => {
    seedGroup("bg2", [A, B]);
    setPlayerRate(A, { bits: 24 });
    setPlayerRate(B, { bits: 24 });
    expect(afFilter(await resolveRequestAf(UNMEASURED, A))).toContain("osf=s32");

    setPlayerRate(B, { bits: 16 });
    expect(afFilter(await resolveRequestAf(UNMEASURED, A))).toContain("osf=s16");
    expect(afFilter(await resolveRequestAf(UNMEASURED, B))).toContain("osf=s16");
  });
});
