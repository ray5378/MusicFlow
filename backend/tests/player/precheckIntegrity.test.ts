// ==================== 起播前完整性预检（第六闸，2026-10-28 240 事故） ====================
//
// 事故：预取 lookahead=1 只覆盖「下一首」。auto-advance 连跳两首死歌后**落到的那一首**
// 首次不在预取窗口里 ⇒ 负缓存 unknown ⇒ `judgePlayable` 只看「URL 能否探测」就直接播
// ⇒ 用户听到 60s 试听片段，要等主进程自己的预取跑完（18:29:06）才判死。
// 这一闸补的正是「落点歌**首次起播前**先判一次内容完整性」。
//
// 本文件钉死两条边界：
//   A. 保守闸门：四条触发条件（unknown / 网络源 / duration>0 / 判官开）缺一即放行，
//      已有确定结论（playable / unplayable）绝不重复劳动 —— 绝不误杀、绝不拖慢起播；
//   B. 有界等待：预取永不 settle 时必须在 `precheckWaitMs` 内返回 "play"，
//      绝不能重演 2026-10-21「playCurrent 被一次 await 永久占用」的事故。
//
// 全部用桩替身：不碰真实曲库解析、不发网络、不起 ffmpeg。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const st = vi.hoisted(() => ({
  /** 主进程这份可播性缓存（unknown / playable / unplayable / transient）。 */
  playability: new Map<string, string>(),
  /** 被触发的预取（songId 列表）。 */
  prefetched: [] as string[],
  /** true = 预取永不 settle（逼出超时分支）。 */
  hang: false,
}));

vi.mock("../../src/services/source/prefetchCache.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    prefetchSong: async (songId: string) => {
      st.prefetched.push(songId);
      if (st.hang) return new Promise<void>(() => {}); // 永不 settle
      // 模拟「预取跑完、判官把这首判死」
      if (songId.startsWith("pc-dead") || songId === "pc-transient") st.playability.set(songId, "unplayable");
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

// judgePlayable 的既有裁决链用桩：本文件只测**第六闸**的进出，不测 resolveAudio 本身。
const ra = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../../src/services/source/resolveAudio.js", () => ({
  resolvePlayableRow: async (songId: string) => {
    ra.calls.push(songId);
    return { row: null, definitive: false, reason: "mock-no-row" };
  },
}));

import { QueueController } from "../../src/services/player/QueueController.js";
import { sqlite } from "../../src/db/index.js";
import { PREFETCH_NUM_SPECS } from "../../src/services/source/prefetchConfig.js";

const ENV_KEYS = ["PREFETCH_PRECHECK_WAIT_MS", "PREFETCH_INTEGRITY_OFF"] as const;
let envSaved: Record<string, string | undefined> = {};

/** 网络源行（曲库 duration>0，试听片段只可能出现在这种行上）。 */
const WEB_ROW = { id: "pc-x", duration: 200, type: "web", path: "web:abc", url: "http://x/a.mp3" };
/** 本地磁盘行：不存在「试听片段」，不该被这一闸碰。 */
const LOCAL_ROW = { id: "pc-local", duration: 200, type: "local", path: "l:/a.mp3" };

function setWait(ms: number | null, integrityOff = false): void {
  if (ms === null) delete process.env.PREFETCH_PRECHECK_WAIT_MS;
  else process.env.PREFETCH_PRECHECK_WAIT_MS = String(ms);
  if (integrityOff) process.env.PREFETCH_INTEGRITY_OFF = "1";
  else delete process.env.PREFETCH_INTEGRITY_OFF;
}

beforeEach(() => {
  envSaved = {};
  for (const k of ENV_KEYS) envSaved[k] = process.env[k];
  st.playability.clear();
  st.prefetched.length = 0;
  st.hang = false;
  ra.calls.length = 0;
  setWait(500);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSaved[k] === undefined) delete process.env[k];
    else process.env[k] = envSaved[k];
  }
});

function mk(): any {
  return new QueueController();
}

// 曲库表在部分测试环境不会自动建（缺失时 seek/insert 会抛），这里幂等建一张最小表。
try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY, title TEXT, path TEXT, type TEXT, size INTEGER,
      duration REAL, suffix TEXT, group_id TEXT, url TEXT, stream_headers TEXT
    );
  `);
} catch {
  /* 已存在 */
}

describe("第六闸 precheckIntegrity：保守触发（绝不误杀）", () => {
  it("本地源（type=local）⇒ 放行（试听片段只可能出现在网络源）", async () => {
    await expect(mk().precheckIntegrity("pc-local", { ...LOCAL_ROW, id: "pc-local" })).resolves.toBe("play");
    expect(st.prefetched).toEqual([]);
  });

  it("duration=0（无基准）⇒ 放行（与判官自身同一条原则）", async () => {
    await expect(mk().precheckIntegrity("pc-nodur", { ...WEB_ROW, id: "pc-nodur", duration: 0 })).resolves.toBe("play");
    expect(st.prefetched).toEqual([]);
  });

  it("负缓存已是 playable ⇒ 放行，且不再触发预取（否则每首都白等一次）", async () => {
    st.playability.set("pc-ok", "playable");
    await expect(mk().precheckIntegrity("pc-ok", { ...WEB_ROW, id: "pc-ok" })).resolves.toBe("play");
    expect(st.prefetched).toEqual([]);
  });

  it("负缓存已是 unplayable ⇒ 直接 skip，不再触发预取", async () => {
    st.playability.set("pc-dead-known", "unplayable");
    await expect(mk().precheckIntegrity("pc-dead-known", { ...WEB_ROW, id: "pc-dead-known" })).resolves.toBe("skip");
    expect(st.prefetched).toEqual([]);
  });

  it("precheckWaitMs=0 ⇒ 关闸，放行且不触发预取", async () => {
    setWait(0);
    await expect(mk().precheckIntegrity("pc-x", WEB_ROW)).resolves.toBe("play");
    expect(st.prefetched).toEqual([]);
  });

  it("完整性判官关闭 ⇒ 放行且不触发预取", async () => {
    setWait(500, true);
    await expect(mk().precheckIntegrity("pc-x", WEB_ROW)).resolves.toBe("play");
    expect(st.prefetched).toEqual([]);
  });
});

describe("第六闸 precheckIntegrity：有界等待与判死落地", () => {
  it("unknown + 网络源 + duration>0 ⇒ 触发预取；判官判死 ⇒ skip", async () => {
    await expect(mk().precheckIntegrity("pc-dead-1", { ...WEB_ROW, id: "pc-dead-1" })).resolves.toBe("skip");
    expect(st.prefetched).toEqual(["pc-dead-1"]);
  });

  it("unknown + 网络源 ⇒ 触发预取；预取后仍 unknown ⇒ 放行（不把『不知道』当『死的』）", async () => {
    await expect(mk().precheckIntegrity("pc-plain", { ...WEB_ROW, id: "pc-plain" })).resolves.toBe("play");
    expect(st.prefetched).toEqual(["pc-plain"]);
  });

  it("transient（弱信号软失败）同样值得再判一次 ⇒ 触发预取", async () => {
    st.playability.set("pc-transient", "transient");
    await expect(mk().precheckIntegrity("pc-transient", { ...WEB_ROW, id: "pc-transient" })).resolves.toBe("skip");
    expect(st.prefetched).toEqual(["pc-transient"]);
  });

  it("预取永不 settle ⇒ **有界**返回 play（绝不永久占用 playCurrent）", async () => {
    st.hang = true;
    const t0 = Date.now();
    await expect(mk().precheckIntegrity("pc-hang", { ...WEB_ROW, id: "pc-hang" })).resolves.toBe("play");
    const dt = Date.now() - t0;
    expect(st.prefetched).toEqual(["pc-hang"]);
    // 上界 500ms：必须等到（不能是 0 就放行），也必须真的返回（不能挂住）
    expect(dt).toBeGreaterThanOrEqual(400);
    expect(dt).toBeLessThan(4000);
  });

  it("等待上界的硬约束：precheckWaitMs 上界 9000 < playCurrent 外层 withTimeout 的 10_000", () => {
    // 2026-10-21 240 事故：playCurrent 被一次 await 永久占用。这一闸的等待必须**严格小于**
    // 外层 10s 兜底，否则等于把「永久占用」的口子又开了一遍。
    const spec = (PREFETCH_NUM_SPECS as Record<string, any>).precheckWaitMs;
    expect(spec).toBeTruthy();
    expect(spec.max).toBe(9000);
    expect(spec.max).toBeLessThan(10_000);
    expect(spec.def).toBe(3000);
    expect(spec.min).toBe(0); // 0 = 关闸
  });
});

describe("judgePlayable 接入第六闸", () => {
  it("第六闸判死 ⇒ judgePlayable 直接 skip，且不再跑既有裁决链（resolvePlayableRow）", async () => {
    sqlite
      .prepare(
        "INSERT INTO songs (id, title, path, type, size, duration, suffix) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run("pc-dead-2", "t", "web:abc", "web", 1000, 200, "mp3");
    await expect(mk().judgePlayable({ songId: "pc-dead-2" } as any)).resolves.toBe("skip");
    expect(st.prefetched).toEqual(["pc-dead-2"]);
    expect(ra.calls).toEqual([]); // 第六闸在既有裁决链**之前**拦下
  });

  it("第六闸放行 ⇒ 照旧走既有裁决链（宽容尾巴）", async () => {
    sqlite
      .prepare(
        "INSERT INTO songs (id, title, path, type, size, duration, suffix) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run("pc-plain-2", "t", "web:abc", "web", 1000, 200, "mp3");
    await expect(mk().judgePlayable({ songId: "pc-plain-2" } as any)).resolves.toBe("play");
    expect(st.prefetched).toEqual(["pc-plain-2"]);
    expect(ra.calls).toEqual(["pc-plain-2"]);
  });
});
