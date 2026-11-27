import { describe, it, expect, afterEach } from "vitest";
import { playerIsolationEnabled } from "../../src/services/playerHost/isolationFlag.js";

// 播放器隔离总开关：默认开启（唯一架构），MF_PLAYER_ISOLATION=0 应急回滚。
describe("playerIsolationEnabled", () => {
  const saved = process.env.MF_PLAYER_ISOLATION;
  afterEach(() => {
    if (saved === undefined) delete process.env.MF_PLAYER_ISOLATION;
    else process.env.MF_PLAYER_ISOLATION = saved;
  });

  it("默认开启（未设 env）", () => {
    delete process.env.MF_PLAYER_ISOLATION;
    expect(playerIsolationEnabled()).toBe(true);
  });

  it("MF_PLAYER_ISOLATION=0 强制关闭", () => {
    process.env.MF_PLAYER_ISOLATION = "0";
    expect(playerIsolationEnabled()).toBe(false);
  });

  it("非 '0' 的值（含 1/空/其它）仍开启", () => {
    for (const v of ["1", "true", "", "2"]) {
      process.env.MF_PLAYER_ISOLATION = v;
      expect(playerIsolationEnabled()).toBe(true);
    }
  });
});
