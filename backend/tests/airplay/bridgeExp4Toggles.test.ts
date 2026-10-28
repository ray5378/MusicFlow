// exp4 实验开关单测:四个 MF_BRIDGE_RAOP_* 开关全部缺省关闭;"1"/"true" 开启,其余值关闭。
// exp4b:shouldSkipBridgeInitialVolume 直测「有/无同 host DLNA peer」两分支(判据来自主进程载荷)。
import { afterEach, describe, expect, it } from "vitest";
import {
  raopBridgeConnectPrimeEnabled,
  raopBridgeFirstSyncNowEnabled,
} from "../../src/services/airplay/raop.js";
import {
  raopSuppressInitialVolume,
  raopSkipVolumeWithDlnaPeer,
  shouldSkipBridgeInitialVolume,
} from "../../src/services/airplay/bridgeSession.js";

const KEYS = [
  "MF_BRIDGE_RAOP_SUPPRESS_INITIAL_VOLUME",
  "MF_BRIDGE_RAOP_SKIP_VOLUME_WITH_DLNA_PEER",
  "MF_BRIDGE_RAOP_FIRST_SYNC_NOW",
  "MF_BRIDGE_RAOP_CONNECT_PRIME",
];

describe("exp4 桥实验开关(缺省关闭)", () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("缺省(未设置)= 关", () => {
    expect(raopSuppressInitialVolume()).toBe(false);
    expect(raopSkipVolumeWithDlnaPeer()).toBe(false);
    expect(raopBridgeFirstSyncNowEnabled()).toBe(false);
    expect(raopBridgeConnectPrimeEnabled()).toBe(false);
  });

  it("「1」= 开,「true」= 开,其余(0/false/空串)= 关", () => {
    process.env.MF_BRIDGE_RAOP_SUPPRESS_INITIAL_VOLUME = "1";
    expect(raopSuppressInitialVolume()).toBe(true);
    process.env.MF_BRIDGE_RAOP_SKIP_VOLUME_WITH_DLNA_PEER = "true";
    expect(raopSkipVolumeWithDlnaPeer()).toBe(true);
    process.env.MF_BRIDGE_RAOP_FIRST_SYNC_NOW = "1";
    expect(raopBridgeFirstSyncNowEnabled()).toBe(true);
    process.env.MF_BRIDGE_RAOP_CONNECT_PRIME = "true";
    expect(raopBridgeConnectPrimeEnabled()).toBe(true);
    process.env.MF_BRIDGE_RAOP_SUPPRESS_INITIAL_VOLUME = "0";
    expect(raopSuppressInitialVolume()).toBe(false);
    process.env.MF_BRIDGE_RAOP_FIRST_SYNC_NOW = "";
    expect(raopBridgeFirstSyncNowEnabled()).toBe(false);
  });
});

describe("exp4b shouldSkipBridgeInitialVolume(有/无同 host DLNA peer 两分支)", () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("全关 + 有 peer ⇒ 不跳(照发 SET_PARAMETER,现行为)", () => {
    expect(shouldSkipBridgeInitialVolume("dlna-dev")).toBe(false);
  });

  it("SKIP_WITH_DLNA_PEER=1 + 有 peer ⇒ 跳(Linkplay 豁免,对齐 solo)", () => {
    process.env.MF_BRIDGE_RAOP_SKIP_VOLUME_WITH_DLNA_PEER = "1";
    expect(shouldSkipBridgeInitialVolume("dlna-dev")).toBe(true);
  });

  it("SKIP_WITH_DLNA_PEER=1 + 无 peer ⇒ 不跳(无同 host DLNA 的设备照旧推音量)", () => {
    process.env.MF_BRIDGE_RAOP_SKIP_VOLUME_WITH_DLNA_PEER = "1";
    expect(shouldSkipBridgeInitialVolume(undefined)).toBe(false);
  });

  it("SUPPRESS=1 ⇒ 无条件跳(有无 peer 都跳)", () => {
    process.env.MF_BRIDGE_RAOP_SUPPRESS_INITIAL_VOLUME = "1";
    expect(shouldSkipBridgeInitialVolume(undefined)).toBe(true);
    expect(shouldSkipBridgeInitialVolume("dlna-dev")).toBe(true);
  });
});
