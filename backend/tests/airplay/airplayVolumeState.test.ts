// ==================== AirPlay 按设备音量/静音持久化(2026-10-21) ====================
//
// 覆盖:
//   1) 无行 → null(调用方回退 DEFAULT_AIRPLAY_VOLUME,行为与改动前一致);
//   2) 设置后可回读(音量 / 静音);
//   3) 只写 muted 时音量保持不变(取消静音必须恢复原音量);
//   4) 非法/越界值被钳制(0-100 整数);
//   5) 空 deviceId 不写库。
//
// MUST be the first import: 在 backend 模块加载前把 DATA_DIR 指到隔离临时目录。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import {
  getAirPlayVolumeState,
  saveAirPlayVolumeState,
  DEFAULT_AIRPLAY_VOLUME,
} from "../../src/services/airplay/deviceState.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

let n = 0;
function did(prefix: string): string {
  n++;
  return `${prefix}-${Date.now()}-${n}`;
}

describe("AirPlay 设备音量持久化", () => {
  it("未记录的设备 → null(缺省值由调用方决定)", () => {
    expect(getAirPlayVolumeState(did("never"))).toBeNull();
    // 缺省值必须与改动前的内存缺省一致,否则「从未设置过」的设备也会被改音量。
    expect(DEFAULT_AIRPLAY_VOLUME).toBe(80);
  });

  it("保存后可回读(音量 + 静音)", () => {
    const id = did("vol");
    saveAirPlayVolumeState(id, { volume: 42, muted: true });
    expect(getAirPlayVolumeState(id)).toEqual({ volume: 42, muted: true });
  });

  it("只写 muted:音量保持原值(取消静音恢复原音量)", () => {
    const id = did("mute");
    saveAirPlayVolumeState(id, { volume: 63 });
    saveAirPlayVolumeState(id, { muted: true });
    expect(getAirPlayVolumeState(id)).toEqual({ volume: 63, muted: true });
    saveAirPlayVolumeState(id, { muted: false });
    expect(getAirPlayVolumeState(id)).toEqual({ volume: 63, muted: false });
  });

  it("越界/小数被钳制为 0-100 的整数", () => {
    const a = did("clamp-hi");
    saveAirPlayVolumeState(a, { volume: 250 });
    expect(getAirPlayVolumeState(a)?.volume).toBe(100);
    const b = did("clamp-lo");
    saveAirPlayVolumeState(b, { volume: -7 });
    expect(getAirPlayVolumeState(b)?.volume).toBe(0);
    const c = did("round");
    saveAirPlayVolumeState(c, { volume: 55.6 });
    expect(getAirPlayVolumeState(c)?.volume).toBe(56);
  });

  it("空 deviceId 不写库、也不抛错", () => {
    expect(() => saveAirPlayVolumeState("", { volume: 30 })).not.toThrow();
    expect(getAirPlayVolumeState("")).toBeNull();
  });
});
