// BridgeSessionManager.prepare 暖复用(B 方案,对齐 MA _can_reuse_stream_warm):
// 同 token + 同设备 + 同协议 + 同 RAOP 目标且会话健康 ⇒ 原样续用(不拆不建);
// token 变 ⇒ 冷启(拆旧建新)。dry 会话(不传 host/port)不连真设备。
import { afterAll, describe, expect, it } from "vitest";
import { BridgeSessionManager } from "../../src/services/airplay/bridgeSession.js";

function opts(token: string) {
  return {
    deviceId: "dev-1",
    token,
    protocol: "raop" as const,
    socketPath: `/tmp/mf-bsw-${token}.sock`,
    dry: true,
  };
}

describe("BridgeSessionManager.prepare 暖复用(B 方案)", () => {
  const mgr = new BridgeSessionManager();
  afterAll(async () => {
    await mgr.stopAll();
  });

  it("同 token 同设备同协议 ⇒ 第二次 prepare 原样续用(不拆不建,同 socketPath)", async () => {
    const r1 = await mgr.prepare(opts("tokW"));
    const r2 = await mgr.prepare(opts("tokW"));
    expect(r2.socketPath).toBe(r1.socketPath);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0]!.token).toBe("tokW");
  });

  it("token 变 ⇒ 冷启:旧会话拆除,只留新会话", async () => {
    const r1 = await mgr.prepare(opts("tokW"));
    const r2 = await mgr.prepare(opts("tokC"));
    expect(r2.socketPath).not.toBe(r1.socketPath);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0]!.token).toBe("tokC");
  });
});
