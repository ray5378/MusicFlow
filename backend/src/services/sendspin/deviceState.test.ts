// sendspin 按设备音量持久化:表读写 / 字段合并 / 夹取 / 删除(解绑与忘记设备时调)。
// 表在 tests/setup.ts 的 initDatabase() 里随全量 schema 一起建好。
import { describe, it, expect, beforeEach } from "vitest";
import { sqlite } from "../../db/index.js";
import {
  getDeviceVolumeState,
  saveDeviceVolumeState,
  deleteDeviceVolumeState,
  getDeviceDisabled,
  saveDeviceDisabled,
  getDeviceEsphome,
  saveDeviceEsphome,
  listEsphomeCreds,
} from "./deviceState.js";

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

  // ---- 禁用态(与 DLNA dlna_devices.disabled 同语义) ----

  it("禁用态缺省 false(无行即启用)", () => {
    expect(getDeviceDisabled(CID)).toBe(false);
    expect(getDeviceDisabled("")).toBe(false);
  });

  it("写禁用态后可读回;不产生第二行", () => {
    saveDeviceDisabled(CID, true);
    expect(getDeviceDisabled(CID)).toBe(true);
    expect(rowCount()).toBe(1);
    saveDeviceDisabled(CID, false);
    expect(getDeviceDisabled(CID)).toBe(false);
    expect(rowCount()).toBe(1);
  });

  it("禁用态与音量互不覆盖(同一行两个独立字段)", () => {
    saveDeviceVolumeState(CID, { volume: 33, muted: true });
    saveDeviceDisabled(CID, true);
    // 写禁用不该动音量/静音
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 33, muted: true });
    expect(getDeviceDisabled(CID)).toBe(true);
    // 写音量不该动禁用
    saveDeviceVolumeState(CID, { volume: 44 });
    expect(getDeviceDisabled(CID)).toBe(true);
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 44, muted: true });
    expect(rowCount()).toBe(1);
  });

  it("无行时直接写禁用态也能建行(volume/muted 取缺省)", () => {
    saveDeviceDisabled(CID, true);
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 100, muted: false });
    expect(getDeviceDisabled(CID)).toBe(true);
  });

  it("解绑(删行)会一并清掉禁用态 —— 与「解绑即删除播放器」一致", () => {
    saveDeviceDisabled(CID, true);
    deleteDeviceVolumeState(CID);
    expect(getDeviceDisabled(CID)).toBe(false);
  });

  // ---- ESPHome 6053 凭据(每台设备各自一把;按 clientId 存,不按会变的 host) ----

  it("无行返回空凭据 psk='' / port=0(即「不连 6053」)", () => {
    expect(getDeviceEsphome(CID)).toEqual({ psk: "", port: 0 });
    expect(getDeviceEsphome("")).toEqual({ psk: "", port: 0 });
  });

  it("写密钥后可读回;端口非法回退 0(=用缺省 6053);psk 去空白", () => {
    saveDeviceEsphome(CID, "  secret-key  ", 6054);
    expect(getDeviceEsphome(CID)).toEqual({ psk: "secret-key", port: 6054 });
    // 非法端口:0 / 越界 / 小数 / 非数字 一律落 0,交给上层回退 6053
    for (const p of [0, -1, 70000, 1.5, Number.NaN]) {
      saveDeviceEsphome(CID, "k", p as number);
      expect(getDeviceEsphome(CID).port).toBe(0);
    }
    saveDeviceEsphome(CID, "k", 6053);
    expect(getDeviceEsphome(CID).port).toBe(6053);
  });

  it("关键:每台设备各存各的密钥,互不覆盖(不是全局一把)", () => {
    const A = "dev-state-esp-a";
    const B = "dev-state-esp-b";
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id IN (?, ?)").run(A, B);
    saveDeviceEsphome(A, "key-a", 6053);
    saveDeviceEsphome(B, "key-b", 6054);
    expect(getDeviceEsphome(A)).toEqual({ psk: "key-a", port: 6053 });
    expect(getDeviceEsphome(B)).toEqual({ psk: "key-b", port: 6054 });
    // 清 A 不影响 B
    saveDeviceEsphome(A, "", 0);
    expect(getDeviceEsphome(A)).toEqual({ psk: "", port: 0 });
    expect(getDeviceEsphome(B)).toEqual({ psk: "key-b", port: 6054 });
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id IN (?, ?)").run(A, B);
  });

  it("写密钥不动 volume / muted / disabled(同一行四个独立字段)", () => {
    saveDeviceVolumeState(CID, { volume: 21, muted: true });
    saveDeviceDisabled(CID, true);
    saveDeviceEsphome(CID, "k", 6053);
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 21, muted: true });
    expect(getDeviceDisabled(CID)).toBe(true);
    expect(getDeviceEsphome(CID)).toEqual({ psk: "k", port: 6053 });
    expect(rowCount()).toBe(1);
  });

  it("无行时直接写密钥也能建行(volume/muted 取缺省)", () => {
    saveDeviceEsphome(CID, "k", 6053);
    expect(getDeviceVolumeState(CID)).toEqual({ volume: 100, muted: false });
    expect(rowCount()).toBe(1);
  });

  it("listEsphomeCreds 只列已填密钥的设备,空串一律排除", () => {
    const A = "dev-state-esp-list-a";
    const B = "dev-state-esp-list-b";
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id IN (?, ?)").run(A, B);
    saveDeviceEsphome(A, "key-a", 6053);
    saveDeviceEsphome(B, "", 6053); // 没填 → 不该出现在列表里
    const listed = listEsphomeCreds().filter((c) => c.clientId === A || c.clientId === B);
    expect(listed).toEqual([{ clientId: A, psk: "key-a", port: 6053 }]);
    sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id IN (?, ?)").run(A, B);
  });
});
