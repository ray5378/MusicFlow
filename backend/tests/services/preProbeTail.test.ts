// 覆盖率长尾补充:services/player/preProbeScheduler.ts 的残余分支。
//   - notifyChange:单个订阅者抛错不影响其它订阅者(150-151)
//   - status():枯竭冷却到期后 exhausted 自动回落(172-173)
//   - runLoop:scan 抛错被吞掉、running 不残留(262)
//   - probePosition:读库异常的两条自愈路径(405-406 / 447-448)、
//     正缓存变死链后"换源成功仍可播"(425-427)、"换源抛错维持原判"(429-430)、
//     "真查抛错判未知"(469-470)
//   - peekUpcomingPositions 边界(85-87)、resetForTest 六表清空(229-235)、
//     scan 触时间上限提前停止(295-298)、无 plugin_entry 行判 unknown(455-458)
// streamFallback 整体替身:判定表完全由测试控制,不碰真实网络。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { db, sqlite } from "../../src/db/index.js";
import { registerPlugin } from "../../src/plugins/registry.js";
const H = vi.hoisted(() => ({
  cached: {} as Record<string, string>,
  recheck: "gone" as string,
  ensure: null as string | null,
  ensureThrows: false,
  evicts: 0,
}));

vi.mock("../../src/services/source/online/streamFallback.js", () => ({
  configureStreamFallbackCache: () => {},
  getCachedPlayability: (id: string) => (H.cached[id] as any) ?? null,
  evictStreamFallbackCache: () => { H.evicts += 1; },
  recheckOnlineDirect: async () => H.recheck,
  ensurePlayableStream: async () => {
    if (H.ensureThrows) throw new Error("ensure boom");
    return H.ensure;
  },
}));

import { PreProbeScheduler, peekUpcomingPositions } from "../../src/services/player/preProbeScheduler.js";

/** 声明 preProbe 能力 ⇒ preProbeActive() 为 true(status() 才会看状态表)。
 *  注意:getEnabledPlugins() 以 DB plugins 表的 enabled 名单为准,
 *  只 registerPlugin 是不够的,必须同时落一行 enabled=1。 */
const GATE = {
  id: "tail-preprobe-gate",
  name: "tail-preprobe-gate",
  version: "1.0.0",
  type: "sync",
  capabilities: ["preProbe"],
  configSchema: [],
  permissions: [],
} as const;

registerPlugin(GATE as any, {});
sqlite
  .prepare(
    "INSERT INTO plugins (id, name, version, description, manifest, enabled, config, created_at, updated_at) VALUES (?,?,?,?,?,1,'{}',?,?) ON CONFLICT(id) DO UPDATE SET enabled = 1",
  )
  .run(GATE.id, GATE.name, GATE.version, "", JSON.stringify(GATE), new Date().toISOString(), new Date().toISOString());

const CFG: any = {
  enabled: true,
  lookaheadSongs: 3,
  deadRunLimit: 50,
  exhaustedCooldownSeconds: 90,
  probeTimeoutMs: 1000,
  probeCooldownSeconds: 60,
  windowMinutes: 8,
  negativeTtlSeconds: 7200,
  concurrency: 3,
};

const SONG_IDS = ["pp-tail-1", "pp-tail-2", "pp-tail-3", "pp-tail-4"];

function seedSong(id: string) {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      "INSERT OR REPLACE INTO songs (id, title, artist, album, duration, path, suffix, type, plugin_entry, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(id, id, "A", "AL", 100, `web:p:/${id}`, "mp3", "web", "tail-prov", now, now);
}

beforeEach(() => {
  H.cached = {};
  H.recheck = "gone";
  H.ensure = null;
  H.ensureThrows = false;
  H.evicts = 0;
  sqlite.prepare("DELETE FROM songs WHERE id LIKE 'pp-tail-%'").run();
});

describe("notifyChange 订阅者隔离", () => {
  it("一个订阅者抛错不影响另一个,也不冒泡(150-151)", () => {
    const s = new PreProbeScheduler();
    let goodCalls = 0;
    s.addOnChange(() => { throw new Error("subscriber boom"); });
    s.addOnChange(() => { goodCalls += 1; });

    expect(() => s.markAllUnplayable("p1")).not.toThrow();
    expect(goodCalls).toBe(1); // 坏订阅者不能把好订阅者顶掉
    expect(s.status("p1").exhausted).toBe(true);
  });
});

describe("status():冷却到期自动回落", () => {
  it("cooldownUntil 已过 → exhausted=false 且冷却清空(不留说谎的告警)", () => {
    const s = new PreProbeScheduler();
    (s as any).statuses.set("p1", {
      ready: 0, scanned: 5, misses: 50, exhausted: true, cooldownUntil: Date.now() - 1, at: 1,
    });
    const st = s.status("p1");
    expect(st.exhausted).toBe(false);
    expect(st.cooldownUntil).toBeNull();
    expect(st.scanned).toBe(5); // 其它水位保留

    // 冷却未到时维持 exhausted(回落只发生在到期之后)。
    (s as any).statuses.set("p2", {
      ready: 0, scanned: 5, misses: 50, exhausted: true, cooldownUntil: Date.now() + 60_000, at: 1,
    });
    expect(s.status("p2").exhausted).toBe(true);
  });
});

describe("runLoop:scan 抛错被吞掉", () => {
  it("scan 抛错 → 记日志、running 清空,不产生 unhandled rejection(262)", async () => {
    const s = new PreProbeScheduler();
    let scanned = 0;
    (s as any).scan = async () => { scanned += 1; throw new Error("scan boom"); };
    const q = { items: [{ songId: "pp-tail-1" }], currentIndex: 0, playMode: "order" };

    s.schedule("p1", () => q as any);
    await vi.waitFor(() => expect((s as any).running.size).toBe(0));
    expect(scanned).toBe(1);
  });
});

describe("probePosition:读库异常自愈", () => {
  it("正缓存可播但读库异常 → 维持原判 playable(405-406)", async () => {
    H.cached["pp-tail-2"] = "playable";
    const s = new PreProbeScheduler();
    const sel = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("db boom"); });
    try {
      await expect((s as any).probePosition({ songId: "pp-tail-2" }, CFG)).resolves.toBe("playable");
    } finally {
      sel.mockRestore();
    }
  });

  it("无缓存但读库异常 → 判 unknown(447-448)", async () => {
    const s = new PreProbeScheduler();
    const sel = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("db boom"); });
    try {
      await expect((s as any).probePosition({ songId: "pp-tail-3" }, CFG)).resolves.toBe("unknown");
    } finally {
      sel.mockRestore();
    }
  });
});

describe("probePosition:正缓存变死链后的复核", () => {
  it("复核 gone 但换源成功 → 仍判 playable(425-427)", async () => {
    seedSong("pp-tail-1");
    H.cached["pp-tail-1"] = "playable";
    H.recheck = "gone";
    H.ensure = "https://cdn.example.com/fresh.mp3";

    const s = new PreProbeScheduler();
    await expect((s as any).probePosition({ songId: "pp-tail-1" }, CFG)).resolves.toBe("playable");
    expect(H.evicts).toBeGreaterThan(0); // 旧正缓存被逐出后重新确认
  });

  it("复核 gone 且换源抛错 → 维持原判 playable(429-430)", async () => {
    seedSong("pp-tail-1");
    H.cached["pp-tail-1"] = "playable";
    H.recheck = "gone";
    H.ensureThrows = true;

    const s = new PreProbeScheduler();
    await expect((s as any).probePosition({ songId: "pp-tail-1" }, CFG)).resolves.toBe("playable");
  });

  it("复核 transient → 维持原判 playable(不因抖动误判死链)", async () => {
    seedSong("pp-tail-1");
    H.cached["pp-tail-1"] = "playable";
    H.recheck = "transient";

    const s = new PreProbeScheduler();
    await expect((s as any).probePosition({ songId: "pp-tail-1" }, CFG)).resolves.toBe("playable");
  });
});

describe("probePosition:无缓存真查异常", () => {
  it("在线行真查抛错 → 判 unknown(469-470)", async () => {
    seedSong("pp-tail-4");
    H.ensureThrows = true;

    const s = new PreProbeScheduler();
    await expect((s as any).probePosition({ songId: "pp-tail-4" }, CFG)).resolves.toBe("unknown");
  });

  it("曲库里没有这首歌 → 判 unplayable", async () => {
    const s = new PreProbeScheduler();
    await expect((s as any).probePosition({ songId: "pp-tail-missing" }, CFG)).resolves.toBe("unplayable");
  });

  it("本地/WebDAV 行(无 plugin_entry)→ 判 unknown,不计入无源(455-458)", async () => {
    const now = new Date().toISOString();
    // plugin_entry 为空串 ⇒ 本地/WebDAV 行:预探测不代劳,按「未确认可播」处理。
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO songs (id, title, artist, album, duration, path, suffix, type, plugin_entry, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'',?,?)",
      )
      .run("pp-tail-5", "T5", "A", "AL", 100, "l:src:/x.mp3", "mp3", "local", now, now);

    const s = new PreProbeScheduler();
    await expect((s as any).probePosition({ songId: "pp-tail-5" }, CFG)).resolves.toBe("unknown");
    // 本地行不该写 lastProbeAt/lastVerdict(否则会把"未确认"缓存成判定)。
    expect((s as any).lastVerdict.get("pp-tail-5")).toBeUndefined();
  });
});

describe("peekUpcomingPositions 边界", () => {
  const q = (over: any) => ({ items: [{}], currentIndex: 0, playMode: "order", ...over });

  it("空队列 / currentIndex<0 / maxPositions<=0 → 空位置流 + reachedEnd(85-87)", () => {
    expect(peekUpcomingPositions(q({ items: [] }) as any, 3)).toEqual({ positions: [], reachedEnd: true });
    expect(peekUpcomingPositions(q({ currentIndex: -1 }) as any, 3)).toEqual({ positions: [], reachedEnd: true });
    expect(peekUpcomingPositions(q({}) as any, 0)).toEqual({ positions: [], reachedEnd: true });
  });
});

describe("PreProbeScheduler.resetForTest", () => {
  it("清空全部内存状态表(229-235)", () => {
    const s = new PreProbeScheduler();
    (s as any).statuses.set("p1", { ready: 1, scanned: 1, misses: 0, exhausted: false, cooldownUntil: null, at: 1 });
    (s as any).lastProbeAt.set("x", 1);
    (s as any).lastVerdict.set("x", "playable");
    (s as any).cooldownUntil.set("x", 1);
    (s as any).running.add("x");
    (s as any).pending.add("x");

    s.resetForTest();

    // 六张状态表必须一起清空:漏一张就会把上一轮水位/冷却泄漏到下一次调度。
    expect((s as any).statuses.size).toBe(0);
    expect((s as any).lastProbeAt.size).toBe(0);
    expect((s as any).lastVerdict.size).toBe(0);
    expect((s as any).cooldownUntil.size).toBe(0);
    expect((s as any).running.size).toBe(0);
    expect((s as any).pending.size).toBe(0);
  });
});

describe("scan:向前覆盖超时间上限即静默触底", () => {
  it("coveredSec>0 且再探一首将越过 windowMinutes → 停止扫描(295-298)", async () => {
    seedSong("pp-tail-2");
    seedSong("pp-tail-3");
    H.ensure = "https://cdn.example.com/ok.mp3"; // 两首都判 playable
    const cfg = { ...CFG, windowMinutes: 1, concurrency: 2, lookaheadSongs: 3, deadRunLimit: 50 };
    // 每首 100s > 60s 上限 ⇒ 第一首覆盖后,第二首就应触发上限停止。
    const s = new PreProbeScheduler();
    const qSource = {
      items: [
        { songId: "pp-tail-1", duration: 100 },
        { songId: "pp-tail-2", duration: 100 },
        { songId: "pp-tail-3", duration: 100 },
      ],
      currentIndex: 0,
      playMode: "order",
    };

    await (s as any).scan("p1", qSource, cfg);

    // 只处理了批内第 1 首就因时间上限跳出(第 2 首不再计入 scanned)。
    expect(s.status("p1").scanned).toBe(1);
  });
});
