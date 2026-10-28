// exp4 实验开关单测:四个 MF_BRIDGE_RAOP_* 开关全部缺省关闭;"1"/"true" 开启,其余值关闭。
import { afterEach, describe, expect, it } from "vitest";
import {
  raopBridgeConnectPrimeEnabled,
  raopBridgeFirstSyncNowEnabled,
} from "../../src/services/airplay/raop.js";
import {
  raopSuppressInitialVolume,
  raopSkipVolumeWithDlnaPeer,
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
