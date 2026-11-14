// ==================== 推流倍速（sendspin 泵）契约 ====================
//
// 覆盖 2026-11-14 新增的倍速：解码 af 末尾 `atempo` + 泵时间轴换算。
//
// 三条不可见不变量（写错都表现为「能播但时间不对」，不抛异常）：
//   ① 解码段：倍速必须进 `resolveSendspinAf` 的**链尾**（响度先按原始时长积分）；
//   ② 泵内部：所有时间轴（playCursor/durationMs/pendingSeekMs）是**输出流毫秒**
//      —— 1.5x 时 120s 内容只有 80s 样本，durationMs 必须是 80000；
//   ③ 对外：pollCore 的 positionMs 必须乘回倍率（内容时间），durationMs 保持内容口径。
//
// 夹具与 pumpHandover.test.ts 同款：真实 DB 行 + 真实 ffmpeg 解码 120s WAV，
// 不碰外网；每个用例后强制停泵（失败路径也要收拾，否则 300s PCM 会把进程堆爆）。
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sqlite } from "../../src/db/index.js";
import { registerBuiltinPlugins } from "../../src/plugins/builtins.js";
import { pumpFor, stopGroupPump, type GroupPump } from "../../src/services/sendspin/streamEngine.js";
import { resolveSendspinAf } from "../../src/services/sendspin/streamSource.js";
import { pollCore } from "../../src/services/sendspin/playerCore.js";

function makeWav(seconds = 120): Buffer {
  const rate = 48000;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.floor(28000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const SONG = "speed-src-song";
const trackedGroups: any[] = [];

function groupStub(name: string) {
  const g: any = {
    name,
    id: name,
    positionMs: 0,
    timelineBaseUs: 0n,
    current: null as any,
    members: new Set<any>(),
    pendingAnnounces: [] as any[],
    closed: 0,
    finished: 0,
    commonSendAheadUs: () => 800_000,
    capacityLimitedPrefillMs: () => 3_000,
    add(c: any) { g.members.add(c); },
    close() { g.closed++; },
    finishPlayback() { g.finished++; },
    async pushFrame() { /* 不落盘：本用例只验证时间轴 */ },
  };
  trackedGroups.push(g);
  return g;
}

function cursorOf(pump: GroupPump): number {
  return (pump as any).playCursorMs as number;
}
function fieldOf<T>(pump: GroupPump, k: string): T {
  return (pump as any)[k] as T;
}

async function waitPushed(pump: GroupPump, minMs: number, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const cur = cursorOf(pump);
    if (cur >= minMs) return cur;
    if (Date.now() - t0 > timeoutMs) throw new Error(`泵未推到 ${minMs}ms(当前 ${cur}ms)`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitNotBusy(pump: GroupPump, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (pump.busy) {
    if (Date.now() - t0 > timeoutMs) throw new Error("起播窗口未结束");
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(() => {
  for (const g of trackedGroups.splice(0)) {
    try { stopGroupPump(g); } catch { /* ignore */ }
  }
});

describe("推流倍速: sendspin 单机/组泵", () => {
  let tmpDir = "";
  let wavPath = "";

  beforeAll(() => {
    if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
    process.env.SENDSPIN_PUSH_SPEED = "1";
    process.env.SENDSPIN_PREFILL_MS = "1000";
    registerBuiltinPlugins();
    sqlite
      .prepare(
        "INSERT INTO plugins (id, name, enabled, config) VALUES ('core-play-preference', 'core-play-preference', 1, '{\"preferLocal\":true,\"fallbackToWeb\":true}') ON CONFLICT(id) DO UPDATE SET enabled=1, config=excluded.config",
      )
      .run();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "speedsendspin-"));
    wavPath = path.join(tmpDir, "long.wav");
    fs.writeFileSync(wavPath, makeWav());
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO songs (id, title, artist, type, url, plugin_entry, group_id, path, suffix, duration) VALUES " +
          `('${SONG}','T','A','local','','','speed-fixture','l:src:${wavPath.replace(/'/g, "''")}','wav',120)`,
      )
      .run();
  });

  afterAll(() => {
    delete process.env.SENDSPIN_PUSH_SPEED;
    delete process.env.SENDSPIN_PREFILL_MS;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("decode af:倍速进链尾,1x 不改变 af", () => {
    const base = { rowId: "r1", dspFilters: ["volume=1dB"] };
    const af1 = resolveSendspinAf(base as any);
    expect(af1.some((f) => f.includes("atempo"))).toBe(false);
    const af15 = resolveSendspinAf({ ...base, speed: 1.5 } as any);
    expect(af15[af15.length - 1]).toBe("atempo=1.5");
    expect(af15.slice(0, -1)).toEqual(af1);
  });

  it("1.5x:泵时间轴为输出流毫秒,对外 positionMs 换回内容毫秒", async () => {
    const g = groupStub("speed-dev");
    const srv: any = {
      groups: new Map([[g.name, g]]),
      clients: new Map([["speed-dev", { clientId: "speed-dev", group: g }]]),
      group: (n: string) => srv.groups.get(n) ?? g,
    };
    const pump = pumpFor(srv, g);
    pump.setPlaybackRate(1.5);
    await pump.play(SONG);
    await waitNotBusy(pump, 10_000);
    await waitPushed(pump, 3_000, 20_000);

    // 120s 内容 → 80s 输出流
    const dur = fieldOf<number>(pump, "durationMs");
    expect(dur).toBeGreaterThan(78_000);
    expect(dur).toBeLessThan(82_000);

    // 输出流游标按墙钟 1× 推进（不是 1.5×）
    const cur = cursorOf(pump);
    expect(cur).toBeGreaterThan(2_500);
    expect(cur).toBeLessThan(8_000);

    // 对外:内容位置 = 输出流位置 × 1.5,duration 仍是 120s
    g.positionMs = cur;
    const st = pollCore(srv, "speed-dev");
    expect(st.durationMs).toBe(120_000);
    expect(st.positionMs).toBeGreaterThan(Math.round(cur * 1.4));
    expect(st.positionMs).toBeLessThan(Math.round(cur * 1.6));
  });

  it("0.75x:时长变长(160s),seek 按内容秒换算到泵时间轴", async () => {
    const g = groupStub("speed-dev-075");
    const srv: any = {
      groups: new Map([[g.name, g]]),
      clients: new Map([["speed-dev-075", { clientId: "speed-dev-075", group: g }]]),
      group: (n: string) => srv.groups.get(n) ?? g,
    };
    const pump = pumpFor(srv, g);
    pump.setPlaybackRate(0.75);
    await pump.play(SONG);
    await waitNotBusy(pump, 10_000);
    await waitPushed(pump, 2_000, 20_000);

    const dur = fieldOf<number>(pump, "durationMs");
    expect(dur).toBeGreaterThan(157_000);
    expect(dur).toBeLessThan(163_000);

    // 内容 60s → 输出流 80s（armSeek 是 seekCore/起播共用的换算入口；
    // 直接调它可以在不重建解码器的前提下断言换算结果）
    pump.armSeek(60_000);
    const pending = fieldOf<number>(pump, "pendingSeekMs");
    expect(pending).toBeGreaterThan(78_000);
    expect(pending).toBeLessThan(82_000);

    // 对外仍是内容秒：输出流 81s → 内容 60.75s
    g.positionMs = 81_000;
    const st = pollCore(srv, "speed-dev-075");
    expect(st.positionMs).toBeGreaterThan(60_000);
    expect(st.positionMs).toBeLessThan(61_500);
    expect(st.durationMs).toBe(120_000);
  });
});
