// streamEngine.ts 覆盖补测:推流主循环的**收口与兜底**分支。
//
// 用 overridePumpSource 注入音源(整包 / 假流式窗口)+ 最小 stub group 驱动 GroupPump,
// 不碰 DB / 真网络 / 真 ffmpeg。锁住的产品契约:
//   1) 流式窗口淘汰(WindowEvicted)后必须**贴齐游标继续**,绝不原地自旋(事故:事件循环饿死);
//   2) 窗口非淘汰类错误必须外抛终止 pump,不许静默(否则「服务端看着正常但设备无声」);
//   3) pushFrame 抛错(连接断)必须停推 + 打日志,不是无声截断;
//   4) 时长未知(durationMs<=0)时进度不得恒为 0(否则同片无限重推、饿死事件循环);
//   5) 预填充水位被设备容量钳制时必须**在日志里明说**(不许静默削弱用户档位)。
import "../plugins/_env.js";

import { describe, it, expect, vi, afterAll } from "vitest";

// index.js 只被**动态导入**(禁环)。这里让它抛错,以锁定两处「读配置失败一律回落」的兜底。
vi.mock("../../src/services/sendspin/index.js", () => ({
  readSendspinPluginConfig: () => {
    throw new Error("no plugin config in unit test");
  },
}));

import {
  GroupPump,
  overridePumpSource,
  prefillTargetMs,
  PREFILL_BUFFER_DEFAULT_MS,
} from "../../src/services/sendspin/streamEngine.js";
import { WindowEvictedError } from "../../src/services/sendspin/streamSource.js";

const FRAME_SAMPLES = 2400; // 25ms @48k 立体声交错样本

afterAll(() => {
  overridePumpSource(null);
});

/** 最小 stub group:只提供 pushLoop 真正会调的接口(其余走可选调用的兜底)。 */
function makeGroup(over: any = {}) {
  const frames: bigint[] = [];
  const g: any = {
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null,
    name: "g",
    finished: 0,
    commonSendAheadUs: () => 800_000,
    pushFrame: async (_ts: bigint, pcm: Float32Array) => {
      frames.push(_ts);
      return pcm.length / 2; // 产出样本数(单声道口径)
    },
    finishPlayback: () => {
      g.finished++;
    },
    ...over,
  };
  return { g, frames };
}

function makeServer(logs: string[]) {
  return {
    log: (_level: string, msg: string) => {
      logs.push(msg);
    },
  } as any;
}

async function waitInactive(pump: GroupPump, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (!pump.active) return;
    if (Date.now() - t0 > ms) throw new Error(`pump 未结束: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("streamEngine pushLoop:整包路径的时长/锚点/诊断分支", () => {
  it("durationMs<=0 时长未知:进度按帧栅格推进(不钳制、不恒 0),JITTER 诊断可开", async () => {
    const env = { speed: process.env.SENDSPIN_PUSH_SPEED, jitter: process.env.SENDSPIN_JITTER, prefill: process.env.SENDSPIN_PREFILL };
    process.env.SENDSPIN_PUSH_SPEED = "100";
    process.env.SENDSPIN_JITTER = "1";
    process.env.SENDSPIN_PREFILL = "0"; // 关预填充 → 锚点走 reseed?reseedLead:aheadUs 分支
    const total = 60;
    overridePumpSource(async () => ({
      pcm: new Float32Array(total * FRAME_SAMPLES),
      durationMs: 0,
    }));
    const logs: string[] = [];
    const { g, frames } = makeGroup();
    const pump = new GroupPump(makeServer(logs), g);
    try {
      await pump.play("song-unknown-duration");
      await waitInactive(pump, 15000, "整包时长未知");
      expect(frames).toHaveLength(total);
      // 时长未知也必须往前走:若取帧游标恒 0,同一片会无限重推(永不到 total)——上面那条
      // 断言(恰好 total 帧且 pump 退出)即是「游标真的在推进」的证明。
      expect(g.positionMs).toBeGreaterThanOrEqual(0);
      // 自然播完 → 置空 current 并宣告流结束(切歌/auto-advance 的依据)
      expect(g.current).toBeNull();
      expect(g.finished).toBe(1);
      // SENDSPIN_JITTER=1 时必须打出诊断行(排障用)
      expect(logs.some((m) => m.includes("[JITTER "))).toBe(true);
    } finally {
      if (env.speed === undefined) delete process.env.SENDSPIN_PUSH_SPEED; else process.env.SENDSPIN_PUSH_SPEED = env.speed;
      if (env.jitter === undefined) delete process.env.SENDSPIN_JITTER; else process.env.SENDSPIN_JITTER = env.jitter;
      if (env.prefill === undefined) delete process.env.SENDSPIN_PREFILL; else process.env.SENDSPIN_PREFILL = env.prefill;
    }
  }, 30_000);

  it("pushFrame 抛错(连接断)→ 停推 + 打日志,不静默截断", async () => {
    const boom = new Error("ws closed");
    overridePumpSource(async () => ({ pcm: new Float32Array(10 * FRAME_SAMPLES), durationMs: 0 }));
    const logs: string[] = [];
    const { g, frames } = makeGroup({
      pushFrame: async () => {
        throw boom;
      },
    });
    const pump = new GroupPump(makeServer(logs), g);
    await pump.play("song-pushfail");
    await waitInactive(pump, 15000, "pushFrame 抛错");
    expect(frames).toHaveLength(0);
    expect(logs.some((m) => m.includes("pushFrame 中断"))).toBe(true);
    // 异常终止与自然结束同口径(2026-10-08「月满西楼」假在播根源修复后的新契约):
    // 清 current + finishPlayback ⇒ pollCore playing=false ⇒ poll 报 IDLE
    // ⇒ auto-advance 走既有跳歌自愈。旧契约「异常不得清 current 防误切歌」已废弃
    // —— current 残留才是真事故(poll 恒报 PLAYING pos=0,队列层被骗住,永不自愈)。
    expect(g.current).toBeNull();
    expect(g.finished).toBe(1);
  }, 30_000);
});

describe("streamEngine pushLoop:流式窗口取数错误的分流", () => {
  it("WindowEvicted → 贴齐到窗口基准继续,绝不原地自旋", async () => {
    let calls = 0;
    const fakeWin: any = {
      baseMs: 5000,
      decoded: 10_000_000,
      eof: false,
      failedReason: null,
      pid: 4242,
      stderrText: () => "",
      async slice() {
        calls++;
        if (calls === 1) throw new WindowEvictedError(); // 回放点已滑出窗口
        if (calls === 2) return new Float32Array(FRAME_SAMPLES).fill(0.1);
        return new Float32Array(0); // 第 3 次:窗口提前 EOF
      },
    };
    overridePumpSource(async () => ({ pcm: new Float32Array(0), durationMs: 0, stream: fakeWin }));
    const logs: string[] = [];
    const { g, frames } = makeGroup();
    const pump = new GroupPump(makeServer(logs), g);
    await pump.play("song-window");
    await waitInactive(pump, 15000, "窗口淘汰贴齐");
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(frames).toHaveLength(1); // 淘汰后拿到一帧,再遇 EOF 结束
    expect(logs.some((m) => m.includes("游标落后窗口基准,贴齐继续"))).toBe(true);
    expect(logs.some((m) => m.includes("流式窗口提前 EOF"))).toBe(true);
    expect(g.current).toBeNull(); // 窗口 EOF 视为自然播完
    expect(g.finished).toBe(1);
  }, 30_000);

  it("窗口非淘汰类错误 → 外抛终止 pump(不静默吞)", async () => {
    const fakeWin: any = {
      baseMs: 0,
      decoded: 0,
      eof: false,
      failedReason: "slice boom",
      pid: 1,
      async slice() {
        throw new Error("slice boom");
      },
    };
    overridePumpSource(async () => ({ pcm: new Float32Array(0), durationMs: 0, stream: fakeWin }));
    const logs: string[] = [];
    const { g } = makeGroup();
    const pump = new GroupPump(makeServer(logs), g);
    await pump.play("song-window-err");
    await waitInactive(pump, 15000, "窗口错误终止");
    expect(logs.some((m) => m.includes("pushLoop 异常终止"))).toBe(true);
    // 异常终止与自然结束同口径(新契约,见 pumpErrorState.test.ts 守卫):
    // 清 current + finishPlayback ⇒ poll 报 IDLE ⇒ auto-advance 跳歌自愈。
    expect(g.current).toBeNull();
    expect(g.finished).toBe(1);
  }, 30_000);
});

describe("streamEngine 预填充:设备容量钳制必须明说", () => {
  it("档位 > 设备容量 → 日志打出钳制说明(不静默削弱用户档位)", async () => {
    const env = { ms: process.env.SENDSPIN_PREFILL_MS, prefill: process.env.SENDSPIN_PREFILL, speed: process.env.SENDSPIN_PUSH_SPEED };
    process.env.SENDSPIN_PREFILL_MS = "30000"; // 用户选 30s
    delete process.env.SENDSPIN_PREFILL; // 预填充开启
    process.env.SENDSPIN_PUSH_SPEED = "100";
    overridePumpSource(async () => ({ pcm: new Float32Array(8 * FRAME_SAMPLES), durationMs: 0 }));
    const logs: string[] = [];
    const { g } = makeGroup({
      // 设备只宣告能装 1s:真实目标水位必须被钳制,且要提示一次
      capacityLimitedPrefillMs: () => 1000,
      hasMeasuredRate: () => true,
      deviceCapacityBytes: () => 1_600_000,
      encodedBytesPerSec: () => 105_000,
    });
    const pump = new GroupPump(makeServer(logs), g);
    try {
      await pump.play("song-capped");
      await waitInactive(pump, 15000, "容量钳制");
      expect(logs.some((m) => m.includes("预填充水位按设备容量钳制"))).toBe(true);
      expect(logs.some((m) => m.includes("目标占用≈"))).toBe(true);
    } finally {
      if (env.ms === undefined) delete process.env.SENDSPIN_PREFILL_MS; else process.env.SENDSPIN_PREFILL_MS = env.ms;
      if (env.prefill === undefined) delete process.env.SENDSPIN_PREFILL; else process.env.SENDSPIN_PREFILL = env.prefill;
      if (env.speed === undefined) delete process.env.SENDSPIN_PUSH_SPEED; else process.env.SENDSPIN_PUSH_SPEED = env.speed;
    }
  }, 30_000);
});

describe("streamEngine 读插件配置失败的兜底", () => {
  it("prefillTargetMs:读不到配置 → 回落缺省水位(不抛)", async () => {
    const saved = process.env.SENDSPIN_PREFILL_MS;
    delete process.env.SENDSPIN_PREFILL_MS;
    try {
      const v = prefillTargetMs();
      expect(v).toBe(PREFILL_BUFFER_DEFAULT_MS);
    } finally {
      if (saved === undefined) delete process.env.SENDSPIN_PREFILL_MS;
      else process.env.SENDSPIN_PREFILL_MS = saved;
    }
  });
});
