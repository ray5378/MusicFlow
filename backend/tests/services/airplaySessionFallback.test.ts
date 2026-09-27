// ==================== AirPlay 取流凭证:DB 不可用时的降级路径 补测 ====================
//
// 文件头写明:注册表**必须**落 SQLite —— AirPlay 生产默认 fork 模式,token 在主进程
// mint、由子进程经回环 URL 消费,内存 Map 跨进程不可见(2026-09-19 事故的同一条教训)。
// 但「必须落库」不等于「库不可用时投屏整体失败」:那条 catch 里的内存回退是**极旧库**
// (表还没建)的逃生舱,本次播放仍要能用。
//
// 于是这里有两套并存的状态(DB 表 + 内存 Map),且解析时**先查内存后查库**。这四段回退
// 代码在正常环境永远走不到,只有库坏了才生效 —— 真到那时再发现它是错的就晚了,
// 所以必须由单测把库打坏来验证。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const db = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../../src/db/index.js", () => ({ sqlite: db }));

import {
  createAirPlaySession,
  resolveAirPlaySession,
} from "../../src/services/airplay/session.js";

/** 让 sqlite.prepare 按 SQL 关键字返回不同的桩(建表失败 / 命中行 / 过期行)。 */
function stubDb(opts: { select?: unknown; throwOn?: string } = {}) {
  db.prepare.mockImplementation((sql: string) => {
    if (opts.throwOn) throw new Error(opts.throwOn);
    if (sql.startsWith("SELECT")) {
      return { get: vi.fn(() => opts.select ?? undefined), run: vi.fn() };
    }
    return { run: vi.fn(), get: vi.fn(() => undefined) };
  });
}

function sqlOf(callIndex: number): string {
  return String(db.prepare.mock.calls[callIndex][0]);
}

beforeEach(() => {
  db.prepare.mockReset();
  stubDb();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
describe("库不可用时:回退内存 token 且同曲同设备复用", () => {
  beforeEach(() => {
    db.prepare.mockImplementation(() => {
      throw new Error("no such table: airplay_stream_tokens");
    });
  });

  it("建表失败不抛,仍返回可用 token 与 URL", () => {
    const { token, streamUrl, expiresAt } = createAirPlaySession("s-fb-1", "dev-fb-1", "http://h");
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(streamUrl).toBe(`http://h/rest/airplay/stream/${token}`);
    expect(expiresAt - Date.now()).toBeGreaterThan(29 * 60 * 1000);
  });

  it("同 (songId, deviceId) 未过期 → 复用旧 token 只续期", () => {
    const a = createAirPlaySession("s-fb-2", "dev-fb-2", "http://h");
    const b = createAirPlaySession("s-fb-2", "dev-fb-2", "http://h");
    // 每次投流都 mint 新 token 会让设备侧 mediaUri 变化 → 被误判成换歌而自动切下一首。
    expect(b.token).toBe(a.token);
    expect(b.expiresAt).toBeGreaterThanOrEqual(a.expiresAt);
  });

  it("歌或设备任一不同 → 各自新 token", () => {
    const a = createAirPlaySession("s-fb-3", "dev-fb-3", "http://h");
    const otherSong = createAirPlaySession("s-fb-x", "dev-fb-3", "http://h");
    const otherDev = createAirPlaySession("s-fb-3", "dev-fb-x", "http://h");
    expect(otherSong.token).not.toBe(a.token);
    expect(otherDev.token).not.toBe(a.token);
  });

  it("内存 token 可被解析回来(子进程同进程内消费的那条路)", () => {
    const { token } = createAirPlaySession("s-fb-4", "dev-fb-4", "http://h");
    expect(resolveAirPlaySession(token)).toEqual({ songId: "s-fb-4", deviceId: "dev-fb-4" });
  });

  it("内存 token 过期 → 返回 null(而不是旧值)", () => {
    // 注:过期分支里的 `memoryTokens.delete` 是**纯回收**(键此后不可能再被命中,
    // 复用的循环同样按 expiresAt 过滤),删与不删对外一致 —— 故无法用断言证伪,
    // 别为它硬凑断言。
    vi.useFakeTimers();
    const { token } = createAirPlaySession("s-fb-5", "dev-fb-5", "http://h");
    expect(resolveAirPlaySession(token)).not.toBeNull();
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(resolveAirPlaySession(token)).toBeNull();
  });
});

// ============================================================
describe("库可用时:过期行的清理与异常兜底", () => {
  it("命中未过期行 → 正常解析", () => {
    stubDb({ select: { song_id: "s-db-1", device_id: "dev-db-1", exp: Date.now() + 60_000 } });
    expect(resolveAirPlaySession("tok-db-1")).toEqual({ songId: "s-db-1", deviceId: "dev-db-1" });
  });

  it("命中过期行 → 先删行再返回 null(不留垃圾)", () => {
    stubDb({ select: { song_id: "s-db-2", device_id: "dev-db-2", exp: Date.now() - 1 } });
    expect(resolveAirPlaySession("tok-db-2")).toBeNull();
    expect(db.prepare.mock.calls.some((c) => String(c[0]).includes("DELETE"))).toBe(true);
  });

  it("查不到行 → null,不删任何东西", () => {
    stubDb({ select: undefined });
    expect(resolveAirPlaySession("tok-db-3")).toBeNull();
    expect(db.prepare.mock.calls.some((c) => String(c[0]).includes("DELETE"))).toBe(false);
  });

  it("库查询抛错 → 吞掉并返回 null(不把 DB 异常甩给投屏链路)", () => {
    stubDb({ throwOn: "disk I/O error" });
    expect(() => resolveAirPlaySession("tok-db-4")).not.toThrow();
    expect(resolveAirPlaySession("tok-db-4")).toBeNull();
  });

  it("库里已有未过期会话 → 复用 token 只续期(同曲同设备)", () => {
    stubDb({ select: { token: "existing-tok" } });
    const r = createAirPlaySession("s-db-6", "dev-db-6", "http://h");
    expect(r.token).toBe("existing-tok");
    expect(r.streamUrl).toBe("http://h/rest/airplay/stream/existing-tok");
    expect(db.prepare.mock.calls.some((c) => String(c[0]).startsWith("UPDATE"))).toBe(true);
    expect(db.prepare.mock.calls.some((c) => String(c[0]).startsWith("INSERT"))).toBe(false);
  });

  it("库里没有 → INSERT 新行", () => {
    stubDb({ select: undefined });
    const r = createAirPlaySession("s-db-7", "dev-db-7", "http://h");
    expect(r.token).toMatch(/^[0-9a-f]{32}$/);
    expect(db.prepare.mock.calls.some((c) => String(c[0]).startsWith("INSERT"))).toBe(true);
  });

  it("SELECT 一定是带 exp 过滤的那条(避免直接命中已过期行)", () => {
    stubDb({ select: undefined });
    resolveAirPlaySession("tok-db-5");
    expect(sqlOf(0)).toContain("FROM airplay_stream_tokens WHERE token");
  });
});
