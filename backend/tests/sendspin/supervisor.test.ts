// ==================== sendspin supervisor:业务接线补测 ====================
//
// `sendspin/supervisor.ts` 只有一百行,却是 sendspin 子进程与主进程之间**唯一的业务约定**:
// 主进程那份「游戏厅名单」(serverId / 端口 / clients / groups / pair records / attempts)
// 全靠这三个回调落进镜像,客户端的注册/注销/播放失败则全靠 onEvent 转给 index.ts 的钩子。
//
// 宿主的 fork / 握手 / 看门狗 / 退避重启那套通用逻辑另有
// `tests/rendererHost/supervisorBranches.test.ts` 覆盖,但**通用层是同一个、业务接线不是**:
// 换一个业务就把回调换掉,通用层再绿也证明不了 sendspin 这份接线是对的 —— 而这份接线恰恰
// 决定了「客户端一激活就注册播放器」「一断开就注销」这种**漏一条就会留下幽灵播放器**的事。
//
// 所以这里只直接拨这三个回调,不碰 fork(真 fork 见 supervisorFork.test.ts)。
// 回调挂在基类的私有 `opts` 上,测试经 `as any` 取到 —— 这是本文件唯一的越界,
// 目的不是测基类,而是测**子类传进去的那份实现**。
import { describe, it, expect, vi } from "vitest";
import { sendspinSupervisor } from "../../src/services/sendspin/supervisor.js";

const opts = (sendspinSupervisor as any).opts;

/** 与 `initialMirror` 同构的空镜像。 */
const freshMirror = () => ({
  serverId: "",
  port: 0,
  clients: new Map(),
  groups: new Map(),
  records: new Map(),
  attempts: [] as unknown[],
});

const snapshot = (over: Record<string, unknown> = {}) => ({
  clients: [],
  groups: [],
  records: [],
  attempts: [],
  ...over,
});

const client = (clientId: string) => ({ clientId, name: "n-" + clientId });
const group = (name: string) => ({ name, members: [] });
const record = (clientId: string) => ({ clientId, from: "qr", ok: true });

describe("applyReady:子进程自报身份", () => {
  it("mainReady 的 serverId / port 就地落镜(后续 RPC 与日志都依赖它)", () => {
    const m = freshMirror();
    opts.applyReady(m, { serverId: "srv-1", port: 38927 });
    expect(m.serverId).toBe("srv-1");
    expect(m.port).toBe(38927);
  });
});

describe("applyState:快照落镜(键的选择决定镜像查询是否命中)", () => {
  it("三张表分别按 clientId / name / clientId 建索引,attempts 按引用接", () => {
    const m = freshMirror();
    const attempts = [{ at: 1 }];
    opts.applyState(m, snapshot({
      clients: [client("c1"), client("c2")],
      groups: [group("g1"), group("g2")],
      records: [record("c1")],
      attempts,
    }));

    expect([...m.clients.keys()]).toEqual(["c1", "c2"]);
    expect(m.clients.get("c2")?.name).toBe("n-c2");
    // 组按**名字**建索引:HA 那侧只认组名,按 id 索引会导致改组后镜像查不到。
    expect([...m.groups.keys()]).toEqual(["g1", "g2"]);
    expect(m.groups.get("g2")?.name).toBe("g2");
    expect([...m.records.keys()]).toEqual(["c1"]);
    // attempts 必须是同一个数组引用:宿主会就地 push 重试记录,拷一份就永远追不上。
    expect(m.attempts).toBe(attempts);
  });

  it("同名组 / 同 clientId 记录后到先覆盖(镜像是最新态,不是累积)", () => {
    const m = freshMirror();
    opts.applyState(m, snapshot({
      clients: [client("c1")],
      groups: [group("g1")],
      records: [record("c1")],
    }));
    const again = { ...client("c1"), name: "改名后" } as any;
    const g2 = { ...group("g1"), members: ["x"] } as any;
    opts.applyState(m, snapshot({
      clients: [again],
      groups: [g2],
      records: [{ ...record("c1"), ok: false }],
    }));

    expect(m.clients.get("c1")?.name).toBe("改名后");
    expect(m.groups.get("g1")?.members).toEqual(["x"]);
    expect(m.records.get("c1")?.ok).toBe(false);
  });
});

describe("onEvent:业务事件 → 钩子", () => {
  it("activated → onActivated(clientId, name, legacy)", () => {
    const onActivated = vi.fn();
    opts.onEvent(
      { t: "activated", clientId: "c1", name: "客厅", legacy: true },
      { onActivated, onClosed: vi.fn(), onPlayFailed: vi.fn() },
    );
    expect(onActivated).toHaveBeenCalledWith("c1", "客厅", true);
  });

  it("closed → onClosed(clientId)", () => {
    const onClosed = vi.fn();
    opts.onEvent({ t: "closed", clientId: "c1" }, { onClosed, onPlayFailed: vi.fn() });
    expect(onClosed).toHaveBeenCalledWith("c1");
  });

  it("playFailed → onPlayFailed(clientId, songId, message)", () => {
    const onPlayFailed = vi.fn();
    opts.onEvent(
      { t: "playFailed", clientId: "c1", songId: "s9", message: "decoder boom" },
      { onPlayFailed },
    );
    expect(onPlayFailed).toHaveBeenCalledWith("c1", "s9", "decoder boom");
  });

  it("钩子抛错被吞(一个客户端的处理失败不许拖垮整座桥)", () => {
    const boom = () => {
      throw new Error("注册播放器失败");
    };
    expect(() =>
      opts.onEvent({ t: "activated", clientId: "c1", name: "n", legacy: false }, { onActivated: boom }),
    ).not.toThrow();
    expect(() => opts.onEvent({ t: "closed", clientId: "c1" }, { onClosed: boom })).not.toThrow();
    expect(() =>
      opts.onEvent(
        { t: "playFailed", clientId: "c1", songId: "s", message: "m" },
        { onPlayFailed: boom },
      ),
    ).not.toThrow();
  });

  it("未知事件一律忽略(不抛、不调钩子,只留给基类继续处理)", () => {
    const hooks = { onActivated: vi.fn(), onClosed: vi.fn(), onPlayFailed: vi.fn() };
    expect(() => opts.onEvent({ t: "whatever" }, hooks)).not.toThrow();
    expect(hooks.onActivated).not.toHaveBeenCalled();
    expect(hooks.onClosed).not.toHaveBeenCalled();
    expect(hooks.onPlayFailed).not.toHaveBeenCalled();
  });

  it("子类实现里三个钩子都可缺省(基类会判存在再调)", () => {
    expect(() => opts.onEvent({ t: "closed", clientId: "c1" }, {})).not.toThrow();
  });

  it("初始镜像是共享可变容器(落镜就地改,不靠构造新对象)", () => {
    const m = freshMirror();
    opts.applyReady(m, { serverId: "s", port: 1 });
    opts.applyState(m, snapshot());
    expect(m.serverId).toBe("s");
    expect(m.clients.size).toBe(0);
    expect(m.attempts).toEqual([]);
  });
});
