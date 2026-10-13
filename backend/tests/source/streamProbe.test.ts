// ==================== 起播 TTFB 金丝雀探针(streamProbe)回归守卫 ====================
//
// 主线:探针是**观测器**,绝不许反过来打扰它观测的世界。按这条组织:
//   ① 卫生条件:钉死歌曲 / 播放避让 / 失败仅状态翻转时 warn(防每小时一条噪音);
//   ② skip 优先级:disabled → no-song → recent-playback → song-missing → not-network
//      → no-source(避让闸在查库前,播放中连 DB 都不读);
//   ③ 实测路径:只读首字节即取消(fetch 入参 = resolveNetworkInput 的 url+headers,
//      与出流/预取共用同一份推导);http 非 2xx / 抛错 / 空 body / 超时各自归因;
//   ④ 分位:nearest-rank,小样本不造不存在值;快照 p50/p95/max 与 recent 供 UI;
//   ⑤ 调度:tick 30s 粒度,开关/歌曲改动静默生效(无需重启),间隔闸按上次**尝试**算;
//   ⑥ single-flight:并发调用第二发直接 in-flight skip,绝不双探。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---- hoisted mock:db 查行 + settings 表(内存 Map,配置层走真代码) ----
const H = vi.hoisted(() => ({
  songRow: null as any,
  settings: new Map<string, string>(),
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ get: () => H.songRow }) }) }),
  },
  sqlite: {
    prepare: (sql: string) => {
      const s = String(sql);
      if (s.includes("FROM settings")) {
        return {
          get: (k: string) => (H.settings.has(k) ? { value: H.settings.get(k) } : undefined),
          run: () => {},
        };
      }
      if (s.includes("INSERT OR REPLACE INTO settings")) {
        return { run: (k: string, v: string) => { H.settings.set(k, v); }, get: () => undefined, all: () => [] };
      }
      return { get: () => undefined, run: () => {}, all: () => [] };
    },
    transaction: (f: any) => f,
  },
}));

import {
  describeProbeSong,
  getStreamProbeSnapshot,
  noteStreamActivity,
  percentileOf,
  resetStreamProbeForTest,
  runProbeOnce,
  startStreamProbeScheduler,
  stopStreamProbeScheduler,
} from "../../src/services/source/streamProbe.js";
import {
  getStreamProbeSettings,
  resetStreamProbeSettings,
  setStreamProbeSettings,
} from "../../src/services/source/streamProbeConfig.js";
import { setSetting } from "../../src/services/settings.js";
import * as netMod from "../../src/services/source/networkInput.js";

const PROBE_ENVS = [
  "STREAM_PROBE_ENABLED",
  "STREAM_PROBE_SONG_ID",
  "STREAM_PROBE_INTERVAL_MS",
  "STREAM_PROBE_TTFB_WARN_MS",
  "STREAM_PROBE_TIMEOUT_MS",
  "STREAM_PROBE_QUIET_MS",
  "STREAM_PROBE_SAMPLES",
  "STREAM_PROBE_SUMMARY_EVERY",
];

/** 起播后 delayMs 才吐首字节的响应体(探针只读第一块就取消)。 */
function delayedStream(delayMs: number, bytes = 4096): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      setTimeout(() => {
        c.enqueue(new Uint8Array(bytes));
        c.close();
      }, delayMs);
    },
  });
}

/** 构造即就绪的响应体(假定时器用例用:read() 走微任务,不依赖定时器推进)。 */
function instantStream(bytes = 4096): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });
}

const NET = { url: "http://up.example/a.mp3", headers: { Referer: "http://ref.example/" } };
const ROW_WEB = { id: "s1", type: "web", url: NET.url, streamHeaders: '{"Referer":"http://ref.example/"}' };
const ROW_LOCAL = { id: "s2", type: "local", path: "l:/music/a.flac" };

const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: delayedStream(5) }));

beforeEach(() => {
  for (const k of PROBE_ENVS) delete process.env[k];
  resetStreamProbeForTest();
  resetStreamProbeSettings();
  H.songRow = ROW_WEB;
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200, body: delayedStream(5) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(netMod, "resolveNetworkInput").mockImplementation(async () => NET as any);
});

afterEach(() => {
  stopStreamProbeScheduler();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ==================== ① percentileOf(纯函数) ====================

describe("① percentileOf:nearest-rank 分位", () => {
  it("空数组 → null(没有样本就不编分位)", () => {
    expect(percentileOf([], 50)).toBeNull();
  });
  it("单样本任何分位都是它", () => {
    expect(percentileOf([42], 50)).toBe(42);
    expect(percentileOf([42], 99)).toBe(42);
  });
  it("[10,20,30,40] p50=20 p95=40(ceil 秩,不插值造值)", () => {
    expect(percentileOf([10, 20, 30, 40], 50)).toBe(20);
    expect(percentileOf([10, 20, 30, 40], 95)).toBe(40);
  });
  it("乱序输入按排序后取值", () => {
    expect(percentileOf([40, 10, 30, 20], 50)).toBe(20);
  });
});

// ==================== ② skip 优先级 ====================

describe("② runProbeOnce:skip 优先级(默认全关,一行 fetch 都不发)", () => {
  it("默认 disabled → skipped/disabled,不碰 fetch/DB", async () => {
    const r = await runProbeOnce();
    expect(r).toEqual({ kind: "skipped", reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enabled 但没选歌 → skipped/no-song(API 拒绝开启无歌,该分支经 env 兜底到达)", async () => {
    process.env.STREAM_PROBE_ENABLED = "1"; // env 兜底开启,但没给歌
    const r = await runProbeOnce();
    expect(r).toEqual({ kind: "skipped", reason: "no-song" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("起播避让:最近 60s 内有出流族请求 → skipped/recent-playback(且不查库)", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    noteStreamActivity(); // now
    const r = await runProbeOnce();
    expect(r).toEqual({ kind: "skipped", reason: "recent-playback" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("避让窗外(120s 前的起播,默认窗 60s)→ 正常探测", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    noteStreamActivity(Date.now() - 120_000);
    const r = await runProbeOnce();
    expect(r.kind).toBe("ok");
  });

  it("选定的歌不在库(被删)→ skipped/song-missing", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    H.songRow = null;
    const r = await runProbeOnce();
    expect(r).toEqual({ kind: "skipped", reason: "song-missing" });
  });

  it("选定行是本地直读(没有上游可量)→ skipped/not-network", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s2" });
    H.songRow = ROW_LOCAL;
    const r = await runProbeOnce();
    expect(r).toEqual({ kind: "skipped", reason: "not-network" });
  });

  it("网络行但解析不出源 → skipped/no-source", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    vi.spyOn(netMod, "resolveNetworkInput").mockResolvedValueOnce(null as any);
    const r = await runProbeOnce();
    expect(r).toEqual({ kind: "skipped", reason: "no-source" });
  });
});

// ==================== ③ 实测路径 ====================

describe("③ 实测路径:首字节 TTFB + 归因", () => {
  it("happy:fetch 入参 = resolveNetworkInput 的 url+headers,读到首字节即 ok", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    const r = await runProbeOnce();
    expect(r.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      NET.url,
      expect.objectContaining({ headers: NET.headers }),
    );
    const snap = getStreamProbeSnapshot();
    expect(snap.health).toBe("healthy");
    expect(snap.lastTtfbMs).toBeGreaterThan(0);
    expect(snap.samples).toBe(1);
    expect(snap.recent).toHaveLength(1);
    expect(snap.counts).toMatchObject({ ok: 1, fail: 0, skip: 0 });
    expect(snap.song).toEqual({ id: "s1", title: "", artist: "" });
  });

  it("http 403(源配置腐烂:密码轮换/登录态过期)→ fail 归因 http-403,health=failing", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, body: null } as any);
    const r = await runProbeOnce();
    expect(r).toEqual({ kind: "fail", error: "http-403" });
    const snap = getStreamProbeSnapshot();
    expect(snap.health).toBe("failing");
    expect(snap.lastError).toBe("http-403");
    expect(snap.lastTtfbMs).toBeNull();
  });

  it("网络抛错 → fail 带错误信息;持续失败不重复 warn(③卫生条件)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r1 = await runProbeOnce();
    expect(r1).toEqual({ kind: "fail", error: "ECONNREFUSED" });
    const warnsAfterFirst = warn.mock.calls.filter((c) => String(c[0]).includes("STREAM-PROBE")).length;
    expect(warnsAfterFirst).toBe(1); // unknown → failing 翻转,warn 恰好一条
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await runProbeOnce();
    const warnsAfterSecond = warn.mock.calls.filter((c) => String(c[0]).includes("STREAM-PROBE")).length;
    expect(warnsAfterSecond).toBe(1); // failing → failing:转 debug,不新增 warn
    warn.mockRestore();
  });

  it("TimeoutError → fail 归因 timeout(不是裸 message)", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted", "TimeoutError"));
    const r = await runProbeOnce();
    expect(r).toEqual({ kind: "fail", error: "timeout" });
  });

  it("200 但空 body(直链腐烂成空文件)→ fail 归因 empty-body", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    } as any);
    const r = await runProbeOnce();
    expect(r).toEqual({ kind: "fail", error: "empty-body" });
  });

  it("成功但慢(TTFB > 告警线)→ 仍然 ok,但 warn 一条(退化信号不被 health 掩盖)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.STREAM_PROBE_TTFB_WARN_MS = "1"; // 任何真实耗时都超线
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    const r = await runProbeOnce();
    expect(r.kind).toBe("ok");
    const warns = warn.mock.calls.filter((c) => String(c[0]).includes("STREAM-PROBE"));
    expect(warns.length).toBe(1);
    expect(String(warns[0][0])).toContain("超告警线");
    expect(getStreamProbeSnapshot().health).toBe("healthy"); // 慢 ≠ 坏,health 仍健康
    warn.mockRestore();
  });

  it("恢复:failing 后一次成功 → health=healthy 且 info 记恢复", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, body: null } as any);
    await runProbeOnce();
    expect(getStreamProbeSnapshot().health).toBe("failing");
    await runProbeOnce();
    expect(getStreamProbeSnapshot().health).toBe("healthy");
    const infos = log.mock.calls.filter((c) => String(c[0]).includes("STREAM-PROBE"));
    expect(infos.some((c) => String(c[0]).includes("恢复健康"))).toBe(true);
    log.mockRestore();
  });
});

// ==================== ④ 快照与分位 ====================

describe("④ 快照:多样本分位 + recent + env 旋钮回显", () => {
  it("5/10/20ms 三次成功 → p50=10 p95=20 max=20,recent 按时间序三条", async () => {
    // 假定时器求精确值:真实 setTimeout 有 ±1ms 调度噪声,精确相等断言会 flaky。
    vi.useFakeTimers();
    try {
      setStreamProbeSettings({ enabled: true, songId: "s1" });
      for (const d of [20, 5, 10]) {
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: delayedStream(d) } as any);
        const p = runProbeOnce();
        await vi.advanceTimersByTimeAsync(d + 1);
        await p;
      }
    } finally {
      vi.useRealTimers();
    }
    const snap = getStreamProbeSnapshot();
    expect(snap.samples).toBe(3);
    expect(snap.p50Ms).toBe(10);
    expect(snap.p95Ms).toBe(20);
    expect(snap.maxMs).toBe(20);
    expect(snap.recent.map((s) => s.ttfbMs)).toEqual([20, 5, 10]); // 环形缓冲按探测顺序
  });

  it("env 旋钮(SAMPLES/TTFB_WARN/INTERVAL/QUIET/TIMEOUT)在快照里回显", async () => {
    process.env.STREAM_PROBE_SAMPLES = "8";
    process.env.STREAM_PROBE_TTFB_WARN_MS = "4321";
    process.env.STREAM_PROBE_INTERVAL_MS = "7200000";
    process.env.STREAM_PROBE_QUIET_MS = "90000";
    process.env.STREAM_PROBE_TIMEOUT_MS = "15000";
    const snap = getStreamProbeSnapshot();
    expect(snap).toMatchObject({
      ttfbWarnMs: 4321,
      intervalMs: 7_200_000,
      quietMs: 90_000,
      timeoutMs: 15_000,
    });
  });

  it("环形缓冲封顶 SAMPLES(默认 48,env 改小即封顶)", async () => {
    process.env.STREAM_PROBE_SAMPLES = "3";
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    for (let i = 0; i < 5; i++) {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: delayedStream(1) } as any);
      await runProbeOnce();
    }
    const snap = getStreamProbeSnapshot();
    expect(snap.samples).toBe(3);
    expect(snap.recent).toHaveLength(3);
  });

  it("describeProbeSong:行不在库 → null;在库 → id/title/artist", async () => {
    H.songRow = { id: "s9", title: "泪海", artist: "汽水" };
    expect(describeProbeSong("s9")).toEqual({ id: "s9", title: "泪海", artist: "汽水" });
    expect(describeProbeSong("")).toBeNull();
  });
});

// ==================== ⑤ 调度 ====================

describe("⑤ 调度:30s tick,开关静默生效,间隔闸,可停", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 假定时器下流必须是即时就绪的:真实 setTimeout 永不推进会让探测挂起,
    // running 标志泄漏污染后续用例(本轮踩过)。
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, body: instantStream() }));
  });
  afterEach(() => {
    stopStreamProbeScheduler();
    vi.useRealTimers();
  });

  it("关闭时 tick 不探;UI 开启后(不重启)下一 tick 即探", async () => {
    resetStreamProbeSettings(); // 默认关
    startStreamProbeScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("间隔闸:默认 1h,30s 后再 tick 不重复探", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    startStreamProbeScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("env 缩短间隔到 60s → 满 60s 后第二次探", async () => {
    process.env.STREAM_PROBE_INTERVAL_MS = "60000";
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    startStreamProbeScheduler();
    await vi.advanceTimersByTimeAsync(30_000); // 首探
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); // 满间隔 → 二探
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stop 后 tick 彻底静默", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    startStreamProbeScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stopStreamProbeScheduler();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ==================== ⑥ single-flight ====================

describe("⑥ single-flight:并发第二发直接 in-flight", () => {
  it("慢探测进行中再调一次 → skipped/in-flight,不双探", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: delayedStream(60) } as any);
    const p1 = runProbeOnce();
    const p2 = runProbeOnce();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.kind, r2.kind].sort()).toEqual(["ok", "skipped"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ==================== 配置层:setStreamProbeSettings ====================

describe("附:配置层合并/校验/env 兜底", () => {
  it("enabled=true 但无歌 → 拒绝(ok:false,i18n 键),且不落库", async () => {
    const r = setStreamProbeSettings({ enabled: true });
    expect(r).toEqual({ ok: false, error: "errors.streamProbe.songRequired" });
    expect(getStreamProbeSettings().enabled).toBe(false);
  });

  it("合并语义:分两次各带一个字段,互不冲掉", async () => {
    setStreamProbeSettings({ enabled: true, songId: "s1" });
    setStreamProbeSettings({ enabled: false });
    expect(getStreamProbeSettings()).toEqual({ enabled: false, songId: "s1" });
  });

  it("env 兜底:UI 从没保存过时 STREAM_PROBE_ENABLED=1 + SONG_ID 生效", async () => {
    process.env.STREAM_PROBE_ENABLED = "1";
    process.env.STREAM_PROBE_SONG_ID = "env-song";
    expect(getStreamProbeSettings()).toEqual({ enabled: true, songId: "env-song" });
    // UI 保存过 enabled=false 后,env 让位(避免「运维注入了 env、用户关了没效果」)
    setStreamProbeSettings({ songId: "env-song", enabled: false });
    expect(getStreamProbeSettings().enabled).toBe(false);
  });

  it("坏 JSON 设置值 ⇒ 当作没保存过,回落 env/默认", async () => {
    setSetting("stream.probe.settings", "{not json"); // 走真写路径(连缓存一起更新)
    expect(getStreamProbeSettings()).toEqual({ enabled: false, songId: "" });
  });
});
