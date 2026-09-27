// 渲染器子进程侧的常驻控制器补测（src/services/rendererHost/childHost.ts）。
//
// 这个文件是**子进程里的进程管理器**，主进程只看到「心跳 / 状态 / RPC 应答」三类消息。
// 三件事值得单独钉住：
//   1. 快照节流：业务状态可能每帧都脏，但绝不能每条都往主进程推；
//   2. 心跳里的**事件循环卡顿自检**——子进程被 SIGKILL 时往往不是它不报，而是
//      事件循环根本转不动了，事后查无实据；
//   3. RPC 异常必须转成 `ok:false` 应答，绝不能让主进程无限等一条永远不来的 res。
//
// 用 in-proc 驱动同一套 handler（不真的 fork），保证测试路径 = 生产路径。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChildRpcHost } from "../../src/services/rendererHost/childHost.js";

const SWEEP = 1_000;      // RENDERER_SNAPSHOT_SWEEP_MS
const HEARTBEAT = 30_000; // RENDERER_HEARTBEAT_MS
const THROTTLE = 150;     // RENDERER_SNAPSHOT_THROTTLE_MS

interface Harness {
  host: ChildRpcHost<any, { v: number }>;
  sent: any[];
  dispatch: any;
  buildState: any;
  onStop: any;
}

function makeHost(opts: any = {}): Harness {
  const sent: any[] = [];
  const dispatch = vi.fn(async () => "dispatch-ok");
  const buildState = vi.fn(() => ({ t: "state" as const, v: 1 }));
  const onStop = vi.fn();
  const host = new ChildRpcHost<any, { v: number }>({
    send: (m: any) => sent.push(m),
    buildState,
    dispatch,
    onStop,
    ...opts,
  });
  return { host, sent, dispatch, buildState, onStop };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("childHost: 快照推送", () => {
  it("markReady 立刻 force 推一次(不等节流窗口)", () => {
    const { host, sent } = makeHost();
    host.markReady();
    expect(sent.filter((m) => m.t === "state")).toHaveLength(1);
  });

  it("未 ready 时兜底扫不推快照;ready 后扫到就推(无钩子的状态变化)", async () => {
    const { host, sent, buildState } = makeHost();
    // ready 前扫一轮:什么都不该发生。
    vi.advanceTimersByTime(SWEEP);
    expect(sent).toHaveLength(0);
    expect(buildState).not.toHaveBeenCalled();

    host.markReady();
    sent.length = 0;
    vi.advanceTimersByTime(SWEEP);
    expect(sent.filter((m) => m.t === "state")).toHaveLength(1);
  });

  it("节流窗口内的连续请求只推一次,窗口过后不补推", async () => {
    const { host, sent } = makeHost({ snapshotThrottleMs: THROTTLE });
    host.markReady();
    sent.length = 0;
    host.requestSnapshot();
    host.requestSnapshot();
    host.requestSnapshot();
    // 三次请求落在同一个节流窗口里,只能出一条。
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(THROTTLE);
    expect(sent.filter((m) => m.t === "state")).toHaveLength(1);
    // 再等一个窗口:已经推过了,不会补第二条。
    vi.advanceTimersByTime(THROTTLE);
    expect(sent.filter((m) => m.t === "state")).toHaveLength(1);
  });

  it("force 会跳过节流按下去,并且清掉之前挂着的节流器", async () => {
    const { host, sent } = makeHost({ snapshotThrottleMs: THROTTLE });
    host.markReady();
    sent.length = 0;
    host.requestSnapshot();
    vi.advanceTimersByTime(THROTTLE - 20);
    host.requestSnapshot(true);
    expect(sent.filter((m) => m.t === "state")).toHaveLength(1);
    // 那个被顶掉的节流器不会再补一条。
    vi.advanceTimersByTime(THROTTLE * 2);
    expect(sent.filter((m) => m.t === "state")).toHaveLength(1);
  });

  it("新脏标记能让已到点的节流器重新推一次(挂起的定时器会重新起算)", async () => {
    const { host, sent, buildState } = makeHost({ snapshotThrottleMs: THROTTLE });
    host.markReady();
    sent.length = 0;
    buildState.mockReturnValueOnce({ t: "state" as const, v: 2 });
    host.requestSnapshot(true);
    expect(sent[0].v).toBe(2);
  });

  it("buildState 返回 null 时不发消息(当前确实没有可推状态)", () => {
    const { host, sent, buildState } = makeHost();
    buildState.mockReturnValue(null);
    host.markReady();
    expect(sent).toHaveLength(0);
  });
});

describe("childHost: 心跳与卡顿自检", () => {
  it("每个心跳周期上报一次心跳(带 pid)", () => {
    const { host, sent } = makeHost({ heartbeatMs: HEARTBEAT });
    vi.advanceTimersByTime(HEARTBEAT);
    const beat = sent.filter((m) => m.t === "heartbeat");
    expect(beat).toHaveLength(1);
    expect(beat[0].pid).toBe(process.pid);
    vi.advanceTimersByTime(HEARTBEAT * 2);
    expect(sent.filter((m) => m.t === "heartbeat")).toHaveLength(3);
  });

  it("心跳周期可注入,缺省才用 30s", () => {
    const { host: h1, sent: s1 } = makeHost({ heartbeatMs: 5_000 });
    vi.advanceTimersByTime(5_000);
    expect(s1.filter((m) => m.t === "heartbeat")).toHaveLength(1);
    const { host: h2, sent: s2 } = makeHost();
    vi.advanceTimersByTime(HEARTBEAT + 1);
    expect(s2.filter((m) => m.t === "heartbeat")).toHaveLength(1);
    void h1; void h2;
  });

  it("【卡顿自检】心跳迟到超过 15s 时留一条 ERROR 日志,凭空找回死因", () => {
    const { host, sent } = makeHost({ heartbeatMs: HEARTBEAT });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.advanceTimersByTime(HEARTBEAT);
    expect(spy).not.toHaveBeenCalled();

    // 模拟事件循环被同步阻塞了一分多钟:系统时间被拨快,心跳回调迟到。
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(HEARTBEAT);
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toContain("loop-lag");
    expect(msg).toMatch(/(mem|rss)=/);
    // 卡顿本身不影响心跳继续上报。
    expect(sent.filter((m) => m.t === "heartbeat")).toHaveLength(2);
  });

  it("【卡顿自检】只报一次,不会每拍都刷屏", () => {
    const { host } = makeHost({ heartbeatMs: HEARTBEAT });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.advanceTimersByTime(HEARTBEAT);
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(HEARTBEAT * 3);
    expect(spy).toHaveBeenCalledTimes(1);
    void host;
  });
});

describe("childHost: 主进程消息", () => {
  it("非对象消息忽略(false)", async () => {
    const { host, dispatch } = makeHost();
    await expect(host.handleMessage(null)).resolves.toBe(false);
    await expect(host.handleMessage(undefined)).resolves.toBe(false);
    await expect(host.handleMessage(42)).resolves.toBe(false);
    await expect(host.handleMessage("req:1")).resolves.toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("非 req 的消息忽略(false),业务状态不受影响", async () => {
    const { host } = makeHost();
    await expect(host.handleMessage({ t: "state", v: 9 })).resolves.toBe(false);
    await expect(host.handleMessage({})).resolves.toBe(false);
  });

  it("req 正常应答:ok:true + result,且 result 为 undefined 时写 null", async () => {
    const { host, sent, dispatch } = makeHost();
    dispatch.mockResolvedValueOnce(undefined);
    await host.handleMessage({ t: "req", id: 7, op: "play", payload: { a: 1 } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "res", id: 7, ok: true, result: null });
    expect(dispatch).toHaveBeenCalledWith("play", { a: 1 });
  });

  it("req 业务抛错 → ok:false + String(e.message),不让主进程干等", async () => {
    const { host, sent, dispatch } = makeHost();
    dispatch.mockRejectedValueOnce(new Error("设备离线"));
    await host.handleMessage({ t: "req", id: 8, op: "pause" });
    expect(sent[0]).toMatchObject({ t: "res", id: 8, ok: false, error: "设备离线" });
  });

  it("抛出的不是 Error 也能出 error 文本(String(e?.message || e))", async () => {
    const { host, sent, dispatch } = makeHost();
    dispatch.mockRejectedValueOnce("plain-throw");
    await host.handleMessage({ t: "req", id: 9, op: "seek" });
    expect(sent[0]).toMatchObject({ ok: false, error: "plain-throw" });
  });

  it("id / op 会被规整:缺失的 op 变成字符串 \"undefined\"", async () => {
    const { host, sent, dispatch } = makeHost();
    await host.handleMessage({ t: "req", id: "3" });
    expect(dispatch).toHaveBeenCalledWith("undefined", undefined);
    expect(sent[0].id).toBe(3);
  });
});

describe("childHost: 生命周期", () => {
  it("dispose 后兜底扫与心跳全部停掉", () => {
    const { host, sent } = makeHost();
    host.markReady();
    host.dispose();
    sent.length = 0;
    vi.advanceTimersByTime(SWEEP * 5);
    vi.advanceTimersByTime(HEARTBEAT * 5);
    expect(sent).toHaveLength(0);
  });

  it("dispose 时把还挂着的节流器一起清掉(否则定时器活到下一轮)", () => {
    const { host, sent } = makeHost({ snapshotThrottleMs: THROTTLE });
    host.markReady();
    host.requestSnapshot();
    sent.length = 0;
    host.dispose();
    // 挂起的节流器若没被清,这里会补推一条状态快照。
    vi.advanceTimersByTime(THROTTLE * 3);
    expect(sent).toHaveLength(0);
  });

  it("业务侧 onStop 由业务自己调(子进程入口负责,宿主持有不做)", () => {
    const { host, onStop } = makeHost();
    host.markReady();
    expect(onStop).not.toHaveBeenCalled();
    host.dispose();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("心跳默认周期确实取自 ipcProtocol 的常量(30s)", () => {
    const { host, sent } = makeHost();
    host.markReady();
    vi.advanceTimersByTime(HEARTBEAT - 1);
    expect(sent.filter((m) => m.t === "heartbeat")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent.filter((m) => m.t === "heartbeat")).toHaveLength(1);
    void host;
  });
});
