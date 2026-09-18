// sendspin 按设备音量持久化:表读写 / 字段合并 / 夹取 / 删除(解绑与忘记设备时调)。
// 表在 tests/setup.ts 的 initDatabase() 里随全量 schema 一起建好。
import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../../db/index.js";
import { getDeviceVolumeState, saveDeviceVolumeState, deleteDeviceVolumeState } from "./deviceState.js";

describe("sendspin deviceState (按设备持久音量)", () => {
  const CID = "dev-state-test-1";
  const rowCount = () =>
    (sqlite.prepare("SELECT COUNT(*) AS c FROM sendspin_device_state WHERE client_id = ?").get(CID) as any).c;

  beforeEach(() => {
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id = ?").run(CID);
  });

  it("无行返回 null(调用方回退缺省 100/false)", () => {
    expect(getDeviceVolumeState(CID)).toBeNull();
  });

  it("写入后可读回;按字段合并,另一字段保持不变;upsert 不产生第二行", () => {
    saveDeviceVolumeState(CID, { volume: 42 });
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 42, muted: false });
    // 只改 muted → volume 保留
    saveDeviceVolumeState(CID, { muted: true });
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 42, muted: true });
    // 只改 volume → muted 保留
    saveDeviceVolumeState(CID, { volume: 7 });
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 7, muted: true });
    expect(rowCount()).toBe(1);
  });

  it("音量夹取到 0..100,非法值回退 100", () => {
    saveDeviceVolumeState(CID, { volume: 250 });
    expect(getDeviceVolumeState(CID)!.volume).toBe(100);
    saveDeviceVolumeState(CID, { volume: -5 });
    expect(getDeviceVolumeState(CID)!.volume).toBe(0);
    saveDeviceVolumeState(CID, { volume: Number.NaN });
    expect(getDeviceVolumeState(CID)!.volume).toBe(100);
  });

  it("空 clientId 一律 no-op(不建行、不报错)", () => {
    saveDeviceVolumeState("", { volume: 30 });
    expect(getDeviceVolumeState("")).toBeNull();
  });

  it("删除后回到无行(解绑 / 忘记设备语义),重复删除幂等", () => {
    saveDeviceVolumeState(CID, { volume: 55, muted: true });
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 55, muted: true });
    deleteDeviceVolumeState(CID);
    expect(getDeviceVolumeState(CID)).toBeNull();
    deleteDeviceVolumeState(CID);
    expect(getDeviceVolumeState(CID)).toBeNull();
  });
});
