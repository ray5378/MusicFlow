// ==================== RendererHostSupervisor:分支补测(让 38 个未覆盖行落地) ====================
//
// `supervisorFork.test.ts` 走的是「一条主路径冒烟」:fork → 握手 → RPC → 快照 → SIGKILL →
// 退避重启 → stop。这条链路跑通了,但**分支面**仍是零覆盖:setHooks、rpc 超时与发送失败、
// post 的三种死法、启动超时、onMessage 的 5 个信封分支、onExit 打挂 pending、重启成功/失败
// 两条收尾、以及心跳看门狗。生产里这些分支恰恰是排障时唯一能看出「到底卡在哪一步」的地方
// (比如心跳超时那条诊断日志会带上「最后 RPC op」和「悬挂 RPC 个数」),所以逐个补。
//
// 与前者的分工:前者证明"真 fork 的世界存在",本文件证明"每条失败分支都按设计降级"。
// 时钟全部走真实时钟 —— 本模块的重启退避/心跳间隔是**秒级常量**,fake timers 反而会让
// fork 出来的子进程消息与父进程计时器互相错配;慢用例单独放宽 timeout。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { rmSync } from "fs";
import { RendererHostSupervisor } from "../../src/services/rendererHost/supervisor.js";

/** 必须与 `fixtures/stubRendererChild.mjs` 里的 DEATH_MARK 一致,否则死亡环第一轮就退化。 */
const DEATH_MARK = "/tmp/stub-death-loop-seen";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD_ENTRY = path.join(here, "fixtures", "stubRendererChild.mjs");

interface Mirror { ready: boolean; port: number; n: number }
interface ReadyInfo { ready: boolean; port: number }
interface Snapshot { n: number }
interface Ev { t: string; note?: string }
type Hooks = { tag: string };
type Sup = RendererHostSupervisor<Mirror, ReadyInfo, Snapshot, Ev, Hooks>;

/** onEvent 用例间要换实现(含"故意抛错"),所以走一个可替换的槽位而不是闭包常量。 */
const EVT: {
  seen: Array<{ t: string; tag: string }>;
  handler: ((e: Ev, h: Hooks) => void) | undefined;
} = { seen: [], handler: undefined };

const created: Sup[] = [];

function makeSup(childEnv?: Record<string, string>, extra: Partial<any> = {}): Sup {
  const sup: Sup = new RendererHostSupervisor<Mirror, ReadyInfo, Snapshot, Ev, Hooks>({
    name: "stub-renderer",
    logName: "STUBBR",
    childEntry: CHILD_ENTRY,
    childEnv,
    initialMirror: { ready: false, port: 0, n: 0 },
    applyReady: (m, info) => { m.ready = info.ready; m.port = info.port; },
    applyState: (m, s) => { m.n = s.n; },
    onEvent: (e: Ev, h: Hooks) => {
      EVT.seen.push({ t: e.t, tag: h.tag });
      EVT.handler?.(e, h);
    },
    ...extra,
  });
  created.push(sup);
  return sup;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 20_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(stepMs);
  }
  throw new Error("waitFor 超时");
}

const alive = (pid: number): boolean => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

beforeEach(() => {
  // 死亡环标记文件不清掉的话,第二次跑时首轮就被判成"重启轮" ⇒ 用例变绿却没测到重点。
  try { rmSync(DEATH_MARK, { force: true }); } catch { /* 不存在即可 */ }
});

afterEach(async () => {
  for (const s of created) {
    try { await s.stop(); } catch { /* 已死/未启动 */ }
  }
  created.length = 0;
  EVT.seen = [];
  EVT.handler = undefined;
});

describe("RendererHostSupervisor 分支:事件分发 / RPC 失败 / 信封", () => {
  it("setHooks 注入的 hooks 会随业务事件一起交给 onEvent", async () => {
    const sup = makeSup();
    await sup.start();

    sup.setHooks({ tag: "H" });

    EVT.seen = [];
    const r = await sup.rpc("emit", { note: "hello" });
    expect(r).toBe("emitted");

    // 第二个参数就是 setHooks 注入的那份 hooks —— 空 hooks 说明这条链路没走通。
    expect(EVT.seen).toEqual([{ t: "activated", tag: "H" }]);
  });

  it("onEvent 自己抛错时静默吞掉,不拖垮宿主后续 RPC", async () => {
    const sup = makeSup();
    await sup.start();
    sup.setHooks({ tag: "H" });

    EVT.handler = () => { throw new Error("事件处理炸了"); };

    await sup.rpc("emit", { note: "x" }).catch(() => {});
    // 宿主本身没被带崩:镜像与后续 RPC 都还正常
    await sup.rpc("echo", { v: 1 });
    expect(await sup.rpc("echo", { v: 2 })).toEqual({ v: 2 });
    expect(sup.mirror.ready).toBe(true);
  });

  it("rpc 超时 ⇒ reject,并且不留悬挂 pending", async () => {
    const sup = makeSup();
    await sup.start();

    // slow 要 600ms,这里只给 100ms;心跳被 mute 不影响本用例(悬挂在 RPC 自己身上)。
    const p = sup.rpc("slow", { ms: 600 }, 100);
    await expect(p).rejects.toThrow(/rpc 超时: slow \(100ms\)/);

    // 超时后 pending 必须清空:否则子进程晚到的 res 会拿不到 handler(或重复 reject)。
    expect((sup as any)["pending"].size).toBe(0);
  }, 20_000);

  it("child.send 抛错(IPC 通道已断)⇒ reject rpc 发送失败", async () => {
    const sup = makeSup();
    await sup.start();

    const child: any = (sup as any)["child"];
    child.send = () => { throw new Error("channel closed"); };

    await expect(sup.rpc("ping")).rejects.toThrow(/rpc 发送失败: ping channel closed/);
    expect((sup as any)["pending"].size).toBe(0);
  });

  it("post 下发 / child 为空 / send 抛错 三种死法都不抛", async () => {
    const sup = makeSup();
    await sup.start();

    expect(() => sup.post({ t: "config", hot: 1 })).not.toThrow();

    // 子进程已不在了:post 必须安静,重启路径会带新配置。
    (sup as any)["child"] = null;
    expect(() => sup.post({ t: "config", hot: 2 })).not.toThrow();

    (sup as any)["child"] = { send: () => { throw new Error("EPIPE"); } };
    expect(() => sup.post({ t: "config", hot: 3 })).not.toThrow();
  });

  it("子进程永不握手 ⇒ start() 报启动超时,而非一直挂着", async () => {
    const sup = makeSup({ STUB_BOOT_SLOW: "1" }, { bootTimeoutMs: 300 });
    await expect(sup.start()).rejects.toThrow(/子进程启动超时/);
    expect(sup.isRunning()).toBe(false);
    // 启动超时**不会**顺手 kill 子进程:宿主还攥着引用,等调用方 stop() 兜底强杀。
    // 这条兜底链本身必须钉住 —— 否则半死的子进程就这么留在进程表里。
    expect(sup.childPid).toBeGreaterThan(0);
    await sup.stop();
    expect(sup.childPid).toBeUndefined();
  }, 20_000);

  it("heartbeat / childReady / stopped 三个信封只走各自的 return", async () => {
    const sup = makeSup();
    await sup.start();
    sup.setHooks({ tag: "H" });
    EVT.seen = [];

    const onMessage = (sup as any)["onMessage"].bind(sup);
    for (const env of [{ t: "heartbeat" }, { t: "childReady" }, { t: "stopped" }]) {
      expect(() => onMessage(env)).not.toThrow();
      expect(EVT.seen).toHaveLength(0);        // 都不是业务事件,不该分发
    }
    // 镜像也没被动过
    expect(sup.mirror).toEqual({ ready: true, port: 0, n: 0 });
  });

  it("子进程猝死时,挂起的 RPC 全部被 reject(不是静默悬挂到超时)", async () => {
    const sup = makeSup();
    await sup.start();

    // dieNow 故意不回 res 就 exit(1),让宿主侧真正有悬挂项。
    await expect(sup.rpc("dieNow")).rejects.toThrow(/子进程退出: code=1/);
    expect((sup as any)["pending"].size).toBe(0);
  }, 20_000);
});

describe("RendererHostSupervisor 分支:退避重启 / 看门狗", () => {
  it("崩溃待重启期间 stop() ⇒ 取消待触发的重生", async () => {
    // 这三个「退避重启」用例**故意不压 heartbeatMs**:默认阈值 65s 远大于 3s 的退避窗口,
    // 才能把"退避重启"与"看门狗强杀"两条路径分开验证。压到 125ms 的结果是新子进程
    // 一上线就被看门狗再杀一次,用例会偶发红在"子进程未运行"上。
    const sup = makeSup({ STUB_DIE_AFTER_READY: "1" }, { bootTimeoutMs: 2_000 });
    await sup.start();
    const pid = sup.childPid!;

    await waitFor(() => !alive(pid));          // 子进程已自尽,退避计时器正在倒计时
    await sup.stop();                          // 计划内停止:必须先掐掉 respawnTimer

    await sleep(4_000);                        // 跨过 RENDERER_RESPAWN_BASE_MS(3s)
    expect(sup.childPid).toBeUndefined();
    expect(sup.isRunning()).toBe(false);
  }, 30_000);

  it("崩溃后退避重启成功,子进程重新变得可用", async () => {
    const sup = makeSup({ STUB_DIE_AFTER_READY: "1" }, { bootTimeoutMs: 2_000 });
    await sup.start();
    const dead = sup.childPid!;
    const startedAtBefore = (sup as any)["startedAt"] as number;

    await waitFor(() => !alive(dead));
    // ⚠️ 不能用「pid 变了」当重启成功:respawn 一 fork 出来 pid 就变了,而 spawnAndWait
    // 还在等 mainReady。此刻 rpc 甚至也能成功(子进程入口消息处理器先于握手就绪),
    // 于是退避成功回调里的 `startedAt = Date.now()` 尚未执行 —— 断言必须等那一行落地。
    await waitFor(() => (sup as any)["startedAt"] > startedAtBefore, 15_000);

    // 现在是真·重启成功:新子进程对 RPC 有应答(光看 pid 变化说明不了任何事)。
    expect(await sup.rpc("ping")).toMatchObject({ pong: true });
    expect(sup.isRunning()).toBe(true);
  }, 30_000);

  it("重启反复失败 ⇒ running 降级为 false 后不再被点亮,心跳 interval 只空转不误杀", async () => {
    const sup = makeSup({ STUB_DEATH_LOOP: "1" }, { bootTimeoutMs: 2_000 });
    await sup.start();
    expect(sup.isRunning()).toBe(true);

    // 夹具约定:死亡环子进程第一轮握手成功,之后每轮都在握手前 exit(3)
    // ⇒ 退避重启必定失败,正好打进"重启失败"的 catch。
    await waitFor(() => sup.isRunning() === false, 15_000);

    // 注意:这条路径**不清**心跳 interval(running 是被重启失败打掉的,不是走 stop),
    // 于是后续每次 interval 触发都会先撞 `if (!this.running) return` —— 那行是防误杀的唯一防线。
    expect((sup as any)["heartbeatCheck"]).not.toBeNull();

    // 跨过若干个重启周期 + 至少一次 10s 心跳检查,确认没有哪一轮把它重新点亮。
    await sleep(11_000);
    expect(sup.isRunning()).toBe(false);
  }, 45_000);

  it("心跳停摆 ⇒ 看门狗强杀重启,并打出含最后 RPC op / 悬挂数的诊断", async () => {
    const sup = makeSup({ STUB_MUTE: "1" }, { bootTimeoutMs: 2_000, heartbeatMs: 60 });
    await sup.start();
    const dead = sup.childPid!;
    const startedAtBefore = (sup as any)["startedAt"] as number;

    // 心跳周期被压到 60ms(阈值 125ms),但**检查粒度是硬编码的 10s**,
    // 所以最坏要等一个完整检查周期才动手 —— 这也是这条分支至今没人碰的原因。
    // 夹具此刻仍活着(STUB_MUTE 只掐心跳,不杀进程),所以 childPid 掉到 undefined
    // 只可能来自看门狗的 killChild ⇒ 这条断言就是"强杀确实发生了"的可证伪证据。
    await waitFor(() => sup.childPid === undefined, 25_000);
    // 强杀会顺带触发退避重启;等它真的走完,再验证新进程可用。
    await waitFor(() => (sup as any)["startedAt"] > startedAtBefore, 15_000);
    expect(sup.isRunning()).toBe(true);
    // 强杀后走的是正常退避路径:新子进程依旧能用。
    expect(await sup.rpc("ping")).toMatchObject({ pong: true });
  }, 45_000);
});
