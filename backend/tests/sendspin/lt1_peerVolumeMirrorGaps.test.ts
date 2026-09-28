// peerVolume.ts 覆盖率补口:fork 模式下的**实时音量镜像**读取与异常收口。
//
// 缺口背景:getSendspinDeviceVolume 的实时取值有两条来源 —— in-proc 读真实 server
// 的组、fork 读 supervisor 的**状态镜像**(主进程里没有真实 server)。既有测试只覆盖
// in-proc 与「服务未跑」两条,镜像这条(生产 fork 时**唯一**路径)与 try/catch 收口全黑。
//
// 守住的产品契约:
//   1) fork 下主进程必须能从 supervisor.mirror.groups 读到实时组音量(否则用户改音量
//      后回显恒为库值,前端显示"没生效");
//   2) 镜像里没有该组(设备还没起播/刚断开)→ 视为离线,回退持久库值 —— 不能编造 100;
//   3) 读实时值**任何异常都不能外抛**:这是播控/回显热路径,抛一次就打断整个 peer 列表。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  server: undefined as unknown,
  serverThrows: false,
  running: false,
  mirrorGroups: new Map<string, unknown>(),
}));

vi.mock("../../src/services/sendspin/runtime.js", () => ({
  getServer: () => {
    if (H.serverThrows) throw new Error("runtime boom");
    return H.server;
  },
  setServer: () => {},
}));

vi.mock("../../src/services/sendspin/supervisor.js", () => ({
  sendspinSupervisor: {
    isRunning: () => H.running,
    get mirror() {
      return { groups: H.mirrorGroups };
    },
  },
}));

import { getSendspinDeviceVolume, attachSendspinPeerVolumes } from "../../src/services/sendspin/peerVolume.js";
import { initDatabase, sqlite } from "../../src/db/index.js";

const CID = "lt1-peer-vol-mirror";

beforeEach(() => {
  initDatabase();
  H.server = undefined;
  H.serverThrows = false;
  H.running = false;
  H.mirrorGroups = new Map<string, unknown>();
  sqlite.prepare("DELETE FROM sendspin_device_state WHERE client_id = ?").run(CID);
});

describe("peerVolume:fork 镜像实时取值", () => {
  it("supervisor 运行中且镜像有组 → 取实时组音量/静音,online=true", () => {
    H.running = true;
    H.mirrorGroups.set(CID, { volume: 42, muted: true });
    // 契约:fork 主进程唯一能拿到的实时值就来自镜像 —— 读不到就永远显示离线。
    expect(getSendspinDeviceVolume(CID)).toEqual({ volume: 42, muted: true, online: true });
  });

  it("镜像音量越界 → 钳到 0..100(前端音量条不得溢出)", () => {
    H.running = true;
    H.mirrorGroups.set(CID, { volume: 250, muted: false });
    expect(getSendspinDeviceVolume(CID)).toEqual({ volume: 100, muted: false, online: true });
  });

  it("supervisor 运行中但镜像没有该组 → 视为离线,回退缺省(不编造在线)", () => {
    H.running = true;
    // 镜像为空:设备还没起播 → 不是「在线 100」,而是「离线,按缺省回显」。
    expect(getSendspinDeviceVolume(CID)).toEqual({ volume: 100, muted: false, online: false });
  });

  it("镜像组存在但 volume 不是数字 → 不当作实时值,回退库/缺省", () => {
    H.running = true;
    H.mirrorGroups.set(CID, { muted: true }); // 只有 muted,没有权威 volume
    expect(getSendspinDeviceVolume(CID)).toEqual({ volume: 100, muted: false, online: false });
  });

  it("读实时值抛异常(运行时故障)→ 吞掉并回退,绝不冒泡到回显热路径", () => {
    H.running = true;
    H.serverThrows = true;
    // 契约:best-effort —— 异常时必须仍返回一个可用快照,而不是让 /v1/peers 整表 500。
    expect(getSendspinDeviceVolume(CID)).toEqual({ volume: 100, muted: false, online: false });
  });

  it("in-proc 有真实 server 且组存在 → 取组音量(主进程默认路径)", () => {
    // 契约:in-proc 是生产默认路径,优先于 fork 镜像;组存在即视为在线实时值。
    H.server = { groups: new Map([[CID, { volume: 30, muted: false }]]) } as unknown;
    expect(getSendspinDeviceVolume(CID)).toEqual({ volume: 30, muted: false, online: true });
  });

  it("supervisor 未运行且无 server → 离线(不因镜像 Map 有数据就越权当在线)", () => {
    H.running = false;
    H.mirrorGroups.set(CID, { volume: 77, muted: false });
    // 契约:isRunning() 是镜像可信度的门禁;子进程没跑时镜像必是陈旧残留,必须忽略。
    expect(getSendspinDeviceVolume(CID)).toEqual({ volume: 100, muted: false, online: false });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// attachSendspinPeerVolumes:peer 列表音量补全(decoratePeersForClient 唯一出口调用)。
// 全函数此前全黑 —— 却是 /v1/peers 与 WS peer_snapshot 里 sendspin 行音量的**唯一**来源,
// 写错会让"其它 kind 的行"被塞进伪造字段(前端据此误渲染)或整表拿不到 volume。
describe("peerVolume:attachSendspinPeerVolumes 语义", () => {
  it("空列表/非数组 → 原样返回(同一引用,不新建)", () => {
    const empty: Array<{ peerId: string; kind?: string }> = [];
    // 契约:热路径零拷贝 —— 空列表不该产生新对象(每帧快照都会调到)。
    expect(attachSendspinPeerVolumes(empty)).toBe(empty);
  });

  it("混合列表:仅 sendspin 行补 volume/muted,其它 kind 行保持原引用", () => {
    H.running = true;
    H.mirrorGroups.set("dev-a", { volume: 66, muted: true });
    const other = { peerId: "airplay:x", kind: "airplay" };
    const ss = { peerId: "sendspin:dev-a", kind: "sendspin" };
    const out = attachSendspinPeerVolumes([other, ss]);
    // sendspin 行被补上实时音量/静音
    expect(out[1]).toEqual({ peerId: "sendspin:dev-a", kind: "sendspin", volume: 66, muted: true });
    // 契约:非 sendspin 行必须**原样**(同一引用)—— 否则会给对端类型注入多余字段。
    expect(out[0]).toBe(other);
  });

  it("sendspin 行但 peerId 缺 `sendspin:` 前缀 → 视为无 clientId,不补(原样)", () => {
    H.running = true;
    H.mirrorGroups.set("dev-b", { volume: 5, muted: false });
    const row = { peerId: "bare-id", kind: "sendspin" };
    // 契约:clientId 只能从 "sendspin:" 前缀后取;格式不符时不得拿整串当 id 去查(会误配)。
    const out = attachSendspinPeerVolumes([row]);
    expect(out[0]).toBe(row);
    expect((out[0] as { volume?: number }).volume).toBeUndefined();
  });

  it("全是非 sendspin 行 → 未触及任何行,返回原数组引用(不新建)", () => {
    const rows = [
      { peerId: "airplay:a", kind: "airplay" },
      { peerId: "sonos:b", kind: "sonos" },
    ];
    // 契约:touched=false 时返回入参本身,避免无谓的整表拷贝。
    expect(attachSendspinPeerVolumes(rows)).toBe(rows);
  });
});
