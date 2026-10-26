// ==================== Phase 3:syncGroupBridges 幂等同步 + 组泵→真桥端到端 ====================
//
// 两部分:
//   A) 单测:syncGroupBridges 的幂等/热复用/摘除语义 —— seek 走 playGroupCore 重建时
//      重复调用必须零副作用(BLK-02:热复用 = 桥不重连;bridges.size 不变)。
//   B) E2E:真 BridgeServer + 真 BridgeMember(UDS 会合)+ SendspinGroup.pushFrame ——
//      组泵 PCM 逐字节走到 MFAB AUDIO 帧;notifyBridgeGeneration/clearPlayback 的
//      BOUNDARY 端到端可见。判据:字节一致、generation/sequence 正确、单桥失败不连累组泵。
import { describe, expect, it } from "vitest";

import { bridgeSocketPath } from "../../src/services/airplay/bridgeChannel.js";
import { BridgeServer } from "../../src/services/airplay/bridgeServer.js";
import { BridgeMember } from "../../src/services/sendspin/bridgeMember.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { nowUs } from "../../src/services/sendspin/clock.js";
import {
  syncGroupBridges,
  detachGroupBridge,
  clearGroupBridges,
  type BridgeSocketSpec,
  type BridgeMemberFactory,
} from "../../src/services/sendspin/bridgeAttach.js";

async function until(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ------------------------------------------------------------------
// A) syncGroupBridges:幂等同步 / 热复用 / 摘除(桩 factory,无 IO)
// ------------------------------------------------------------------

function fakeHandle(deviceId: string) {
  const h: any = {
    deviceId,
    started: 0,
    stopped: 0,
    pushAudio() {},
    notifyGeneration() {},
    sendBoundary() {},
    start() {
      h.started++;
    },
    stop() {
      h.stopped++;
    },
  };
  return h;
}

function fakeFactory(made: any[]): BridgeMemberFactory {
  return (spec) => {
    const h = fakeHandle(spec.deviceId);
    made.push(h);
    return h;
  };
}

const spec = (deviceId: string, token = `tok-${deviceId}`): BridgeSocketSpec => ({
  deviceId,
  socketPath: `/tmp/mfab/${deviceId}.sock`,
  token,
  protocol: "raop",
});

describe("A) syncGroupBridges:幂等同步 / 热复用 / 摘除", () => {
  it("★ 同规格重复 sync(模拟 seek 重建)→ 热复用:factory 只调一次、start 一次、bridges.size 不变", () => {
    const g = new SendspinGroup("g-sync", { log() {} } as any);
    const made: any[] = [];
    const s = spec("ap-1");

    syncGroupBridges(g, [s], fakeFactory(made));
    expect(g.bridges.size).toBe(1);
    expect(g.bridgeSpecs).toEqual([s]);

    syncGroupBridges(g, [s], fakeFactory(made)); // seekCore 重建路径重复调用
    expect(made).toHaveLength(1); // 热复用:没有新建句柄
    expect(made[0].started).toBe(1);
    expect(made[0].stopped).toBe(0); // 也没被拆 → 连接原样保留
    expect(g.bridges.size).toBe(1);
    expect(g.bridges.get("ap-1")).toBe(made[0]);
  });

  it("规格变化 → 停旧起新;不在新集合的设备 → 摘除并 stop", () => {
    const g = new SendspinGroup("g-sync", { log() {} } as any);
    const made: any[] = [];
    const factory = fakeFactory(made);

    syncGroupBridges(g, [spec("ap-1"), spec("ap-2")], factory);
    expect(g.bridges.size).toBe(2);
    expect(made).toHaveLength(2);

    // ap-1 换 token(= 主进程重新 bridgePrepare)→ 停旧起新;ap-2 不在新集合 → 摘除
    syncGroupBridges(g, [spec("ap-1", "tok-new")], factory);
    expect(made[0].stopped).toBe(1); // 旧 ap-1 被拆
    expect(made[1].stopped).toBe(1); // ap-2 被摘
    expect(made[2].deviceId).toBe("ap-1"); // 新 ap-1
    expect(g.bridges.size).toBe(1);
    expect(g.bridgeSpecs).toEqual([spec("ap-1", "tok-new")]);
  });

  it("空集合 sync → 全清(bridgeSpecs 归零)", () => {
    const g = new SendspinGroup("g-sync", { log() {} } as any);
    const made: any[] = [];
    syncGroupBridges(g, [spec("ap-1")], fakeFactory(made));
    syncGroupBridges(g, [], fakeFactory(made));
    expect(g.bridges.size).toBe(0);
    expect(g.bridgeSpecs).toEqual([]);
    expect(made[0].stopped).toBe(1);
  });

  it("detachGroupBridge:摘单座桥返回 true;再摘返回 false(幂等)", () => {
    const g = new SendspinGroup("g-sync", { log() {} } as any);
    const made: any[] = [];
    syncGroupBridges(g, [spec("ap-1")], fakeFactory(made));
    expect(detachGroupBridge(g, "ap-1")).toBe(true);
    expect(made[0].stopped).toBe(1);
    expect(g.bridgeSpecs).toEqual([]);
    expect(detachGroupBridge(g, "ap-1")).toBe(false);
  });

  it("clearGroupBridges:句柄逐个 stop 后清空(stopGroupCore 收尾语义)", () => {
    const g = new SendspinGroup("g-sync", { log() {} } as any);
    const made: any[] = [];
    syncGroupBridges(g, [spec("ap-1"), spec("ap-2")], fakeFactory(made));
    clearGroupBridges(g);
    expect(g.bridges.size).toBe(0);
    expect(g.bridgeSpecs).toEqual([]);
    expect(made.every((h) => h.stopped === 1)).toBe(true);
  });
});

// ------------------------------------------------------------------
// B) E2E:组泵 → 真桥(UDS 会合,字节/代次端到端)
// ------------------------------------------------------------------

describe("B) 组泵 → 真桥 E2E(出口判据:组泵 PCM 逐字节到 MFAB AUDIO)", () => {
  it("真 BridgeServer + BridgeMember:pushFrame → 桥收 AUDIO(字节一致/generation 正确);BOUNDARY track/seek 可见", async () => {
    const n = Math.floor(Math.random() * 1e9);
    const deviceId = `e2e-${n}`;
    const token = `e2e-${n}`;
    const recv = {
      audio: [] as Array<{ tsUs: bigint; generation: number; sequence: number; payload: Uint8Array }>,
      boundaries: [] as Array<[number, string]>,
    };
    const bs = new BridgeServer(
      { deviceId, token, protocol: "raop" },
      {
        onAudio: (a) => {
          recv.audio.push(a);
        },
        onBoundary: (gen, reason) => {
          recv.boundaries.push([gen, reason]);
        },
      },
    );
    await bs.listen(bridgeSocketPath(deviceId, token));
    const member = new BridgeMember({
      deviceId,
      token,
      protocol: "raop",
      socketPath: bs.listeningOn!,
      heartbeatMs: 0,
      backoffDelayMs: () => 20,
    });
    member.start();
    let g: SendspinGroup | undefined; // 提升作用域:finally 停补投定时器用
    try {
      await until(() => bs.stats().sessionsAccepted === 1, "accepted");

      g = new SendspinGroup("g-e2e", { log() {} } as any);
      syncGroupBridges(g, [{ deviceId, socketPath: bs.listeningOn!, token, protocol: "raop" }], () => member as any);
      expect(g.hasBridges()).toBe(true);
      expect(g.bridges.size).toBe(1);

      // 预置 pcm:100 编码器:吐 2 个可辨识 chunk(各 480 样本)
      const payload0 = new Uint8Array(1200).fill(0xa1);
      const payload1 = new Uint8Array(1200).fill(0xb2);
      let call = 0;
      (g as any).encoders.set("pcm:100", {
        async encode(): Promise<any[]> {
          return call++ === 0
            ? [{ frameSamples: 480, data: payload0 }, { frameSamples: 480, data: payload1 }]
            : [];
        },
        async flush() {
          return [];
        },
        close() {},
      });

      // §6.2 窗口化:pushFrame 只入 ring,投递由每组补投定时器(250ms)完成;
      // 此处帧起始 ts 取在投递窗口内,并显式驱动一次 tick(不等定时器,判据确定)。
      const ts0 = nowUs() + 2_000_000n;
      const got = await g.pushFrame(ts0, new Float32Array(960));
      g.bridgePushTick();
      expect(got).toBe(960); // BLK-01:无真实成员也照常产出
      await until(() => recv.audio.length >= 2, "audio x2");
      expect(recv.audio[0]).toMatchObject({ tsUs: ts0, generation: 0, sequence: 1 });
      expect(recv.audio[1]!.tsUs).toBe(ts0 + BigInt(Math.round((480 * 1_000_000) / 48000))); // 逐 chunk 真实起点(转换后)
      expect(Buffer.from(recv.audio[0]!.payload).equals(payload0)).toBe(true);
      expect(Buffer.from(recv.audio[1]!.payload).equals(payload1)).toBe(true);

      // 代次钩子端到端:组 notifyBridgeGeneration → BridgeMember 队列 BOUNDARY{seek}
      g.notifyBridgeGeneration(9, "seek");
      await until(() => recv.boundaries.some(([, r]) => r === "seek"), "boundary seek");
      expect(recv.boundaries[0]).toEqual([9, "seek"]);

      // clearPlayback → BOUNDARY{track}(同代次)
      g.clearPlayback();
      await until(() => recv.boundaries.length >= 2, "boundary track");
      expect(recv.boundaries[1]![1]).toBe("track");
      expect(recv.boundaries[1]![0]).toBe(9);
    } finally {
      g?.stopBridgePushTimer(); // 窗口化:sync 起了补投定时器,收尾停表
      member.stop();
      await bs.close();
    }
  }, 15_000);
});
