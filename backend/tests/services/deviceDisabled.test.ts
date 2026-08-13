// DLNA 设备禁用(播放器页开关)端到端测试:
//   - setDeviceDisabled 持久化 disabled(DB) + 同步内存缓存 + isDeviceDisabled 查询
//   - reconcileDlnaPeers 跳过禁用设备(不在任何选择播放器的地方出现),启用后重新注册
//   - castToDevice 拒绝禁用设备(防绕过:不仅 UI 不可见,直接调 API 也拒绝)
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { getPeerManager } from "../../src/services/peer.js";
import {
  getCachedDevices, setDeviceDisabled, isDeviceDisabled, castToDevice,
} from "../../src/services/dlna/control.js";

const TEST_DEV = "disabled-test-dev-1";

/** 向内存设备缓存注入一台测试设备(模拟 SSDP 发现的设备)。 */
function injectTestDevice(disabled = false): void {
  const arr = getCachedDevices();
  if (!arr.some(d => d.id === TEST_DEV)) {
    arr.push({
      id: TEST_DEV, name: "禁用测试设备", location: "",
      lastSeen: Date.now(), available: true, disabled,
    });
  } else {
    const d = arr.find(d => d.id === TEST_DEV)!;
    d.available = true;
    d.disabled = disabled;
  }
}

beforeAll(() => {
  initDatabase();
  injectTestDevice(false);
});

afterAll(() => {
  const arr = getCachedDevices();
  const i = arr.findIndex(d => d.id === TEST_DEV);
  if (i >= 0) arr.splice(i, 1);
  sqlite.prepare("DELETE FROM dlna_devices WHERE id = ?").run(TEST_DEV);
  getPeerManager().removeDlnaPeer(TEST_DEV);
});

describe("DLNA 设备禁用", () => {
  it("setDeviceDisabled 写 DB + 同步内存缓存,isDeviceDisabled 返回 true", () => {
    injectTestDevice(false);
    const dev = setDeviceDisabled(TEST_DEV, true);
    expect(dev?.disabled).toBe(true);
    expect(isDeviceDisabled(TEST_DEV)).toBe(true);
    // DB 持久化(重启后依然禁用)
    const row = sqlite.prepare("SELECT disabled FROM dlna_devices WHERE id = ?").get(TEST_DEV) as any;
    expect(row?.disabled).toBe(1);
  });

  it("reconcileDlnaPeers 跳过禁用设备;启用后重新注册为 peer", () => {
    const pm = getPeerManager();
    injectTestDevice(true);
    pm.reconcileDlnaPeers();
    expect(pm.list().some(p => p.peerId === `dlna:${TEST_DEV}`)).toBe(false);

    // 启用 → 重新注册,出现在选择播放器的列表里
    setDeviceDisabled(TEST_DEV, false);
    pm.reconcileDlnaPeers();
    expect(pm.list().some(p => p.peerId === `dlna:${TEST_DEV}`)).toBe(true);
  });

  it("castToDevice 拒绝禁用设备(防绕过)", async () => {
    setDeviceDisabled(TEST_DEV, true);
    await expect(castToDevice({
      songId: "song-1", title: "t", artist: "a", album: "al",
      mime: "audio/mpeg", deviceId: TEST_DEV, baseUrl: "http://127.0.0.1:3000",
    })).rejects.toThrow("设备已禁用");
    // 恢复启用,清理状态
    setDeviceDisabled(TEST_DEV, false);
    expect(isDeviceDisabled(TEST_DEV)).toBe(false);
  });
});
