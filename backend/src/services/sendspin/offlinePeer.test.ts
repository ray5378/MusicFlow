// 离线 Sendspin 设备必须**留在 peer 列表里**:断连只置 available=false,绝不删行
// (与 DLNA 的 markDlnaUnavailable / AirPlay 的 markAirPlayUnavailable 同口径)。
// 本文件锁死这条口径 —— 回归方向是「断连即摘除」会让用户在切换器 / 群组页再也
// 找不到该设备,且重连前它的队列与播放器条目会被孤儿清理扫掉。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPeerManager } from "../peer.js";
import {
  deleteDeviceVolumeState,
  listKnownDeviceIds,
  saveDeviceDisabled,
  saveDeviceHost,
} from "./deviceState.js";

describe("sendspin 离线 peer 保留(断连不摘除)", () => {
  const CID = "offline-peer-test-1";
  const PID = `sendspin:${CID}`;
  const pm = getPeerManager();

  beforeEach(() => {
    deleteDeviceVolumeState(CID);
    pm.removeSendspinPeer(CID); // 显式意图路径:只用于清测试现场
  });
  afterEach(() => {
    deleteDeviceVolumeState(CID);
    pm.removeSendspinPeer(CID);
  });

  it("已有 peer 行:断连只置 available=false,行保留(并广播一次 unavailable)", () => {
    pm.registerSendspin(CID, "Speaker", true);
    const seen: string[] = [];
    const onUnavailable = (p: any) => seen.push(p.peerId);
    pm.on("peer_unavailable", onUnavailable);
    try {
      pm.markSendspinUnavailable(CID, "Speaker");
      const p = pm.get(PID);
      expect(p).toBeTruthy();
      expect(p!.available).toBe(false);
      expect(p!.name).toBe("Speaker");
      expect(seen).toEqual([PID]);
      // 幂等:再调一次不重复广播,也不删行。
      pm.markSendspinUnavailable(CID);
      expect(pm.get(PID)?.available).toBe(false);
      expect(seen).toEqual([PID]);
    } finally {
      pm.off("peer_unavailable", onUnavailable);
    }
  });

  it("重连(registerSendspin)把同一行复活为 available=true", () => {
    pm.registerSendspin(CID, "Speaker", true);
    pm.markSendspinUnavailable(CID);
    expect(pm.get(PID)?.available).toBe(false);
    pm.registerSendspin(CID, "Speaker", true);
    expect(pm.get(PID)?.available).toBe(true);
  });

  it("无 peer 行但有持久档案 → 补一条 available:false 的占位 peer", () => {
    saveDeviceHost(CID, "192.168.1.9"); // 上线过 ⇒ 落在 sendspin_device_state
    expect(listKnownDeviceIds()).toContain(CID);
    pm.markSendspinUnavailable(CID, "Speaker");
    const p = pm.get(PID);
    expect(p).toBeTruthy();
    expect(p!.available).toBe(false);
    expect(p!.name).toBe("Speaker");
  });

  it("持久档案里没有这台设备 → 不凭空造 peer", () => {
    pm.markSendspinUnavailable(CID, "Speaker");
    expect(pm.get(PID)).toBeUndefined();
  });

  it("被用户禁用的设备不补占位 peer(与 DLNA / AirPlay 的 disabled 同语义)", () => {
    saveDeviceDisabled(CID, true);
    expect(listKnownDeviceIds()).not.toContain(CID);
    pm.markSendspinUnavailable(CID, "Speaker");
    expect(pm.get(PID)).toBeUndefined();
  });
});
