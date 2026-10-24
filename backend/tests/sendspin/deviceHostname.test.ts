// ==================== Sendspin 设备 hostname(身份锚点) ====================
// 覆盖:规范化、落库/读取、幂等、空值忽略、与既有列共存不互相覆盖。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import {
  normalizeHostname,
  saveDeviceHostname,
  getDeviceHostname,
  saveDeviceHost,
  getDeviceLastHost,
  saveDeviceEsphome,
  getDeviceEsphome,
  getDeviceEsphomeByHostname,
  rememberHostnameByIp,
  getHostnameByIp,
  DEFAULT_SENDSPIN_VOLUME,
} from "../../src/services/sendspin/deviceState.js";

const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../src/utils/logger.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  createLogger: () => ({ warn: log.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

function row(clientId: string): any {
  return sqlite.prepare("SELECT * FROM sendspin_device_state WHERE client_id = ?").get(clientId);
}

describe("normalizeHostname", () => {
  it("去空白 + 小写 + 去 .local;空/undefined → 空串", () => {
    expect(normalizeHostname("  ESP32-Player2 ")).toBe("esp32-player2");
    expect(normalizeHostname("esp32-player2.local")).toBe("esp32-player2"); // mDNS 与 6053 同源同值
    expect(normalizeHostname("ESP32-Player2.local.")).toBe("esp32-player2");
    expect(normalizeHostname("")).toBe("");
    expect(normalizeHostname(undefined)).toBe("");
    expect(normalizeHostname(null)).toBe("");
  });
});

describe("IP → hostname 映射(设备上线前 mDNS 先于 WS 握手)", () => {
  it("记下后可读回;空值忽略", () => {
    rememberHostnameByIp("192.168.10.246", "esp32-player2.local");
    expect(getHostnameByIp("192.168.10.246")).toBe("esp32-player2");
    rememberHostnameByIp("192.168.10.246", "");
    expect(getHostnameByIp("192.168.10.246")).toBe("esp32-player2"); // 空值不覆盖
    expect(getHostnameByIp("192.168.10.1")).toBe("");
    expect(getHostnameByIp("")).toBe("");
  });
});

describe("getDeviceEsphomeByHostname(PSK 绑 hostname,不绑 clientId)", () => {
  it("按 hostname 从旧行继承 psk/port", () => {
    saveDeviceHostname("dev-old", "player-e");
    saveDeviceEsphome("dev-old", "PSK_E", 6054);
    expect(getDeviceEsphomeByHostname("player-e")).toEqual({ psk: "PSK_E", port: 6054 });
  });

  it("hostname 为空 → 空(绝不按 psk 反查设备,同 psk 多台会串台)", () => {
    expect(getDeviceEsphomeByHostname("")).toEqual({ psk: "", port: 0 });
    expect(getDeviceEsphomeByHostname("  ")).toEqual({ psk: "", port: 0 });
  });

  it("两台同 psk 设备各按自己的 hostname 命中,互不串台", () => {
    // 真机现况:主卧/客厅共用同一把 psk
    saveDeviceHostname("dev-bedroom", "player-bed");
    saveDeviceEsphome("dev-bedroom", "PSK_SHARED", 6053);
    saveDeviceHostname("dev-living", "player-live");
    saveDeviceEsphome("dev-living", "PSK_SHARED", 6053);
    expect(getDeviceEsphomeByHostname("player-bed").psk).toBe("PSK_SHARED");
    expect(getDeviceEsphomeByHostname("player-live").psk).toBe("PSK_SHARED");
    expect(getDeviceEsphomeByHostname("player-unknown")).toEqual({ psk: "", port: 0 });
  });

  it("同 hostname 多行时取最近更新的一行(重装后的新 clientId 优先)", () => {
    saveDeviceHostname("dev-lg-v1", "player-f");
    saveDeviceEsphome("dev-lg-v1", "PSK_OLD", 6053);
    // 同毫秒会打平,显式把旧行时间戳压早,模拟真实先后。
    sqlite
      .prepare("UPDATE sendspin_device_state SET updated_at = '2026-10-01T00:00:00.000Z' WHERE client_id = ?")
      .run("dev-lg-v1");
    saveDeviceHostname("dev-lg-v2", "player-f");
    saveDeviceEsphome("dev-lg-v2", "PSK_NEW", 6053);
    expect(getDeviceEsphomeByHostname("player-f").psk).toBe("PSK_NEW");
  });
});

describe("saveDeviceHostname / getDeviceHostname", () => {
  it("无行则建行(音量取缺省),再读回规范值", () => {
    saveDeviceHostname("dev-h1", "Player-A");
    expect(getDeviceHostname("dev-h1")).toBe("player-a");
    expect(row("dev-h1").volume).toBe(DEFAULT_SENDSPIN_VOLUME);
  });

  it("同值重复写幂等;改名覆盖", () => {
    saveDeviceHostname("dev-h2", "player-b");
    saveDeviceHostname("dev-h2", "PLAYER-B");
    expect(getDeviceHostname("dev-h2")).toBe("player-b");
    saveDeviceHostname("dev-h2", "player-b2");
    expect(getDeviceHostname("dev-h2")).toBe("player-b2");
  });

  it("空值/非法输入忽略(不建行、不覆盖已有值)", () => {
    saveDeviceHostname("dev-h3", "  ");
    expect(getDeviceHostname("dev-h3")).toBe("");
    saveDeviceHostname("dev-h3", "player-c");
    saveDeviceHostname("dev-h3", "");
    expect(getDeviceHostname("dev-h3")).toBe("player-c");
  });

  it("与 host / 6053 凭据共存互不覆盖", () => {
    saveDeviceHostname("dev-h4", "player-d");
    saveDeviceHost("dev-h4", "192.168.10.99");
    saveDeviceEsphome("dev-h4", "PSK_X", 6053);
    expect(getDeviceHostname("dev-h4")).toBe("player-d");
    expect(getDeviceLastHost("dev-h4")).toBe("192.168.10.99");
    expect(getDeviceEsphome("dev-h4").psk).toBe("PSK_X");
    // 反向:先有 host/psk,后补 hostname 也不动它们
    saveDeviceHostname("dev-h4", "player-d2");
    expect(getDeviceLastHost("dev-h4")).toBe("192.168.10.99");
    expect(getDeviceEsphome("dev-h4").psk).toBe("PSK_X");
  });

  it("未记录 hostname 的设备读回空串", () => {
    expect(getDeviceHostname("dev-not-exist")).toBe("");
    expect(getDeviceHostname("")).toBe("");
  });
});
