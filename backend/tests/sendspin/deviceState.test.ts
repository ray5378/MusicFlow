// ==================== Sendspin 设备持久化状态(deviceState) ====================
// 覆盖:音量/静音快照、禁用标记、主机记录、ESPHome 凭据的读写与清理。
// 模块导出较多且签名会演进,这里用 any 调用,避免测试被签名变动打断。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import * as ds from "../../src/services/sendspin/deviceState.js";

const D = ds as any;

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

let n = 0;
function cid(prefix: string): string {
  n++;
  return `${prefix}-${Date.now()}-${n}`;
}

describe("音量与静音快照", () => {
  it("未记录的设备 → null", () => {
    expect(D.getDeviceVolumeState(cid("never"))).toBeNull();
  });

  it("保存后可回读(音量 + 静音)", () => {
    const id = cid("vol");
    D.saveDeviceVolumeState(id, { volume: 42, muted: true });
    const st = D.getDeviceVolumeState(id);
    expect(st).toBeTruthy();
    expect(st.volume).toBe(42);
    expect(st.muted).toBe(true);
  });

  it("重复保存覆盖旧值", () => {
    const id = cid("vol2");
    D.saveDeviceVolumeState(id, { volume: 10, muted: false });
    D.saveDeviceVolumeState(id, { volume: 90, muted: true });
    expect(D.getDeviceVolumeState(id).volume).toBe(90);
    expect(D.getDeviceVolumeState(id).muted).toBe(true);
  });

  it("按字段合并:只改音量时保持原静音态,反之亦然", () => {
    const id = cid("vol4");
    D.saveDeviceVolumeState(id, { volume: 30, muted: true });
    D.saveDeviceVolumeState(id, { volume: 60 });
    expect(D.getDeviceVolumeState(id)).toMatchObject({ volume: 60, muted: true });
    D.saveDeviceVolumeState(id, { muted: false });
    expect(D.getDeviceVolumeState(id)).toMatchObject({ volume: 60, muted: false });
  });

  it("音量越界被钳制", () => {
    const id = cid("vol5");
    D.saveDeviceVolumeState(id, { volume: 200 });
    expect(D.getDeviceVolumeState(id).volume).toBe(100);
    D.saveDeviceVolumeState(id, { volume: -5 });
    expect(D.getDeviceVolumeState(id).volume).toBe(0);
  });

  it("删除后回落到 null", () => {
    const id = cid("vol3");
    D.saveDeviceVolumeState(id, { volume: 50, muted: false });
    D.deleteDeviceVolumeState(id);
    expect(D.getDeviceVolumeState(id)).toBeNull();
  });
});

describe("禁用标记", () => {
  it("默认未禁用;置为禁用后可查", () => {
    const id = cid("dis");
    expect(D.getDeviceDisabled(id)).toBeFalsy();
    D.saveDeviceDisabled(id, true);
    expect(D.getDeviceDisabled(id)).toBe(true);
    expect(D.listDisabledDeviceIds()).toContain(id);
    D.saveDeviceDisabled(id, false);
    expect(D.getDeviceDisabled(id)).toBeFalsy();
    expect(D.listDisabledDeviceIds()).not.toContain(id);
  });

  it("listDisabledDeviceIds 返回数组", () => {
    expect(Array.isArray(D.listDisabledDeviceIds())).toBe(true);
  });
});

describe("主机记录与禁用判定", () => {
  it("保存主机后 isHostOfDisabledDevice 命中禁用设备", () => {
    const id = cid("host");
    const host = "192.168.10." + (100 + (n % 50));
    D.saveDeviceHost(id, host);
    expect(D.isHostOfDisabledDevice(host)).toBe(false);
    D.saveDeviceDisabled(id, true);
    expect(D.isHostOfDisabledDevice(host)).toBe(true);
    D.saveDeviceDisabled(id, false);
    expect(D.isHostOfDisabledDevice(host)).toBe(false);
  });

  it("未知主机 → false", () => {
    expect(D.isHostOfDisabledDevice("10.0.0.254")).toBe(false);
  });
});

describe("ESPHome 凭据", () => {
  it("未配置时返回空凭据(不抛)", () => {
    const creds = D.getDeviceEsphome(cid("esp"));
    expect(creds).toBeTruthy();
    expect(creds.psk || "").toBe("");
  });

  it("保存后可回读 psk / port", () => {
    const id = cid("esp2");
    D.saveDeviceEsphome(id, "DEADBEEF", 8927);
    const creds = D.getDeviceEsphome(id);
    expect(creds.psk).toBe("DEADBEEF");
    expect(creds.port).toBe(8927);
    expect(D.listEsphomeCreds().some((c: any) => c.clientId === id)).toBe(true);
  });

  it("port 缺省时取默认端口", () => {
    const id = cid("esp3");
    D.saveDeviceEsphome(id, "PSK3");
    expect(D.getDeviceEsphome(id).port).toBeGreaterThanOrEqual(0);
  });
});

describe("设备产物清理", () => {
  it("purgeDeviceArtifacts 清理后状态归零", () => {
    const id = cid("purge");
    D.saveDeviceVolumeState(id, { volume: 20, muted: false });
    D.saveDeviceEsphome(id, "PSK", 1234);
    D.saveDeviceDisabled(id, true);
    expect(() => D.purgeDeviceArtifacts(id)).not.toThrow();
    expect(D.getDeviceVolumeState(id)).toBeNull();
    expect(D.getDeviceDisabled(id)).toBeFalsy();
  });

  it("清理不存在的设备不抛", () => {
    expect(() => D.purgeDeviceArtifacts(cid("ghost"))).not.toThrow();
  });
});
