// sendspin 帧级成员补偿 + 「下一首预解码」开关:两条 v4.11.0 语义的机械判据。
//
// ① 帧级补偿(真·实时):组泵在**唯一的下发点**给每个成员打戳
//    `sendAudio(ts + sendspinDelayUsOf(clientId))` —— 同一份字节、不同偏移;
//    改值后**下一次 pushFrame** 即按新值,不需要重建会话(与 AirPlay 的 D9 重建路径相反)。
//    漏掉这一步的表现是「延迟调了没反应」,而且无任何报错。
// ② 预解码开关:音频页写 sendspin-renderer 插件配置的 `next_track_prefetch`
//    (缺省**开**,显式 false 才关),子进程直读 sqlite ⇒ 下一次换歌即生效;
//    容器 env `MF_BRIDGE_NEXT_TRACK_PREFETCH` 作排障总闸并优先于 Web 开关。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, initDatabase } from "../../src/db/index.js";
import { plugins } from "../../src/db/schema.js";
import { setMemberDelay, sendspinDelayUsOfClient } from "../../src/services/group/delayCalib.js";
import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { readBridgePrefetchConfig } from "../../src/services/sendspin/bridgePrefetchConfig.js";
import { nextTrackPrefetchEnabled } from "../../src/services/sendspin/streamEngine.js";

vi.hoisted(() => {
  process.env.BRIDGE_TRACK_LEAD_COLD_MS = "1000";
  process.env.BRIDGE_TRACK_LEAD_WARM_MS = "0";
});

/** 可控块编码器:每次 encode 吐固定样本数(空数组即可让 pushFrame 只做成员下发)。 */
class PhaseEncoder {
  calls = 0;
  constructor(private readonly samples: number) {}
  async encode() {
    this.calls++;
    return this.samples > 0
      ? [{ frameSamples: this.samples, data: new Uint8Array(10).fill(0xab) }]
      : [];
  }
  async flush() {
    return [];
  }
  close() {}
}

/** 最小 sendspin 成员桩:只提供 pushFrame 会碰的面。 */
function conn(clientId: string, codec: string, gain = 100): any {
  const sent: Array<{ ts: bigint; data: Uint8Array }> = [];
  return {
    clientId,
    codec,
    sent,
    appliedGain: () => gain,
    bufferCapacityBytes: 0,
    clientWantsStream: () => true,
    announceStream: () => {},
    sendAudio: (ts: bigint, data: Uint8Array) => sent.push({ ts, data: Uint8Array.from(data) }),
  };
}

const liveGroups: SendspinGroup[] = [];

/** 最小 server 桩:pushFrame 的成员补偿唯一来源是 `server.groupDelayUs`(生产由
 *  SendspinServer 委派给 delayCalib)。这里用真实现,保证 ug: 解析与成员格子读取
 *  这两段真代码也在覆盖范围内;缺失该方法的桩一律按 0 处理(源码即为此设计)。 */
const stubServer = {
  log() {},
  groupDelayUs: (groupName: string, clientId: string) => sendspinDelayUsOfClient(groupName, clientId),
};

function spinGroup(name: string, members: any[]): SendspinGroup {
  const g = new SendspinGroup(name, stubServer as any);
  (g as any).encoders.set("pcm:100", new PhaseEncoder(1000));
  for (const m of members) g.add(m);
  liveGroups.push(g);
  return g;
}
afterEach(() => {
  for (const g of liveGroups.splice(0)) g.stopBridgePushTimer();
});

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

describe("sendspin 帧级成员补偿(下发点唯一)", () => {
  it("同一 chunk 分发给两台成员:时间戳相差恰好 = 两成员补偿之差(字节完全一致)", async () => {
    setMemberDelay("spin-delay-1", "sendspin:s1", 350);
    setMemberDelay("spin-delay-1", "sendspin:s2", -120);
    const m1 = conn("s1", "pcm");
    const m2 = conn("s2", "pcm");
    const g = spinGroup("ug:spin-delay-1", [m1, m2]);

    const ts0 = 1_000_000n;
    await g.pushFrame(ts0, new Float32Array(1200));

    expect(m1.sent).toHaveLength(1);
    expect(m2.sent).toHaveLength(1);
    expect(m1.sent[0]!.ts).toBe(ts0 + 350_000n);
    expect(m2.sent[0]!.ts).toBe(ts0 - 120_000n);
    // 逐字节同源:补偿只动时间戳,不动内容
    expect(Array.from(m1.sent[0]!.data)).toEqual(Array.from(m2.sent[0]!.data));
  });

  it("改值后下一次 pushFrame 即按新值(帧级实时,无需重建会话)", async () => {
    setMemberDelay("spin-delay-2", "sendspin:s1", 250);
    const m1 = conn("s1", "pcm");
    const g = spinGroup("ug:spin-delay-2", [m1]);

    await g.pushFrame(1_000_000n, new Float32Array(1200));
    expect(m1.sent[0]!.ts).toBe(1_000_000n + 250_000n);

    setMemberDelay("spin-delay-2", "sendspin:s1", 900);
    await g.pushFrame(2_000_000n, new Float32Array(1200));
    expect(m1.sent[1]!.ts).toBe(2_000_000n + 900_000n);
  });

  it("无组上下文(普通组名)/ 空 clientId ⇒ 偏移 0(不误用全局值)", async () => {
    setMemberDelay("spin-delay-3", "sendspin:s1", 700);
    const m1 = conn("s1", "pcm");
    const m2 = conn("", "pcm");
    const plain = spinGroup("g-plain", [m1]);
    const ug = spinGroup("ug:spin-delay-3", [m2]);

    await plain.pushFrame(1_000_000n, new Float32Array(1200));
    expect(m1.sent[0]!.ts).toBe(1_000_000n); // 普通组名不解析出 gid ⇒ 0

    await ug.pushFrame(1_000_000n, new Float32Array(1200));
    expect(m2.sent[0]!.ts).toBe(1_000_000n); // clientId 为空 ⇒ 0
  });
});

describe("「下一首预解码」Web 开关(plugins 表直读)", () => {
  beforeEach(() => {
    db.delete(plugins).where(eq(plugins.id, "sendspin-renderer")).run();
    delete process.env.MF_BRIDGE_NEXT_TRACK_PREFETCH;
  });

  function setConfig(config: string): void {
    // 同一用例内会连续写两次(先 false 再 true)⇒ 先清再插;upsert 也行但直读路径
    // 只关心「库里最终是什么」,先清最直观。
    db.delete(plugins).where(eq(plugins.id, "sendspin-renderer")).run();
    db.insert(plugins)
      .values({ id: "sendspin-renderer", name: "sendspin-renderer", config })
      .run();
  }

  it("缺省开:无插件行 ⇒ true;配置里没有该键 ⇒ true", () => {
    expect(readBridgePrefetchConfig()).toBe(true);
    setConfig("{}");
    expect(readBridgePrefetchConfig()).toBe(true);
  });

  it("显式 false 才关;true 显式开着", () => {
    setConfig(JSON.stringify({ next_track_prefetch: false }));
    expect(readBridgePrefetchConfig()).toBe(false);
    setConfig(JSON.stringify({ next_track_prefetch: true }));
    expect(readBridgePrefetchConfig()).toBe(true);
  });

  it("坏 JSON 按开(排障友好,不因脏配置静默丢功能)", () => {
    setConfig("not-json{{{");
    expect(readBridgePrefetchConfig()).toBe(true);
  });

  it("env 总闸优先于 Web 开关:0/false/off 关,1/true/on 开", () => {
    setConfig(JSON.stringify({ next_track_prefetch: false }));
    process.env.MF_BRIDGE_NEXT_TRACK_PREFETCH = "1";
    expect(nextTrackPrefetchEnabled()).toBe(true); // env 1 覆盖 Web 的 false

    setConfig(JSON.stringify({ next_track_prefetch: true }));
    for (const v of ["0", "false", "off"]) {
      process.env.MF_BRIDGE_NEXT_TRACK_PREFETCH = v;
      expect(nextTrackPrefetchEnabled()).toBe(false);
    }
    process.env.MF_BRIDGE_NEXT_TRACK_PREFETCH = "on";
    expect(nextTrackPrefetchEnabled()).toBe(true);
  });

  it("无 env 时委派 Web 开关(缺省开)", () => {
    delete process.env.MF_BRIDGE_NEXT_TRACK_PREFETCH;
    expect(nextTrackPrefetchEnabled()).toBe(true);
    setConfig(JSON.stringify({ next_track_prefetch: false }));
    expect(nextTrackPrefetchEnabled()).toBe(false);
  });
});
