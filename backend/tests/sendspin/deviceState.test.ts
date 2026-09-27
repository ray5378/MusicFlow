// ==================== Sendspin 设备持久化状态(deviceState) ====================
// 覆盖:音量/静音快照、禁用标记、主机记录、ESPHome 凭据的读写与清理。
// 模块导出较多且签名会演进,这里用 any 调用,避免测试被签名变动打断。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import * as ds from "../../src/services/sendspin/deviceState.js";
import * as pp from "../../src/services/playerPrefs.js";

const D = ds as any;

// 模块里的 log 是在加载时由 createLogger 造出来的,打桩要在 import 之前挂好。
const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../src/utils/logger.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  createLogger: () => ({ warn: log.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  log.warn.mockReset();
});

/** 最近一条 warn 的文案(用来确认"写失败"那一条确实留下了)。 */
function lastWarn(): string {
  const calls = log.warn.mock.calls;
  return String(calls[calls.length - 1][0]);
}

afterEach(() => {
  vi.restoreAllMocks();
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

// 这一组钉的是模块顶部那句约定:「读失败一律回退(无行/null),绝不阻断播控热路径」。
// 删掉任何一个 try/catch,异常都会冒到播控调用方 —— 表现为「调一下音量整个播放停了」。
describe("【兜底】持久化失败时一律回落,绝不把异常抛给播控", () => {
  beforeEach(() => {
    // 让每一次 prepare 都炸,逼所有 catch 走一遍。
    vi.spyOn(sqlite, "prepare").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
  });

  it("读音量失败 → null,并留一条带设备名的 warn", () => {
    expect(D.getDeviceVolumeState(cid("boom-vol"))).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][0])).toContain("[device-state] 读");
  });

  it("写音量失败 → 静默跳过,调用方以为成功就行", () => {
    expect(() => D.saveDeviceVolumeState(cid("boom-save"), { volume: 50 })).not.toThrow();
    // 内部先读一次旧值,那次失败也会记一条;这里要确认的是"写"本身也留了痕。
    expect(lastWarn()).toContain("[device-state] 写");
  });

  it("列禁用设备失败 → 空数组(不是让整页设备列表 500)", () => {
    expect(D.listDisabledDeviceIds()).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("删状态行失败 → 不抛", () => {
    expect(() => D.deleteDeviceVolumeState(cid("boom-del"))).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("清改名/隐藏偏好那步失败 → 设备行照样删掉,不回滚整个清理", () => {
    // 设备行删除本身在上一行就被吞了;这里专测「第二步炸了也不能连累第一步的结果」。
    vi.spyOn(pp, "purgePeerPrefsAllOwners").mockImplementation(() => {
      throw new Error("prefs 表坏了");
    });
    expect(() => D.purgeDeviceArtifacts(cid("boom-purge"))).not.toThrow();
    expect(lastWarn()).toContain("[device-state] 清");
  });

  it("读禁用态失败 → false(按「未禁用」放行,而不是把设备永久困住)", () => {
    expect(D.getDeviceDisabled(cid("boom-dis"))).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("读 ESPHome 凭据失败 → 空凭据(等于这台不连)", () => {
    expect(D.getDeviceEsphome(cid("boom-esp"))).toEqual({ psk: "", port: 0 });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("写 ESPHome 凭据失败 → 不抛", () => {
    expect(() => D.saveDeviceEsphome(cid("boom-esp2"), "PSK", 6053)).not.toThrow();
    expect(lastWarn()).toContain("[device-state] 写");
  });

  it("列 ESPHome 凭据失败 → 空数组(启动时就不会去批量 attach)", () => {
    expect(D.listEsphomeCreds()).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("写 host 失败 → 不抛(下一轮自动发现还能重试)", () => {
    expect(() => D.saveDeviceHost(cid("boom-host"), "192.168.10.77")).not.toThrow();
    expect(lastWarn()).toContain("[device-state] 写");
  });

  it("查禁用 host 失败 → false(宁可多拨一次,连上后会自动纠正)", () => {
    expect(D.isHostOfDisabledDevice("192.168.10.88")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("写禁用态失败 → 不抛", () => {
    expect(() => D.saveDeviceDisabled(cid("boom-dis2"), true)).not.toThrow();
    expect(lastWarn()).toContain("[device-state] 写");
  });
});
