import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rebuild: vi.fn(async () => true),
  lightRestart: vi.fn(async () => true),
}));
vi.mock("../../src/services/airplay/control.js", () => ({
  bridgeRebuildDelayDevice: mocks.rebuild,
  bridgeLightRestart: mocks.lightRestart,
}));

import { bridgeSelfhealDispatch } from "../../src/services/airplay/selfhealExec.js";

// 自愈分级执行器：level1=retime / level2=lightRestart / 其它=告警忽略；空 deviceId 直接返回。
describe("bridgeSelfhealDispatch（自愈分级动作）", () => {
  beforeEach(() => vi.clearAllMocks());

  it("空 deviceId 不执行任何动作", () => {
    bridgeSelfhealDispatch("", 1, 0);
    expect(mocks.rebuild).not.toHaveBeenCalled();
    expect(mocks.lightRestart).not.toHaveBeenCalled();
  });

  it("level=1 → bridgeRebuildDelayDevice(deviceId, shiftUs, ...)", () => {
    bridgeSelfhealDispatch("dev-1", 1, 12345);
    expect(mocks.rebuild).toHaveBeenCalledWith("dev-1", 12345, "late-selfheal-retime");
    expect(mocks.lightRestart).not.toHaveBeenCalled();
  });

  it("level=2 → bridgeLightRestart(deviceId, ...)", () => {
    bridgeSelfhealDispatch("dev-2", 2, 0);
    expect(mocks.lightRestart).toHaveBeenCalledWith("dev-2", "late-selfheal-light-restart");
    expect(mocks.rebuild).not.toHaveBeenCalled();
  });

  it("未知 level（0/3/-1）不执行任何动作", () => {
    bridgeSelfhealDispatch("dev-3", 0, 0);
    bridgeSelfhealDispatch("dev-3", 3, 0);
    bridgeSelfhealDispatch("dev-3", -1, 0);
    expect(mocks.rebuild).not.toHaveBeenCalled();
    expect(mocks.lightRestart).not.toHaveBeenCalled();
  });

  it("下层动作返回 false（无会话/AP2）也不抛错", async () => {
    mocks.rebuild.mockResolvedValueOnce(false);
    mocks.lightRestart.mockResolvedValueOnce(false);
    expect(() => bridgeSelfhealDispatch("dev-4", 1, 0)).not.toThrow();
    expect(() => bridgeSelfhealDispatch("dev-4", 2, 0)).not.toThrow();
    await Promise.resolve();
  });

  it("下层动作抛错被 catch 吞掉（失败即升级，不回传）", async () => {
    mocks.rebuild.mockRejectedValueOnce(new Error("boom"));
    expect(() => bridgeSelfhealDispatch("dev-5", 1, 0)).not.toThrow();
  });
});
