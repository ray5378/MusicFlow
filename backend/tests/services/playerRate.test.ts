// ==================== batch48 第一步：per-player 目标采样率（存取 + 裁决） ====================
//
// 背景：v4.2.3 把 HTTP/DLNA 转码链的降采样回落**写死 48k**，治好了「loudnorm 恒上采样
// 192kHz 直喂设备 → 变速变调」，但也把真支持 96K/192K 的设备一并降级。本模块给出
// 「每台播放器一个目标采样率」，缺省仍 48000（存量行为逐字节不变）。
//
// 锁四件事：
//   ① **归一化**：手动值只认白名单档位（防手滑）；探测值接受设备宣告的任意合法值
//      （ESPHome `sample_rate` 允许 16000~96000 的任意整数，不限于我们的五档）；
//   ② **裁决优先级**：手动 > 探测 > 缺省 48000；清手动**不清探测**；两者皆空删行；
//   ③ **群组取最低**（木桶原理）：成员一 96K 一 48K → 组内一律 48K；组外设备互不影响；
//      裸 id 成员按 DLNA 认；
//   ④ **热路径永不抛**：空 peerId / 无行 / 坏数据一律回落到缺省，绝不把出流卡死。
//
// 每个 `it` 自带前置状态（清表 + 清组）——本仓开了 `sequence.shuffle`，不依赖执行顺序。
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../src/db/index.js";
import { playerGroups, playerRateConfigs } from "../../src/db/schema.js";
import { getGroupManager } from "../../src/services/group/index.js";
import {
  DEFAULT_TARGET_RATE,
  RATE_OPTIONS,
  getPlayerRateConfig,
  listPlayerRateConfigs,
  normalizeProbedRate,
  normalizeTargetRate,
  rateScope,
  recordProbedRate,
  resolveDeviceRate,
  resolveTargetSampleRate,
  setPlayerRate,
} from "../../src/services/playerRate.js";

const A = "dlna:rate-device-a";
const B = "sendspin:rate-device-b";
const C = "dlna:rate-device-c";

/** 直接落一行组 + 重载（绕开 `assertMembersAvailable` 的设备在线校验，
 *  单测只关心「组成员的采样率怎么算」，不关心成员此刻是否在线）。 */
function seedGroup(id: string, members: string[]): void {
  db.insert(playerGroups)
    .values({ id, ownerUserId: "", name: `g-${id}`, memberIds: JSON.stringify(members), volume: 20, createdAt: "", updatedAt: "" })
    .run();
  getGroupManager().loadFromDb();
}

beforeEach(() => {
  db.delete(playerRateConfigs).run();
  db.delete(playerGroups).run();
  getGroupManager().loadFromDb();
});

describe("归一化：手动认白名单、探测认设备宣告", () => {
  it("手动档位只认五个刻度（数字/数字字符串都收），其余一律 null", () => {
    expect(RATE_OPTIONS).toEqual([48000, 88200, 96000, 176400, 192000]);
    for (const r of RATE_OPTIONS) {
      expect(normalizeTargetRate(r)).toBe(r);
      expect(normalizeTargetRate(String(r))).toBe(r);
    }
    // 非白名单值**不吸附**（下拉开不出这些值；吸附会把「传错了」伪装成「设置成功」）
    for (const bad of [44100, 12345, 47999, 192001, 0, -48000, NaN, "abc", {}, [], null, undefined, ""]) {
      expect(normalizeTargetRate(bad)).toBeNull();
    }
  });

  it("探测值接受设备宣告的任意合法整数（ESPHome 允许 16000~96000），越界/非法一律 null", () => {
    // 设备报 44100 也要认 —— 那是它 YAML 里真实配的值
    expect(normalizeProbedRate(44100)).toBe(44100);
    expect(normalizeProbedRate("96000")).toBe(96000);
    expect(normalizeProbedRate(22050)).toBe(22050);
    for (const bad of [7999, 192001, 0, -1, NaN, "abc", null, undefined, ""]) {
      expect(normalizeProbedRate(bad)).toBeNull();
    }
  });
});

describe("裁决优先级：手动 > 探测 > 缺省 48000", () => {
  it("三来源依次生效：探测填坑 → 手动压过 → 清手动回落到探测", () => {
    expect(resolveDeviceRate(A)).toBe(DEFAULT_TARGET_RATE);
    expect(DEFAULT_TARGET_RATE).toBe(48000);

    expect(recordProbedRate(A, 96000)).toBe(true);
    expect(getPlayerRateConfig(A)).toEqual({ manualRate: null, probedRate: 96000 });
    expect(resolveDeviceRate(A)).toBe(96000);

    setPlayerRate(A, 192000);
    expect(getPlayerRateConfig(A)).toEqual({ manualRate: 192000, probedRate: 96000 });
    expect(resolveDeviceRate(A)).toBe(192000); // 手动压过探测

    setPlayerRate(A, { rate: null }); // 清除手动 → 回落到探测值（**不清探测**）
    expect(getPlayerRateConfig(A)).toEqual({ manualRate: null, probedRate: 96000 });
    expect(resolveDeviceRate(A)).toBe(96000);
  });

  it("只有手动值时清空即删行（库里不留「等于没配置」的空行）", () => {
    setPlayerRate(A, 192000);
    expect(db.select().from(playerRateConfigs).all()).toHaveLength(1);
    expect(setPlayerRate(A, null)).toEqual({ manualRate: null, probedRate: null });
    expect(db.select().from(playerRateConfigs).all()).toEqual([]);
    expect(resolveDeviceRate(A)).toBe(DEFAULT_TARGET_RATE);
  });

  it("repeat 探测同值不重复写（设备每次重连都 hello，避免写放大）", () => {
    expect(recordProbedRate(B, 96000)).toBe(true);
    expect(recordProbedRate(B, 96000)).toBe(false);
    expect(recordProbedRate(B, 48000)).toBe(true);
    expect(db.select().from(playerRateConfigs).all()).toHaveLength(1);
    expect(getPlayerRateConfig(B).probedRate).toBe(48000);
  });

  it("非法探测值不落库、也不覆盖已有值", () => {
    recordProbedRate(B, 96000);
    expect(recordProbedRate(B, 123)).toBe(false);
    expect(recordProbedRate(B, "abc")).toBe(false);
    expect(getPlayerRateConfig(B).probedRate).toBe(96000);
  });

  it("空 peerId / 无行 / 空串一律回缺省（出流热路径永不抛）", () => {
    expect(resolveDeviceRate("")).toBe(DEFAULT_TARGET_RATE);
    expect(resolveDeviceRate(null)).toBe(DEFAULT_TARGET_RATE);
    expect(resolveDeviceRate("dlna:never-written")).toBe(DEFAULT_TARGET_RATE);
    expect(resolveTargetSampleRate("")).toBe(DEFAULT_TARGET_RATE);
    expect(resolveTargetSampleRate(undefined)).toBe(DEFAULT_TARGET_RATE);
    expect(getPlayerRateConfig("")).toEqual({ manualRate: null, probedRate: null });
    expect(setPlayerRate("", 96000)).toEqual({ manualRate: null, probedRate: null });
  });

  it("全量列表只回非空配置", () => {
    setPlayerRate(A, 96000);
    recordProbedRate(B, 48000);
    expect(listPlayerRateConfigs()).toEqual({
      [A]: { manualRate: 96000, probedRate: null },
      [B]: { manualRate: null, probedRate: 48000 },
    });
    expect(listPlayerRateConfigs()[C]).toBeUndefined();
  });
});

describe("群组取最低（木桶原理）：组内必须同率", () => {
  it("成员一 96K 一 48K → 组内一律取 48K；集体抬到 96K 才升", () => {
    seedGroup("g1", ["dlna:rate-device-a", "sendspin:rate-device-b"]);
    setPlayerRate(A, 96000);
    setPlayerRate(B, 96000);
    expect(resolveTargetSampleRate(A)).toBe(96000);
    expect(resolveTargetSampleRate("group:g1")).toBe(96000);

    setPlayerRate(B, 48000); // 组里来了一台只吃 48K 的
    expect(resolveTargetSampleRate(A)).toBe(48000);
    expect(resolveTargetSampleRate(B)).toBe(48000);
    expect(resolveTargetSampleRate("group:g1")).toBe(48000);

    setPlayerRate(B, 96000); // 它升上去，全组跟着升
    expect(resolveTargetSampleRate(A)).toBe(96000);
    expect(resolveTargetSampleRate("group:g1")).toBe(96000);
  });

  it("组员**没配置**＝按缺省 48K 参与取最低（不是被忽略）", () => {
    seedGroup("g1", ["dlna:rate-device-a", "sendspin:rate-device-b"]);
    setPlayerRate(A, 192000); // B 没配置 → 缺省 48000 拉低全组
    expect(resolveTargetSampleRate(A)).toBe(48000);
    expect(resolveTargetSampleRate("group:g1")).toBe(48000);
  });

  it("组外设备互不影响；不存在的 group: 回自己", () => {
    seedGroup("g1", ["dlna:rate-device-a", "sendspin:rate-device-b"]);
    setPlayerRate(A, 48000);
    setPlayerRate(C, 96000);
    expect(resolveTargetSampleRate(C)).toBe(96000);
    expect(resolveTargetSampleRate("group:does-not-exist")).toBe(48000);
  });

  it("裸 id 成员按 DLNA 认（历史数据口径，与 group/index.ts 一致）", () => {
    seedGroup("g1", ["rate-device-a"]);
    setPlayerRate(A, 96000);
    expect(rateScope("dlna:rate-device-a")).toEqual([A]);
    expect(resolveTargetSampleRate(A)).toBe(96000);
  });

  it("airplay / local 不参与组（RAOP 协议锁 44100，本机播放器不进组）", () => {
    seedGroup("g1", ["dlna:rate-device-a"]);
    expect(rateScope("airplay:ap-1")).toEqual(["airplay:ap-1"]);
    expect(rateScope("local:u-1")).toEqual(["local:u-1"]);
    expect(resolveTargetSampleRate("airplay:ap-1")).toBe(DEFAULT_TARGET_RATE);
  });

  it("设备同时在多个组 → 取并集成员的最低值（任一组拖低就得让）", () => {
    seedGroup("g1", ["dlna:rate-device-a", "sendspin:rate-device-b"]); // A:96K B:96K
    seedGroup("g2", ["dlna:rate-device-a", "dlna:rate-device-c"]); // A:96K C:48K
    setPlayerRate(A, 96000);
    setPlayerRate(B, 96000);
    setPlayerRate(C, 48000);
    expect(resolveTargetSampleRate(A)).toBe(48000);
  });
});
