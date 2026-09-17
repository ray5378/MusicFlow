// pump 自然结束边界:解码长度与元数据时长不一致时必须结束,不能卡死。
//
// 线上事故:元数据 320.639s、解码略长时,positionMs 被 clamp 在 durationMs,
// 下标 i 永远到不了 total → 同一尾帧无限重推;poll 恒报 PLAYING,切歌永不触发,
// 表现为"播完一首就停"。反方向(解码偏短)同样因 endedNaturally=false 卡死。
import { describe, it, expect, afterEach } from "vitest";
import { GroupPump, overridePumpSource } from "./streamEngine.js";

function stubGroup() {
  const frames: bigint[] = [];
  const group: any = {
    positionMs: 0,
    timelineBaseUs: 0n,
    current: { songId: "s", durationMs: 0 } as any,
    // 时间线锚点用(与帧头同源):stub 给 0 表示「无设备上报参数」,
    // 实机走 computeCommonSendAhead 回落 800ms(见 group.ts)。
    commonSendAheadUs: () => 800_000,
    // ⚠️ 必须返回**本批实际产出样本数**(单声道口径) —— 真实编码器都这么做,
    // pushLoop 靠它推进时间线。返回 undefined(=0)会被判「编码器零产出」,
    // 时间线只在连续 500ms 后降级(SALL_GRACE_US),属故障路径,不是常规范例。
    async pushFrame(ts: bigint, pcm: Float32Array) {
      frames.push(ts);
      return Math.floor(pcm.length / 2); // 模拟 PCM 编码器:喂多少吐多少
    },
  };
  return { group, frames };
}

async function waitInactive(pump: GroupPump, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (!pump.active) return;
    if (Date.now() - t0 > ms) throw new Error(`pump 未结束: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterEach(() => overridePumpSource(null));

describe("GroupPump 自然结束", () => {
  it("解码比元数据长:到达元数据时长即结束并置空 current", async () => {
    // 1.0s PCM,元数据只报 500ms(线上 320.639s 案的微缩版)
    overridePumpSource(async () => ({ pcm: new Float32Array(48000 * 2 * 1), durationMs: 500 }));
    const { group, frames } = stubGroup();
    const pump = new GroupPump({ log() {} } as any, group);
    await pump.play("s1");
    await waitInactive(pump, 8000, "解码偏长");
    expect(group.current).toBeNull();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThan(40); // 绝无无限重推
    // 时间戳单调递增(无冻结复推)
    for (let i = 1; i < frames.length; i++) expect(frames[i] > frames[i - 1]).toBe(true);
  }, 15000);

  it("解码比元数据短:耗尽即结束并置空 current", async () => {
    overridePumpSource(async () => ({ pcm: new Float32Array(48000 * 2), durationMs: 2000 }));
    const { group, frames } = stubGroup();
    const pump = new GroupPump({ log() {} } as any, group);
    await pump.play("s2");
    await waitInactive(pump, 8000, "解码偏短");
    expect(group.current).toBeNull();
    expect(frames.length).toBeGreaterThan(0);
  }, 15000);
});
