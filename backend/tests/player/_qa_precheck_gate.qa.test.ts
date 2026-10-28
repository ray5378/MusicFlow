// ==================== QA 独立反证：第六闸（起播前完整性预检） ====================
//
// 实现者的 precheckIntegrity.test.ts 只覆盖了「hang ⇒ 有界返回」。本文件补他**没测**的：
//   ① 预取**抛错**（不是 hang）⇒ 必须放行（异常兜底）；
//   ② 预取跑完但仍 transient（弱信号）⇒ 必须放行；
//   ③ 「env 兜底」在 DB 里有 settings 时**失效**（配置优先级 settings > env）—— 这是
//      这次给两个既有夹具加 `PREFETCH_PRECHECK_WAIT_MS=0` 的隐含前提，必须钉死。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const st = vi.hoisted(() => ({
  playability: new Map<string, string>(),
  prefetched: [] as string[],
  mode: "ok" as "ok" | "reject" | "hang",
}));

vi.mock("../../src/services/source/prefetchCache.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    prefetchSong: async (songId: string) => {
      st.prefetched.push(songId);
      if (st.mode === "reject") throw new Error("prefetch boom");
      if (st.mode === "hang") return new Promise<void>(() => {});
      if (songId.startsWith("qg-dead")) st.playability.set(songId, "unplayable");
    },
  };
});

vi.mock("../../src/services/source/online/streamFallback.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getCachedPlayability: (songId: string) => st.playability.get(songId) ?? "unknown",
    markUnplayable: (songId: string) => st.playability.set(songId, "unplayable"),
  };
});

const ra = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../../src/services/source/resolveAudio.js", () => ({
  resolvePlayableRow: async (songId: string) => {
    ra.calls.push(songId);
    return { row: null, definitive: false, reason: "mock-no-row" };
  },
}));

import { QueueController } from "../../src/services/player/QueueController.js";
import { setPrefetchSettings, resetPrefetchSettings, getPrefetchSettings } from "../../src/services/source/prefetchConfig.js";

const WEB_ROW = { id: "qg-x", duration: 200, type: "web", path: "web:abc", url: "http://x/a.mp3" };

const ENV_KEYS = ["PREFETCH_PRECHECK_WAIT_MS", "PREFETCH_INTEGRITY_OFF"] as const;
let envSaved: Record<string, string | undefined> = {};

beforeEach(() => {
  envSaved = {};
  for (const k of ENV_KEYS) envSaved[k] = process.env[k];
  st.playability.clear();
  st.prefetched.length = 0;
  st.mode = "ok";
  ra.calls.length = 0;
  process.env.PREFETCH_PRECHECK_WAIT_MS = "500";
  delete process.env.PREFETCH_INTEGRITY_OFF;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSaved[k] === undefined) delete process.env[k];
    else process.env[k] = envSaved[k];
  }
});

const mk = () => new QueueController() as any;

describe("QA③ 第六闸：异常与弱信号必须放行（绝不误杀）", () => {
  it("预取**抛错** ⇒ 放行（且确实触发过一次预取）", async () => {
    st.mode = "reject";
    await expect(mk().precheckIntegrity("qg-throw", { ...WEB_ROW, id: "qg-throw" })).resolves.toBe("play");
    expect(st.prefetched).toEqual(["qg-throw"]);
  });

  it("预取跑完但仍 transient ⇒ 放行（不把『弱信号』当『死的』）", async () => {
    st.playability.set("qg-tr", "transient");
    await expect(mk().precheckIntegrity("qg-tr", { ...WEB_ROW, id: "qg-tr" })).resolves.toBe("play");
    expect(st.prefetched).toEqual(["qg-tr"]);
  });

  it("判官判死 ⇒ skip（基线：证明上面的放行不是因为闸门根本没触发）", async () => {
    await expect(mk().precheckIntegrity("qg-dead-9", { ...WEB_ROW, id: "qg-dead-9" })).resolves.toBe("skip");
    expect(st.prefetched).toEqual(["qg-dead-9"]);
  });

  it("曲库 duration 缺失(0/NaN/null/undefined) ⇒ 放行（无基准不杀）", async () => {
    for (const dur of [0, Number.NaN, null, undefined]) {
      await expect(
        mk().precheckIntegrity("qg-nodur", { ...WEB_ROW, id: "qg-nodur", duration: dur }),
      ).resolves.toBe("play");
    }
    expect(st.prefetched).toEqual([]);
  });

  it("path 以 web: 开头但 type 不是 web ⇒ 仍然识别为网络源（两种判据任一成立即可）", async () => {
    st.playability.set("qg-w", "unknown");
    await expect(
      mk().precheckIntegrity("qg-dead-w", { ...WEB_ROW, id: "qg-dead-w", type: "other", path: "web:abc" }),
    ).resolves.toBe("skip");
  });
});

describe("QA④ 配置优先级：settings(DB) > env —— env 兜底并非总是生效", () => {
  it("无 DB 记录时：env 生效", () => {
    process.env.PREFETCH_PRECHECK_WAIT_MS = "0";
    resetPrefetchSettings();
    expect(getPrefetchSettings().precheckWaitMs).toBe(0);
  });

  it("★ DB 里有 settings 时：env 被**覆盖**（夹具里那句 env=0 只在没人写过 settings 时才有效）", () => {
    process.env.PREFETCH_PRECHECK_WAIT_MS = "0";
    setPrefetchSettings({ precheckWaitMs: 1500 });
    expect(getPrefetchSettings().precheckWaitMs).toBe(1500);
    resetPrefetchSettings();
    expect(getPrefetchSettings().precheckWaitMs).toBe(0);
  });

  it("越界值被 clamp：12000 ⇒ 9000；负数 ⇒ 0（上界严格小于 playCurrent 的 10s）", () => {
    setPrefetchSettings({ precheckWaitMs: 12000 });
    expect(getPrefetchSettings().precheckWaitMs).toBe(9000);
    setPrefetchSettings({ precheckWaitMs: -5 });
    expect(getPrefetchSettings().precheckWaitMs).toBe(0);
    resetPrefetchSettings();
  });
});
