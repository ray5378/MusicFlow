// ==================== pushFrame:按 (codec,gain) 分组编码 + 时间线 max-of-累计 ====================
//
// 背景(2026-09-24 真机):FLAC 链路下把 Sendspin 播放器**播放中**加入群组,会让整组
// 「一卡一卡」,且**只有当前这首坏、切下一首即恢复**。根因两条,互为因果:
//
//   ① 每个成员各建一个 FLAC 编码器 → libFLAC 的**块相位**由创建时刻决定,播中加入者
//      与先到者必然错开(libFLAC 攒满 4096 样本 ≈85ms 才吐一帧);
//   ② 时间线推进取「每批各成员产出的 max」⇒ 相位错开时把**并集**当本批推进:
//          批 k  : A 吐 4096 / B 吐 0    → 记 4096
//          批 k+1: A 吐 0    / B 吐 4096 → 又记 4096
//      两批共记 8192,而真正上网的音频只有 4096 ⇒ 时间线 ~2× 推进(真机实测净 1.44×,
//      因帧长可变)。时间戳跑到墙钟前面 → 设备排程跟不上 → 反复 Lost sync / 插静音。
//      「切歌即恢复」的指纹也由此解释:新曲全员同时创建编码器 ⇒ 相位重新对齐。
//
// 本文件锁死修复后的两条语义:
//   ① 同一 (codec, gain) 的成员**共享一个编码器**,一批只编一次、字节分发给全组;
//   ② 返回值 = `max(各组累计交付样本)` 的**增量**,而不是「每批取 max」。
import { describe, it, expect } from "vitest";
import { SendspinGroup } from "../../src/services/sendspin/server.js";

/** 可控块编码器桩:按 plan 逐次产出样本数(0 = 本批仍在攒帧,不吐)。 */
class PhaseEncoder {
  calls = 0;
  constructor(private readonly plan: number[]) {}
  async encode(): Promise<any[]> {
    const n = this.plan[this.calls++] ?? 0;
    return n > 0 ? [{ frameSamples: n, data: new Uint8Array(Math.max(1, n / 100)) }] : [];
  }
  async flush(): Promise<any[]> {
    return [];
  }
  close(): void {}
  get encodeCalls(): number {
    return this.calls;
  }
}

/** 最小成员桩:只提供 pushFrame / flushAnnounceFor 真正会碰的成员面。 */
function conn(clientId: string, codec: string, gain = 100): any {
  const sent: { ts: bigint; len: number }[] = [];
  return {
    clientId,
    codec,
    sent,
    appliedGain: () => gain,
    bufferCapacityBytes: 0,
    clientWantsStream: () => true,
    announceStream: () => {},
    sendAudio: (ts: bigint, data: Uint8Array) => sent.push({ ts, len: data.length }),
  };
}

/** 建组并**预置**编码器(键 = `codec:gain`,即 encoderKey 的约定) —— 省掉真实编码器。 */
function groupWith(encoders: Record<string, PhaseEncoder>): SendspinGroup {
  const g = new SendspinGroup("g-push", { log() {} } as any);
  for (const [key, enc] of Object.entries(encoders)) (g as any).encoders.set(key, enc);
  return g;
}

const PCM = (n = 1200) => new Float32Array(n);

describe("① 按 (codec, gain) 分组编码:同组只编一次", () => {
  it("★ 两个同 codec+gain 成员:编码 1 次,字节分发给两人且时间戳一致", async () => {
    const enc = new PhaseEncoder([1000, 1000]);
    const g = groupWith({ "flac:100": enc });
    const a = conn("A", "flac");
    const b = conn("B", "flac");
    g.add(a);
    g.add(b);

    await g.pushFrame(0n, PCM());

    expect(enc.encodeCalls).toBe(1); // 不是 2 —— 这就是 CPU × 成员数的消除
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(1);
    // 同一份字节 ⇒ 时间戳序列也必须完全一致(否则同组设备互相错位)
    expect(a.sent[0].ts).toBe(b.sent[0].ts);
    expect(a.sent[0].len).toBe(b.sent[0].len);
  });

  it("encoderFor 对同 codec+gain 的成员返回**同一实例**", () => {
    const enc = new PhaseEncoder([]);
    const g = groupWith({ "flac:100": enc });
    const a = conn("A", "flac");
    const b = conn("B", "flac");
    g.add(a);
    g.add(b);
    expect(g.encoderFor(a)).toBe(g.encoderFor(b));
    expect(g.encoderFor(a)).toBe(enc);
  });

  it("不同 codec ⇒ 各编一次(互不共用)", async () => {
    const e1 = new PhaseEncoder([500]);
    const e2 = new PhaseEncoder([500]);
    const g = groupWith({ "flac:100": e1, "pcm:100": e2 });
    g.add(conn("A", "flac"));
    g.add(conn("B", "pcm"));

    await g.pushFrame(0n, PCM());

    expect(e1.encodeCalls).toBe(1);
    expect(e2.encodeCalls).toBe(1);
  });

  it("增益不同 ⇒ 分属不同编码组(缩放后字节不同,不能共用)", async () => {
    const e1 = new PhaseEncoder([500]);
    const e2 = new PhaseEncoder([500]);
    const g = groupWith({ "flac:100": e1, "flac:40": e2 });
    g.add(conn("A", "flac", 100));
    g.add(conn("B", "flac", 40));

    await g.pushFrame(0n, PCM());

    expect(e1.encodeCalls).toBe(1);
    expect(e2.encodeCalls).toBe(1);
    expect(g.encoderFor(conn("X", "flac", 100))).toBe(e1);
    expect(g.encoderFor(conn("Y", "flac", 40))).toBe(e2);
  });
});

describe("② 时间线 = max(累计) 的增量:相位错开不再多算", () => {
  it("★ 两组相位错开,4 批共吐 2 帧 ⇒ 推进 8192(旧口径会得 16384)", async () => {
    const a = new PhaseEncoder([4096, 0, 4096, 0]);
    const b = new PhaseEncoder([0, 4096, 0, 4096]);
    const g = groupWith({ "flac:100": a, "pcm:100": b });
    g.add(conn("A", "flac"));
    g.add(conn("B", "pcm"));

    let total = 0;
    for (let i = 0; i < 4; i++) total += await g.pushFrame(0n, PCM());

    expect(total).toBe(8192); // = 真实上网的音频量;旧实现 4096×4 = 16384(≈2×)
  });

  it("单组攒帧窗口内零产出 ⇒ 推进 0(时间线只认真正出门的字节)", async () => {
    const a = new PhaseEncoder([0, 0, 4096]);
    const g = groupWith({ "flac:100": a });
    g.add(conn("A", "flac"));

    expect(await g.pushFrame(0n, PCM())).toBe(0);
    expect(await g.pushFrame(0n, PCM())).toBe(0);
    expect(await g.pushFrame(0n, PCM())).toBe(4096);
  });

  it("★ 播中加入的新编码组以当前峰值为基线:既不停滞也不倒退", async () => {
    const a = new PhaseEncoder([4096, 4096, 0]);
    const g = groupWith({ "flac:100": a });
    g.add(conn("A", "flac"));
    expect(await g.pushFrame(0n, PCM())).toBe(4096);
    expect(await g.pushFrame(0n, PCM())).toBe(4096); // peak = 8192

    // 播放中新人(用 PCM 进来 ⇒ 新编码组)。它的累计必须从**当前峰值**起算,
    // 否则 max 会被拉回 0:先是停滞 20+ 帧,再让时间线倒着走。
    const b = new PhaseEncoder([4096]);
    (g as any).encoders.set("pcm:100", b);
    g.add(conn("B", "pcm"));

    expect(await g.pushFrame(0n, PCM())).toBe(4096); // A 吐 0、B 吐 4096 → 增量仍是 4096
  });

  it("成员被移除后剩余成员继续产出 ⇒ 推进不回退(峰值单调不减)", async () => {
    const a = new PhaseEncoder([4096, 4096]);
    const b = new PhaseEncoder([4096, 4096]);
    const g = groupWith({ "flac:100": a, "pcm:100": b });
    const ca = conn("A", "flac");
    const cb = conn("B", "pcm");
    g.add(ca);
    g.add(cb);
    expect(await g.pushFrame(0n, PCM())).toBe(4096);

    g.remove(cb); // B 退出(只留 A):峰值不得随之塌陷
    expect(await g.pushFrame(0n, PCM())).toBe(4096);
  });

  it("全员零产出 ⇒ 推进 0(不抖动、不虚进)", async () => {
    const a = new PhaseEncoder([0]);
    const b = new PhaseEncoder([0]);
    const g = groupWith({ "flac:100": a, "pcm:100": b });
    g.add(conn("A", "flac"));
    g.add(conn("B", "pcm"));
    expect(await g.pushFrame(0n, PCM())).toBe(0);
  });

  it("码率计量仍工作(设备容量钳制依赖它),resetPushMeter 一并清零", async () => {
    const a = new PhaseEncoder([4096, 4096]);
    const g = groupWith({ "flac:100": a });
    g.add(conn("A", "flac"));

    expect(g.hasMeasuredRate()).toBe(false);
    await g.pushFrame(0n, PCM());
    expect(g.hasMeasuredRate()).toBe(true);
    expect(g.encodedBytesPerSec()).toBeGreaterThan(0);

    g.resetPushMeter();
    expect(g.hasMeasuredRate()).toBe(false);
  });
});
