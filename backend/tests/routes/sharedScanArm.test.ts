// ==================== routes/api/shared.ts 分支补测 ====================
//
// 补三处此前零覆盖的分支,都是"排障时最想知道答案、却从没跑过"的那几行:
//   1) scanJobsSweep        —— 扫描任务 Map 的无界增长防线(running 任务必须豁免);
//   2) sendspinServerOr404  —— fork 模式下 sendspin 的「镜像代理」,拿不到就得 404;
//   3) borrowLandingConfirmed —— 泵移交到底落没落位(落位与否,后续处置**完全相反**)。
//
// 装配沿用 `sharedHelpers.test.ts` 的既有姿势:只替换 leaf 里那几个导出,其余原样透出
// (shared.ts 的静态依赖面很宽,整块 mock 会漏导出并在 import 期就炸)。
// `scanJobsSweep` 是模块顶层建的 interval,所以必须在 stub 掉 setInterval **之后**动态 import,
// 否则抓不到它的回调,只能去动 fake timers —— 那样还得连带处理 Date。
import { describe, it, expect, beforeEach, vi } from "vitest";

type Any = any;

const leaf: Any = {
  getSendspinFront: vi.fn(),
  getPlayerState: vi.fn(),
};

vi.mock("../../src/services/sendspin/index.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getSendspinFront: leaf.getSendspinFront,
}));

vi.mock("../../src/services/player/index.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  getQueueController: () => ({ getPlayerState: leaf.getPlayerState }),
}));

let shared: Any;
let sweeps: Any[] = [];
let unrefbed: Any[] = [];

async function loadShared(): Promise<void> {
  sweeps = [];
  unrefbed = [];
  vi.stubGlobal("setInterval", (fn: Any) => {
    sweeps.push(fn);
    return { unref: () => unrefbed.push(fn), ref: () => {} };
  });
  // 关键:ESM 会把 shared.js 缓存下来,不重置模块注册表的话第二次 beforeEach 拿到的是
  // 同一个已加载实例 —— 它的 setInterval 早就执行过了,抓不到回调,用例就会假绿/假红。
  vi.resetModules();
  shared = await import("../../src/routes/api/shared.js");
  vi.unstubAllGlobals();
}

beforeEach(async () => {
  for (const f of Object.values(leaf)) (f as Any).mockReset();
  leaf.getSendspinFront.mockReturnValue(null);
  leaf.getPlayerState.mockResolvedValue(null);
  await loadShared();
});

describe("scanJobsSweep:扫描任务回收", () => {
  it("超 TTL 的终态任务被清掉;running 与新鲜任务必须保留", () => {
    const now = Date.now();
    const iso = (t: number) => new Date(t).toISOString();

    shared.scanJobs.set("old-done", { status: "done", startedAt: iso(now - 31 * 60_000) } as Any);
    shared.scanJobs.set("old-failed", { status: "error", startedAt: iso(now - 31 * 60_000) } as Any);
    // running 豁免:并发判定靠它,清了会把正在跑的扫描误判成"没在跑"。
    shared.scanJobs.set("running-old", { status: "running", startedAt: iso(now - 90 * 60_000) } as Any);
    shared.scanJobs.set("fresh", { status: "done", startedAt: iso(now - 1_000) } as Any);

    for (const fn of sweeps) fn();

    expect(shared.scanJobs.has("old-done")).toBe(false);
    expect(shared.scanJobs.has("old-failed")).toBe(false);
    expect(shared.scanJobs.has("running-old")).toBe(true);
    expect(shared.scanJobs.has("fresh")).toBe(true);
  });

  it("回收用的 interval 句柄做了 unref(不该拖住进程退出)", () => {
    expect(sweeps.length).toBeGreaterThan(0);
    expect(unrefbed).toEqual(sweeps);
  });
});

describe("sendspinServerOr404:fork 模式的镜像代理", () => {
  // 注:这条用例对"摘掉 if (!srv) return null"是不敏感的 —— 摘掉后走的是紧随其后的
  // `return srv`,在 srv 为 null 时结果一样。它守的是**契约**(拿不到就必须给 null,
  // 路由据此 404),不是那行防御性写法本身。
  it("拿不到 sendspin 前端实例 ⇒ null(路由据此 404)", () => {
    leaf.getSendspinFront.mockReturnValue(null);
    expect(shared.sendspinServerOr404({})).toBeNull();
  });

  it("有实例 ⇒ 原样带回去(路由自己决定读快照还是走 RPC)", () => {
    const srv = { port: 38927, id: "srv-1" };
    leaf.getSendspinFront.mockReturnValue(srv);
    expect(shared.sendspinServerOr404({})).toBe(srv);
  });
});

describe("borrowLandingConfirmed:泵移交是否真的落位", () => {
  it("读回进度与落点差 <= 1.5s ⇒ 确认落位", async () => {
    leaf.getPlayerState.mockResolvedValue({ position: 10.4 });
    expect(await shared.borrowLandingConfirmed("sendspin:sc1", 10)).toBe(true);
  });

  it("差 > 1.5s ⇒ 不确认(调用方必须补 seek,不能谎报落位)", async () => {
    leaf.getPlayerState.mockResolvedValue({ position: 12.4 });
    expect(await shared.borrowLandingConfirmed("sendspin:sc1", 10)).toBe(false);
  });

  it("读不到进度 ⇒ 不确认;expectSeconds 非正时直接短路,不去碰设备", async () => {
    leaf.getPlayerState.mockResolvedValue(null);
    expect(await shared.borrowLandingConfirmed("sendspin:sc1", 10)).toBe(false);
    expect(leaf.getPlayerState).toHaveBeenCalledTimes(1);

    expect(await shared.borrowLandingConfirmed("sendspin:sc1", 0)).toBe(false);
    expect(await shared.borrowLandingConfirmed("sendspin:sc1", null)).toBe(false);
    expect(leaf.getPlayerState).toHaveBeenCalledTimes(1);
  });
});
