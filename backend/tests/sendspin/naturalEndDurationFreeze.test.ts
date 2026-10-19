// ==================== 自然曲终「冻结时长」回归守卫(2026-10-19) ====================
//
// 症状(用户报告):一首歌自然播完后,播放器当前时间停在 4:22、**总时长却变成 0:00**。
//
// 根因:v4.6.40 起自然曲终只置空组 `current`(`pollCore` 的 `playing` 唯一来源,
// 必须保留以驱动 auto-advance),而 `pollCore` 的 `durationMs` 取自
// `current.durationMs` ⇒ current 一清即归 0;`positionMs` 本就保留 ⇒ 呈现「4:22 / 0:00」。
//
// 修复:对齐 MA `metadata_role.freeze_progress()`(MA `providers/sendspin/playback.py`
// 的 `_stop_push_stream(snapshot_progress=...)`)—— 曲终在清 current 前把该曲时长冻结到
// 组上,pollCore 的 durationMs 兜底读它;新曲起播失败 / stop / stopGroup / 借流收尾等
// 复位站点清零,防陈旧时长串台。
//
// 本文件用**真实 SendspinGroup**(而非裸对象)驱动 pollCore / stopCore / stopGroupCore /
// playCore,让「组上字段 → pollCore 对外时长」这条链走真类:字段改名或兜底被删,必红。
import { describe, it, expect, afterEach, vi } from "vitest";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../src/utils/logger.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  createLogger: () => ({ info: log.info, warn: log.warn, error: log.error, debug: log.debug }),
}));

// 泵替身:本文件只关心「组字段 <-> pollCore 时长」与复位站点清零,泵行为全部受控。
const eng = vi.hoisted(() => {
  const pumps = new Map<string, any>();
  const mk = (name: string) => ({
    name,
    active: false,
    busy: false,
    playingSongId: null as string | null,
    play: vi.fn(async () => undefined),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    seek: vi.fn(),
    armSeek: vi.fn(),
  });
  return {
    pumps,
    mk,
    pumpFor: vi.fn((_srv: unknown, g: any) => {
      let p = pumps.get(g.name);
      if (!p) {
        p = mk(g.name);
        pumps.set(g.name, p);
      }
      return p;
    }),
    peekPump: vi.fn((g: any) => pumps.get(g.name) ?? null),
    transferPumpTo: vi.fn(() => 4242),
    stopGroupPump: vi.fn(),
    FIRST_FRAME_LEAD_US: 100_000,
    FRAME_MS: 20,
  };
});
vi.mock("../../src/services/sendspin/streamEngine.js", () => eng);

import { SendspinGroup } from "../../src/services/sendspin/server.js";
import { pollCore, stopCore, stopGroupCore, playCore, playGroupCore } from "../../src/services/sendspin/playerCore.js";

/** 最小 srv:group() 造**真实** SendspinGroup(字段保真);clients 供 resolveLiveGroup 回退。 */
function makeSrv(): any {
  const groups = new Map<string, SendspinGroup>();
  const clients = new Map<string, any>();
  const srv: any = {
    groups,
    clients,
    log: vi.fn(),
    group(name: string) {
      let g = groups.get(name);
      if (!g) {
        g = new SendspinGroup(name, srv);
        groups.set(name, g);
      }
      return g;
    },
    syncVolume: vi.fn(),
  };
  return srv;
}

/** 造「该曲自然曲终后」的组现场:位置停末尾 + 冻结时长已置 + current 已清。 */
function seedFrozenEnd(srv: any, name: string, ms: number) {
  const g = srv.group(name);
  g.positionMs = ms;
  g.frozenDurationMs = ms;
  g.current = null;
  return g;
}

afterEach(() => {
  eng.pumps.clear();
  eng.pumpFor.mockClear();
});

describe("自然曲终时长冻结:组字段 -> pollCore 对外时长", () => {
  it("曲终冻结后:playing=false(IDLE 不破坏)但 durationMs 仍报该曲总时长,位置停末尾", () => {
    const srv = makeSrv();
    seedFrozenEnd(srv, "dev1", 262_000); // 4:22
    const st = pollCore(srv, "dev1");
    expect(st.playing).toBe(false); // 仍是 IDLE ⇒ auto-advance 不受影响
    expect(st.positionMs).toBe(262_000); // 4:22
    expect(st.durationMs).toBe(262_000); // 4:22(修复前为 0:00)
  });

  it("在播中:durationMs 取 current,陈旧冻结值被屏蔽(不串台)", () => {
    const srv = makeSrv();
    const g = srv.group("dev2");
    g.frozenDurationMs = 111_000; // 上一首残留
    g.current = { songId: "s2", durationMs: 222_000 };
    const st = pollCore(srv, "dev2");
    expect(st.playing).toBe(true);
    expect(st.durationMs).toBe(222_000);
  });

  it("空闲组(无 current、无冻结):durationMs / positionMs 均为 0", () => {
    const srv = makeSrv();
    srv.group("dev3");
    const st = pollCore(srv, "dev3");
    expect(st.playing).toBe(false);
    expect(st.durationMs).toBe(0);
    expect(st.positionMs).toBe(0);
  });

  it("用户 stop:位置与冻结时长一并清零 ⇒ 回到 0:00 / 0:00", () => {
    const srv = makeSrv();
    const g = seedFrozenEnd(srv, "dev4", 262_000);
    stopCore(srv, "dev4");
    expect(g.positionMs).toBe(0);
    expect(g.frozenDurationMs).toBe(0);
    const st = pollCore(srv, "dev4");
    expect(st.durationMs).toBe(0);
    expect(st.positionMs).toBe(0);
  });

  it("用户组 stop:同样清零冻结时长", () => {
    const srv = makeSrv();
    const g = seedFrozenEnd(srv, "ug:u1", 262_000);
    stopGroupCore(srv, "ug:u1");
    expect(g.frozenDurationMs).toBe(0);
    expect(pollCore(srv, "ug:u1").durationMs).toBe(0);
  });

  it("新曲起播失败:current 清空且冻结时长归零 ⇒ 不残留上一首时长", async () => {
    const srv = makeSrv();
    const g = seedFrozenEnd(srv, "dev5", 262_000);
    eng.pumps.set("dev5", { ...eng.mk("dev5"), play: vi.fn(async () => { throw new Error("no playable source"); }) });
    playCore(srv, "dev5", { songId: "s5", duration: 200 } as any);
    await new Promise((r) => setTimeout(r, 0)); // 等后台起播失败回调
    expect(g.current).toBeNull();
    expect(g.frozenDurationMs).toBe(0); // 不残留 262000
    expect(pollCore(srv, "dev5").durationMs).toBe(0);
  });

  it("用户组起播失败:同样清空 current 与冻结时长", async () => {
    const srv = makeSrv();
    const g = seedFrozenEnd(srv, "ug:u2", 262_000);
    eng.pumps.set("ug:u2", { ...eng.mk("ug:u2"), play: vi.fn(async () => { throw new Error("no playable source"); }) });
    playGroupCore(srv, "ug:u2", [], { songId: "s6", duration: 200 } as any);
    await new Promise((r) => setTimeout(r, 0));
    expect(g.current).toBeNull();
    expect(g.frozenDurationMs).toBe(0);
    expect(pollCore(srv, "ug:u2").durationMs).toBe(0);
  });
});
