// 覆盖率长尾补充:services/airplay/control.ts 中**可在单测里安全触达**的残余分支。
// 这里只补 hasAirPlayDevice(内存设备表的存在性判定);
// 其余残余行(fork 子进程链路 / 真实 RAOP 会话 finalizer / DLNA 同 host 转发失败回落)
// 需要 fork 模式 + 子进程 supervisor + 真实设备拓扑,不在本次范围内(见报告"跳过项")。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach } from "vitest";
import { hasAirPlayDevice } from "../../src/services/airplay/control.js";
import { addPersistedAirPlayDevice, removeAirPlayDevice, getAirPlayDevices } from "../../src/services/airplay/discovery.js";

beforeEach(() => {
  for (const d of getAirPlayDevices()) removeAirPlayDevice(d.id);
});

describe("hasAirPlayDevice", () => {
  it("内存设备表里没有该设备 → false", () => {
    expect(hasAirPlayDevice("ap-tail-none")).toBe(false);
  });

  it("发现(或从 DB 恢复)过该设备 → true(离线也算存在)", () => {
    addPersistedAirPlayDevice({
      id: "ap-tail-1",
      name: "Tail AirPlay",
      host: "192.168.1.50",
      port: 5000,
      supportsRsa: true,
      lastSeen: Date.now(),
      available: false, // 离线设备仍要在管理页可见 ⇒ 存在性判定不看 available
    });
    expect(hasAirPlayDevice("ap-tail-1")).toBe(true);
  });
});
