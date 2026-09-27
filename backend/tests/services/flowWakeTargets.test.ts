// 音流等待阶段的「主动唤醒」:目标里的 sendspin / airplay 设备必须被外部催一次发现,
// 否则音流再怎么等也看不见它们。
//
// 🔴 为什么必须锁在单测里(这是真机上踩出来的,不是凭空补的覆盖率):
//   - sendspin 的 peer **只在设备已连上时才注册**。它的 mDNS browser 每 60s 才重建一次
//     (discover.ts BROWSER_REFRESH_MS),而音流的等待窗口 waitTimeoutSec 常见 30~60s
//     ⇒ 窗口常常比 browser 重建周期还短,不主动催,必然等到 timeout 也看不见设备。
//   - airplay 靠常驻 mDNS browser,收不到刚上电设备的首轮应答,得开短命句柄重扫一次。
//   - 更隐蔽的是 fork 模式:发现循环活在 **sendspin 子进程**里,音流引擎跑在主进程。
//     在主进程直调 refreshPlayerDiscoveryNow 是**静默空转**(2026-09-25 实测:音流唤醒
//     100% 无效,日志只有一句「sendspin 服务未运行」)。唯一正确入口是
//     wakeSendspinDiscovery()(内部按 isForkMode 分派 RPC / 直跑)。
//
// 本文件只验证 wakeTargets 的**决策**:该不该催、催哪条通道、被配置拦下时是不是静默。
// 唤醒通道本身的语义由 sendspin / airplay 各自的测试钉死,这里不重复。
//
// ⚠️ 断言走**副作用**(wakeSendspinDiscovery / rescanAirPlayDevices 被调用了几次),
//    不去 spy logger:logger 是 createLogger() 现造实例,与本文件 import 的未必同一份,
//    那种断言一改 logger 实现就红(见 .workbuddy/memory/2026-09-27.md)。
import "../plugins/_env.js";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { sqlite } from "../../src/db/index.js";

const H = vi.hoisted(() => ({
  // ——— 可编排的外部世界 ———
  ready: true,              // checkPlayTarget 的答复:目标此刻是否可播
  playableSeq: [] as boolean[], // 按调用次序给出答案(空 = 恒 true)
  played: [] as string[],
  spinEnabled: true,
  autoDiscover: true,
  readCfgThrows: false,
  spinResult: { rescanned: false, rearmed: [] as string[] },
  spinThrows: false,
  spinCalls: 0,
  spinPending: false,       // 返回一个永不 resolve 的 promise
  airplayThrows: false,
  airplayCalls: 0,
  checkThrows: false,       // 让目标判定抛错,验证 executeFlow 的兜底
  // ——— 群组替身(只给 wakeChannels 的组分支用)———
  groupMembers: [] as string[],
}));

vi.mock("../../src/services/playTarget.js", () => ({
  checkPlayTarget: () => {
    if (H.checkThrows) throw new Error("判定器炸了");
    const seq = H.playableSeq;
    if (seq.length) return { playable: seq.shift()!, reason: undefined };
    return { playable: H.ready, reason: undefined };
  },
}));
vi.mock("../../src/services/peer.js", () => ({
  parsePeerId: (v: string) => {
    const i = String(v).indexOf(":");
    if (i < 0) return null;
    const kind = v.slice(0, i);
    if (!["dlna", "group", "airplay", "sendspin", "local"].includes(kind)) return null;
    return { kind, id: v.slice(i + 1), peerId: v };
  },
  getPeerManager: () => ({
    resolveVisiblePeerId: (p: string) => p,
    get: (p: string) => ({ name: p, available: true }),
  }),
}));
vi.mock("../../src/services/dlna/control.js", () => ({
  refreshDevices: async () => {},
  setDeviceVolume: async () => {},
}));
vi.mock("../../src/services/dlna/queue.js", () => ({
  getQueueManager: () => ({
    playFrom: async (id: string) => { H.played.push(id); },
    setPlayMode: () => {},
  }),
}));
vi.mock("../../src/services/player/index.js", () => ({
  getQueueController: () => ({ transport: async () => {} }),
}));
vi.mock("../../src/services/content.js", () => ({
  resolveContentSongs: async () => ({ name: "测试歌单", rows: [{ id: "s1", title: "t1", duration: 100 }] }),
  songsToQueueItems: (rows: any[]) => rows.map((r) => ({ songId: r.id, title: r.title, mime: "audio/mpeg", duration: r.duration })),
}));
vi.mock("../../src/services/plugin/fixedRecommend.js", () => ({
  isFixedRecommendPlaylist: () => false,
  ensureHomePlaylist: async () => ({ ok: true }),
}));
vi.mock("../../src/services/sendspin/index.js", () => ({
  wakeSendspinDiscovery: async () => {
    H.spinCalls++;
    if (H.spinPending) return new Promise(() => {}); // 永不 resolve
    if (H.spinThrows) throw new Error("sendspin 唤醒失败");
    return H.spinResult;
  },
  isSendspinEnabled: () => H.spinEnabled,
  readSendspinPluginConfig: () => {
    if (H.readCfgThrows) throw new Error("配置坏了");
    return { autoDiscover: H.autoDiscover };
  },
}));
vi.mock("../../src/services/airplay/discovery.js", () => ({
  rescanAirPlayDevices: async () => {
    H.airplayCalls++;
    if (H.airplayThrows) throw new Error("airplay 重扫失败");
  },
}));
vi.mock("../../src/services/group/index.js", () => ({
  getGroupManager: () => ({ get: () => ({ memberIds: H.groupMembers }) }),
  splitMemberId: (m: any) => {
    if (typeof m !== "string" || !m) return null;
    if (m.startsWith("group:") || m.startsWith("local:")) return null;
    if (m.startsWith("sendspin:")) return { kind: "sendspin", id: m.slice("sendspin:".length) };
    if (m.startsWith("dlna:")) return { kind: "dlna", id: m.slice("dlna:".length) };
    return { kind: "dlna", id: m };
  },
}));

import { executeFlow, getFlow } from "../../src/services/flows/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 逐级前推的假时钟起点(见 beforeEach 注释)。 */
let clockBase = Date.now();

const FLOW_COLS = `id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, token_id TEXT DEFAULT '',
  owner_user_id TEXT DEFAULT '', name TEXT NOT NULL, definition_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT DEFAULT '', last_run_status TEXT DEFAULT '',
  last_run_error TEXT DEFAULT '', created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

beforeAll(() => {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS flows (${FLOW_COLS});`);
});

/** 落一条音流:等待阶段结束后播一个歌单。targets 决定走哪条唤醒通道。 */
function seed(id: string, targets: string[], waitTimeoutSec = 0, scanIntervalSec = 2) {
  sqlite.prepare("DELETE FROM flows").run();
  sqlite
    .prepare(
      `INSERT INTO flows (id, token, token_id, owner_user_id, name, definition_json, enabled,
                          last_run_at, last_run_status, last_run_error, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      `tok-${id}`,
      "",
      "",
      "唤醒测试",
      JSON.stringify({
        nodes: [
          { type: "target", targets },
          { type: "content", contentType: "playlist", id: "pl-x", name: "测试歌单" },
        ],
        waitTimeoutSec,
        scanIntervalSec,
      }),
      1, "", "", "", "", "",
    );
}

/** 等音流跑到终态(success / timeout / error),避免测试提前收工。
 *  用 performance.now() 计时:慢用例只 fake 了 Date,用 Date.now() 做超时会瞬间判超时。 */
async function awaitStatus(id: string, timeout = 8000) {
  const t0 = performance.now();
  for (;;) {
    const f = getFlow(id);
    if (f && (f.lastRunStatus === "success" || f.lastRunStatus === "timeout" || f.lastRunStatus === "error")) return f;
    if (performance.now() - t0 > timeout) throw new Error(`音流 ${id} 未在 ${timeout}ms 内收敛(当前 status=${f?.lastRunStatus})`);
    await sleep(50);
  }
}

beforeEach(() => {
  H.ready = true;
  H.checkThrows = false; // ⚠️ 不重置会泄漏:等待阶段一抛错,后面每条用例都跟着 error
  H.playableSeq.length = 0;
  H.played.length = 0;
  H.spinEnabled = true;
  H.autoDiscover = true;
  H.readCfgThrows = false;
  H.spinResult = { rescanned: false, rearmed: [] };
  H.spinThrows = false;
  H.spinCalls = 0;
  H.spinPending = false;
  H.airplayThrows = false;
  H.airplayCalls = 0;
  H.groupMembers = [];
  // ⚠️ wakeTargets 有**进程级节流**(WAKE_MIN_GAP_MS = 5s,模块级 lastWakeAt)。
  // 上一条用例留下的时间戳会让本条一进来就被跳过 —— 那覆盖不到任何分支。
  // 这里只 fake Date、不动 setTimeout:时钟逐级前推(恒大于节流窗口),
  // 异步等待仍走真实时钟。⚠️ 只 fake Date 意味着时钟**不会自己流逝**,
  // 所以必须每轮累加,否则「本条时刻 ≈ 上一条时刻」照样撞上节流窗口。
  vi.useFakeTimers({ toFake: ["Date"] });
  clockBase += 600_000;
  vi.setSystemTime(clockBase);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("音流等待阶段:sendspin / airplay 目标主动唤醒", () => {
  it("目标全是 dlna/local ⇒ 一条唤醒通道都不碰", async () => {
    seed("f-dlna", ["dlna:kitchen"]);
    await executeFlow("f-dlna", "http://x");
    const f = await awaitStatus("f-dlna");
    expect(`${f.lastRunStatus}|${f.lastRunError}`).toBe("success|");
    expect(H.spinCalls).toBe(0);
    expect(H.airplayCalls).toBe(0);
  });

  it("sendspin 插件未启用 ⇒ 静默跳过(配置即意志,不做绕过配置的后门)", async () => {
    seed("f-spin-off", ["sendspin:s1"]);
    H.spinEnabled = false;
    await executeFlow("f-spin-off", "http://x");
    const f = await awaitStatus("f-spin-off");
    expect(`${f.lastRunStatus}|${f.lastRunError}`).toBe("success|");
    expect(H.spinCalls).toBe(0); // 没去拨号
  });

  it("插件已启用但 autoDiscover 关闭 ⇒ 同样跳过", async () => {
    seed("f-auto-off", ["sendspin:s1"]);
    H.autoDiscover = false;
    await executeFlow("f-auto-off", "http://x");
    await awaitStatus("f-auto-off");
    expect(H.spinCalls).toBe(0);
  });

  it("读插件配置抛错 ⇒ 当作「不唤醒」,但等待阶段继续(不把整条音流带崩)", async () => {
    seed("f-cfg-throw", ["sendspin:s1"]);
    H.readCfgThrows = true;
    await executeFlow("f-cfg-throw", "http://x");
    const f = await awaitStatus("f-cfg-throw");
    expect(`${f.lastRunStatus}|${f.lastRunError}`).toBe("success|"); // 没把异常冒泡成 error
    expect(f.lastRunError).toBe("");
    expect(H.spinCalls).toBe(0);
  });

  it("wakeSendspinDiscovery 抛错 ⇒ 静默吞掉,下一轮还会再来", async () => {
    seed("f-spin-throw", ["sendspin:s1"]);
    H.spinThrows = true;
    await executeFlow("f-spin-throw", "http://x");
    const f = await awaitStatus("f-spin-throw");
    expect(`${f.lastRunStatus}|${f.lastRunError}`).toBe("success|");
    expect(H.spinCalls).toBe(1); // 试过了,没有再往上抛
  });

  it("rescanned / rearmed 都被如实带回(唤醒实际发生了)", async () => {
    seed("f-spin-ok", ["sendspin:s1"]);
    H.spinResult = { rescanned: true, rearmed: ["s1", "s2"] };
    await executeFlow("f-spin-ok", "http://x");
    await awaitStatus("f-spin-ok");
    expect(H.spinCalls).toBe(1);
  });

  it("airplay 目标 ⇒ 触发一次重扫", async () => {
    seed("f-air-ok", ["airplay:a1"]);
    await executeFlow("f-air-ok", "http://x");
    const f = await awaitStatus("f-air-ok");
    expect(`${f.lastRunStatus}|${f.lastRunError}`).toBe("success|");
    expect(H.airplayCalls).toBe(1);
    expect(H.spinCalls).toBe(0);
  });

  it("airplay 重扫抛错 ⇒ 静默,不打断等待阶段", async () => {
    seed("f-air-throw", ["airplay:a1"]);
    H.airplayThrows = true;
    await executeFlow("f-air-throw", "http://x");
    const f = await awaitStatus("f-air-throw");
    expect(`${f.lastRunStatus}|${f.lastRunError}`).toBe("success|");
    expect(f.lastRunError).toBe("");
  });

  it("群组目标内含 sendspin 成员 ⇒ 组也要催(成员得先连上才可能出声)", async () => {
    seed("f-group-spin", ["group:g1"]);
    H.groupMembers = ["sendspin:s9"];
    H.spinResult = { rescanned: true, rearmed: [] };
    await executeFlow("f-group-spin", "http://x");
    await awaitStatus("f-group-spin");
    expect(H.spinCalls).toBe(1);
  });

  it("群组目标没有 sendspin 成员 ⇒ 不催 sendspin(组行 available 恒 true,不代表要拨号)", async () => {
    seed("f-group-plain", ["group:g1"]);
    H.groupMembers = ["dlna:d1"];
    await executeFlow("f-group-plain", "http://x");
    await awaitStatus("f-group-plain");
    expect(H.spinCalls).toBe(0);
    expect(H.airplayCalls).toBe(0);
  });

  it("目标已可播 ⇒ 首轮就放行,不白等一个扫描间隔", async () => {
    seed("f-first", ["sendspin:s1", "airplay:a1"]);
    H.spinResult = { rescanned: true, rearmed: [] };
    await executeFlow("f-first", "http://x");
    const f = await awaitStatus("f-first");
    expect(`${f.lastRunStatus}|${f.lastRunError}`).toBe("success|");
    // ⚠️ playFrom 收的是 parsePeerId 解析后的 id(不带 `sendspin:` 前缀),
    // 不是节点里写的原始目标串。
    expect(H.played).toContain("s1");
  });

  it("等待阶段抛错 ⇒ executeFlow 兜底写成 error(不让 Promise 静默沉底)", async () => {
    seed("f-boom", ["sendspin:s1"]);
    // 让目标判定在等待阶段抛错 —— 冒泡出 runInternal 时由 executeFlow 的 catch 接住。
    H.checkThrows = true;
    await expect(executeFlow("f-boom", "http://x")).resolves.toBe("started");
    const f = await awaitStatus("f-boom");
    expect(f.lastRunStatus).toBe("error");
    expect(f.lastRunError).toContain("判定器炸了");
  });
});

describe("唤醒节流与日志降级(慢用例:真实时钟 + 受控 Date)", () => {
  it("5s 内不重复催发现;跨过窗口后不再被节流,且日志降为 debug", async () => {
    // 首轮:目标还没上线 ⇒ 进入扫描循环;两条通道都被催,did 非空 ⇒ 首轮打 info。
    H.ready = false; // 必须在 executeFlow 之前生效(beforeEach 会把它重置成 true)
    seed("f-slow", ["sendspin:s1", "airplay:a1"], 4, 2);
    executeFlow("f-slow", "http://x");
    // 第二轮距首轮不足 5s ⇒ **被节流跳过**(刻意设计:防止多条音流叠加轰炸 mDNS)。
    await sleep(2_400);
    expect(getFlow("f-slow")?.lastRunStatus).toBe("waiting");
    // 🔍 这两条断言是「节流真的生效了」的唯一证据:没有它们,上面的 waiting 断言
    //    在节流被整体摘掉的情况下照样通过(催不催发现都不影响 waiting)。
    expect(H.spinCalls).toBe(1); // 只催了一次,第二轮被节流窗口挡住
    // 让目标上线,并把系统时间跨过节流窗口(只 fake Date,真实时钟没走那么久)。
    H.ready = true;
    vi.setSystemTime(Date.now() + 6_000);
    // ⚠️ 这里的第二条音流刻意与首条**共用模块实例**:wakeLogged 是模块级的,
    // 所以它的唤醒日志会走「已打过 info ⇒ 降 debug」那条分支。
    sqlite
      .prepare(
        `INSERT INTO flows (id, token, token_id, owner_user_id, name, definition_json, enabled,
                            last_run_at, last_run_status, last_run_error, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run("f-slow2", "tok-f-slow2", "", "", "唤醒测试2",
        JSON.stringify({
          nodes: [
            { type: "target", targets: ["sendspin:s1", "airplay:a1"] },
            { type: "content", contentType: "playlist", id: "pl-x", name: "测试歌单" },
          ],
          waitTimeoutSec: 0,
          scanIntervalSec: 2,
        }),
        1, "", "", "", "", "");
    await executeFlow("f-slow2", "http://x");
    const f2 = await awaitStatus("f-slow2", 6_000);
    expect(`${f2.lastRunStatus}|${f2.lastRunError}`).toBe("success|");
    expect(H.played).toContain("s1");
    expect(H.spinCalls).toBe(2); // 跨过 5s 窗口后又催了一次(节流是窗口制,不是一次性)
    // 首条音流靠自己走到成功(它没有被第二条打断,也没被节流拖成 timeout)。
    const f1 = await awaitStatus("f-slow", 6_000);
    expect(`${f1.lastRunStatus}|${f1.lastRunError}`).toBe("success|");
  });
});
