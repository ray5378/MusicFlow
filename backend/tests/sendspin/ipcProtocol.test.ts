// sendspin 子进程 IPC 的名义时序常量必须是 rendererHost 通用层的**别名**,不能各自写字面量 ——
// 否则两侧时序悄悄漂移(例如 RPC 超时 25s 改成 20s 却只改一边),dial 宽限不够会表现为
// 「拨号偶发超时」,极难定位。这个测试把「同源」变成可执行的断言。
import { describe, it, expect } from "vitest";
import {
  SENDSPIN_RPC_TIMEOUT_MS,
  SENDSPIN_STOP_TIMEOUT_MS,
  SENDSPIN_SNAPSHOT_THROTTLE_MS,
  SENDSPIN_SNAPSHOT_SWEEP_MS,
  SENDSPIN_HEARTBEAT_MS,
} from "../../src/services/sendspin/ipcProtocol.js";
import {
  RENDERER_RPC_TIMEOUT_MS,
  RENDERER_STOP_TIMEOUT_MS,
  RENDERER_SNAPSHOT_THROTTLE_MS,
  RENDERER_SNAPSHOT_SWEEP_MS,
  RENDERER_HEARTBEAT_MS,
} from "../../src/services/rendererHost/ipcProtocol.js";

import type {
  ClientMirrorMsg,
  GroupMirrorMsg,
  PairRecordMirrorMsg,
  SendspinSnapshot,
  SendspinReadyInfo,
  SendspinHostExtra,
  SendspinChildEvent,
  ParentToSendspinChild,
  SendspinChildToParent,
  SendspinIpcConfig,
  SendspinStateEnvelope,
} from "../../src/services/sendspin/ipcProtocol.js";

describe("sendspin/ipcProtocol 时序常量别名", () => {
  it("五个别名严格等于 rendererHost 通用层同源常量", () => {
    expect(SENDSPIN_RPC_TIMEOUT_MS).toBe(RENDERER_RPC_TIMEOUT_MS);
    expect(SENDSPIN_STOP_TIMEOUT_MS).toBe(RENDERER_STOP_TIMEOUT_MS);
    expect(SENDSPIN_SNAPSHOT_THROTTLE_MS).toBe(RENDERER_SNAPSHOT_THROTTLE_MS);
    expect(SENDSPIN_SNAPSHOT_SWEEP_MS).toBe(RENDERER_SNAPSHOT_SWEEP_MS);
    expect(SENDSPIN_HEARTBEAT_MS).toBe(RENDERER_HEARTBEAT_MS);
  });

  it("量级守卫:超时/周期不得被误改成 0 或负数", () => {
    // dial 需要 15s+ 宽限,故 RPC 超时必须显著大于它。
    expect(SENDSPIN_RPC_TIMEOUT_MS).toBeGreaterThan(15_000);
    expect(SENDSPIN_STOP_TIMEOUT_MS).toBeGreaterThan(0);
    // 快照节流必须小于兜底周期,否则「脏了立即推」永远被节流吃掉。
    expect(SENDSPIN_SNAPSHOT_THROTTLE_MS).toBeGreaterThan(0);
    expect(SENDSPIN_SNAPSHOT_SWEEP_MS).toBeGreaterThan(SENDSPIN_SNAPSHOT_THROTTLE_MS);
    expect(SENDSPIN_HEARTBEAT_MS).toBeGreaterThan(SENDSPIN_SNAPSHOT_SWEEP_MS);
  });
});

describe("sendspin/ipcProtocol 业务载荷类型契约", () => {
  it("快照载荷保持平铺形状(不含 positionMs —— 高频字段走 poll)", () => {
    const client: ClientMirrorMsg = {
      clientId: "c1",
      name: "客厅",
      roles: ["player@v1"],
      legacy: false,
      ready: true,
      remoteHost: "192.168.1.9",
      dialed: false,
      dialHost: "",
      dialPort: 0,
      volume: 80,
      muted: false,
    };
    const group: GroupMirrorMsg = {
      name: "c1",
      volume: 100,
      muted: false,
      current: { songId: "s1", title: "t", durationMs: 1000 },
    };
    const record: PairRecordMirrorMsg = { clientId: "c1", createdAt: 1, lastUsedAt: null, approved: true };
    const snap: SendspinSnapshot = { clients: [client], groups: [group], records: [record], attempts: [] };

    expect(Object.keys(snap).sort()).toEqual(["attempts", "clients", "groups", "records"]);
    expect(Object.keys(client)).not.toContain("positionMs");
    expect(group.current?.songId).toBe("s1");
    expect(group.current).not.toHaveProperty("positionMs");

    // 信封只做类型层约定,运行时仍是扁平对象(给 child/主进程直接用)。
    const env: SendspinStateEnvelope = { t: "state", ...snap };
    expect(env.t).toBe("state");
    expect(env.clients).toHaveLength(1);
  });

  it("就绪信息与热更新配置形状固定", () => {
    const ready: SendspinReadyInfo = { serverId: "srv-1", port: 8928 };
    const cfg: SendspinIpcConfig = { port: 8928, allowLegacyClients: true, preferredCodec: "flac", autoDiscover: false };
    expect(ready.port).toBe(8928);
    expect(cfg.preferredCodec).toBe("flac");
    // 6053 的密钥/端口属于「每台设备各自」,绝不能出现在全局热更新配置里。
    expect(Object.keys(cfg).sort()).toEqual(["allowLegacyClients", "autoDiscover", "port", "preferredCodec"]);
  });

  it("事件与主→子附加消息是判别联合(t 字段唯一)", () => {
    const evts: SendspinChildEvent[] = [
      { t: "activated", clientId: "c1", name: "n", legacy: false },
      { t: "closed", clientId: "c1" },
      { t: "playFailed", clientId: "c1", songId: "s1", message: "boom" },
    ];
    const host: SendspinHostExtra[] = [
      { t: "init", port: 8928 },
      { t: "cfg", cfg: { port: 1, allowLegacyClients: false, preferredCodec: "pcm", autoDiscover: true } },
    ];
    expect(evts.map((e) => e.t)).toEqual(["activated", "closed", "playFailed"]);
    expect(host.map((h) => h.t)).toEqual(["init", "cfg"]);

    // 类型别名能同时收下两侧(信封层交叉)—— 编译期即可验证。
    const toChild: ParentToSendspinChild = { t: "init" };
    const toParent: SendspinChildToParent = { t: "closed", clientId: "c1" } as SendspinChildToParent;
    expect(toChild.t).toBe("init");
    expect(toParent.t).toBe("closed");
  });
});
