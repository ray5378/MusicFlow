// ==================== RendererHostSupervisor 真 fork 冒烟测试 ====================
//
// 补上一个此前**完全零覆盖**的路径:生产里 supervisor 到底有没有真的 fork 起子进程。
//
// 为什么以前没有:业务侧的 `mode.ts` 见到 `VITEST` 一律返回 false(单测走 in-proc 装配),
// 所以 `childMain.test.ts` 之类跑的永远是「同一进程内的控制器」,「生产是否真 fork」只由
// 注释与 CHANGELOG 背书,一条断言都没有。本文件绕开 `isRendererForkMode()`,**直接构造
// 通用宿主并指向一个纯 JS 夹具子进程**,从而真的过一遍:
//   fork → mainReady 握手 → RPC 往返 → 快照镜像 → SIGKILL → 退避重启 → 优雅 stop。
//
// 依赖的夹具见 `fixtures/stubRendererChild.mjs`(故意用 .mjs:fork 直接跑 node,
// 不依赖任何 TS loader,与 vitest 的 process.execArgv 解耦)。
import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { RendererHostSupervisor } from "../../src/services/rendererHost/supervisor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD_ENTRY = path.join(here, "fixtures", "stubRendererChild.mjs");

interface Mirror { ready: boolean; port: number; n: number }
interface ReadyInfo { ready: boolean; port: number }
interface Snapshot { n: number }
interface Ev { t: string }
type Hooks = Record<string, never>;
type Sup = RendererHostSupervisor<Mirror, ReadyInfo, Snapshot, Ev, Hooks>;

/** 每个用例自建宿主,并在 afterEach 统一收尾,避免子进程泄漏/跨用例串味。 */
const created: Sup[] = [];

function makeSup(childEnv?: Record<string, string>): Sup {
  const sup: Sup = new RendererHostSupervisor<Mirror, ReadyInfo, Snapshot, Ev, Hooks>({
    name: "stub-renderer",
    logName: "STUB",
    childEntry: CHILD_ENTRY,
    childEnv,
    initialMirror: { ready: false, port: 0, n: 0 },
    applyReady: (m, info) => { m.ready = info.ready; m.port = info.port; },
    applyState: (m, s) => { m.n = s.n; },
  });
  created.push(sup);
  return sup;
}

async function waitFor(cond: () => boolean, timeoutMs = 20_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("waitFor 超时");
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

afterEach(async () => {
  for (const s of created) {
    try { await s.stop(); } catch { /* 已死/未启动 */ }
  }
  created.length = 0;
});

describe("RendererHostSupervisor 真 fork 冒烟", () => {
  it("start() 真的 fork 出存活子进程,且 mainReady 载荷过了 IPC 边界", async () => {
    const sup = makeSup({ STUB_PORT: "38927" });
    expect(sup.isRunning()).toBe(false);
    expect(sup.childPid).toBeUndefined();

    await sup.start();

    expect(sup.isRunning()).toBe(true);
    expect(sup.childPid).toBeGreaterThan(0);
    // 握手载荷来自子进程自报 → 证明这不是本地假装配
    expect(sup.mirror.ready).toBe(true);
    expect(sup.mirror.port).toBe(38927);
    expect(alive(sup.childPid!)).toBe(true);
  }, 30_000);

  it("rpc() 真往返:结果里的 pid 就是被 fork 的子进程", async () => {
    const sup = makeSup();
    await sup.start();
    const r = await sup.rpc<{ pong: boolean; pid: number }>("ping");
    expect(r.pong).toBe(true);
    expect(r.pid).toBe(sup.childPid);
  }, 30_000);

  it("rpc() 原样透传 payload 并回结果", async () => {
    const sup = makeSup();
    await sup.start();
    const echoed = await sup.rpc("echo", { a: 1, b: "x", nested: { ok: true } });
    expect(echoed).toEqual({ a: 1, b: "x", nested: { ok: true } });
  }, 30_000);

  it("子进程抛错 → rpc reject 且带上子进程的报错文案", async () => {
    const sup = makeSup();
    await sup.start();
    await expect(sup.rpc("boom")).rejects.toThrow(/故意失败/);
  }, 30_000);

  it("子进程 state 快照落到主进程镜像(同步可读)", async () => {
    const sup = makeSup();
    await sup.start();
    expect(sup.mirror.n).toBe(0);
    await sup.rpc("bump");
    await waitFor(() => sup.mirror.n === 1);
    expect(sup.mirror.n).toBe(1);
  }, 30_000);

  it("stop() 后子进程真的退出,isRunning 归位", async () => {
    const sup = makeSup();
    await sup.start();
    const pid = sup.childPid!;
    await sup.stop();
    expect(sup.isRunning()).toBe(false);
    await waitFor(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("子进程被 kill -9 → 按退避重启,新进程可继续服务", async () => {
    const sup = makeSup();
    await sup.start();
    const pid1 = sup.childPid!;
    expect(pid1).toBeGreaterThan(0);

    process.kill(pid1, "SIGKILL");

    // 退避基线 3s(RENDERER_RESPAWN_BASE_MS)+ 启动握手,给足余量。
    await waitFor(() => sup.childPid !== undefined && sup.childPid !== pid1);
    const pid2 = sup.childPid!;
    expect(pid2).not.toBe(pid1);
    expect(sup.isRunning()).toBe(true);

    // 重启后的新子进程真的能干活(而不是只剩一个空壳状态)
    const r = await sup.rpc<{ pong: boolean; pid: number }>("ping");
    expect(r.pid).toBe(pid2);
    expect(alive(pid2)).toBe(true);
  }, 30_000);

  it("子进程启动即退 → start() 明确报错,不静默半死", async () => {
    const sup = makeSup({ STUB_EXIT_ON_BOOT: "1" });
    await expect(sup.start()).rejects.toThrow(/启动即退/);
    expect(sup.isRunning()).toBe(false);
  }, 30_000);
});

describe("RendererHostSupervisor 未运行时的边界", () => {
  it("未 start 就 rpc → 立刻失败(不挂起到超时)", async () => {
    const sup = makeSup();
    await expect(sup.rpc("ping")).rejects.toThrow(/子进程未运行/);
  }, 10_000);

  it("stop() 幂等:从未启动过也能安全调用", async () => {
    const sup = makeSup();
    await expect(sup.stop()).resolves.toBeUndefined();
  }, 10_000);
});
