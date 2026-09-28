// control.ts 里两条「位置真相」契约的回归测试:
//   ① alignDeviceToPosition —— 一次性校准 seek(新成员加入对齐 / 离线恢复续播)。
//   ② getDeviceStatus 里的 seek 保护窗 —— 丢弃拖动前的陈旧读数、重投间隙不清基线。
//
// 这两块是最容易被"顺手改坏"的地方:它们不抛错、只改数字,一旦退化的表现是
// 「进度条跳几秒 / 切歌提前 / 重新播同一首歌」,没有日志级的报错,只能靠契约钉住。
//
// 与 controlSoap.test.ts 同一套脚手架:discovery 出题、soap → 全局 fetch 收口,
// 中间的全部逻辑(缓存、基线、保护窗、外推)都跑 control.ts 的真实代码路径。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import {
  refreshDevices,
  getDeviceStatus,
  seekDevice,
  alignDeviceToPosition,
} from "../../src/services/dlna/control.js";

// ---------------------------------------------------------------------------
// discovery:控制链路的前提是「缓存里得有一台带 control URL 的设备」。真 SSDP
// 要组播 socket,这里直接喂 discovery 的结果,之后的缓存写入 / 落库 / SOAP 全
// 部仍是 control.ts 自己的代码路径。
// ---------------------------------------------------------------------------
let DISCOVERED: any[] = [];
vi.mock("../../src/services/dlna/discovery.js", () => ({
  discoverDlnaDevices: async () => DISCOVERED,
  fetchDeviceAtLocation: async () => null,
  lastScanWasErrored: () => false,
  onSsdpEvent: () => () => {},
  clearAliveEmit: () => {},
}));

// 事件缓存 + 广播:只记下写入值,不牵连真实 EventManager。
const EV = vi.hoisted(() => ({ positions: [] as number[], emits: [] as any[] }));
vi.mock("../../src/services/dlna/eventing.js", () => ({
  getEventManager: () => ({
    setTransportState: () => {},
    setVolume: () => {},
    setPosition: (_id: string, p: number) => EV.positions.push(p),
    setMuted: () => {},
    emitDeviceListChanged: () => {},
    emit: (_ev: string, _id: string, p: any) => EV.emits.push(p),
    subscribe: (_id: string, cb: Function) => { void cb; return () => {}; },
    isSubscribed: () => false,
    subscriberCount: () => 0,
  }),
}));

// ---------------------------------------------------------------------------
// SOAP:control.ts 里对设备的每一次调用最终都收口到 soapCall → 全局 fetch。
//   soap(action) -> { xml } | { fault }
// ---------------------------------------------------------------------------
type SoapOut = { xml?: string; fault?: string };
let soap: (action: string) => SoapOut = () => ({ xml: OK_XML });
let calls: { action: string; url: string; body: string }[] = [];

const OK_XML = `<?xml version="1.0"?><s:Envelope><s:Body><u:OK/></s:Body></s:Envelope>`;

const xml = (body: string) =>
  `<?xml version="1.0"?><s:Envelope><s:Body>${body}</s:Body></s:Envelope>`;
/** GetTransportInfo 的响应体。 */
const transportXml = (state: string) =>
  xml(`<CurrentTransportState>${state}</CurrentTransportState>` +
      `<CurrentTransportActions>Play,Pause,Stop</CurrentTransportActions>`);
/** GetPositionInfo 的响应体。 */
const posXml = (relTime: string, trackDuration?: string) =>
  xml(`<RelTime>${relTime}</RelTime>` +
      (trackDuration ? `<TrackDuration>${trackDuration}</TrackDuration>` : "") +
      `<TrackURI>http://192.168.10.30:49152/track.mp3</TrackURI>`);

function resp(any_: any): any { return any_; }

function installFetch() {
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    const action = String(init?.headers?.SOAPAction ?? "")
      .replace(/^"|"$/g, "").split("#")[1];
    if (action) {
      calls.push({ action, url: String(url), body: init?.body ?? "" });
      const out = soap(action);
      if (out.fault !== undefined) throw new Error(`soap fault ${out.fault}`);
      return resp({ ok: true, status: 200, text: async () => out.xml ?? OK_XML });
    }
    return resp({ ok: true, status: 200, text: async () => "" });
  });
}

function dev(id: string) {
  return {
    id,
    name: "桩音箱",
    manufacturer: "MUZO",
    model: "H5MKII",
    location: `http://192.168.10.30:49152/dev/${id}.xml`,
    avTransportUrl: `http://192.168.10.30:49152/ctl/AVTransport`,
    renderingControlUrl: `http://192.168.10.30:49152/ctl/RenderingControl`,
    available: true,
  };
}

// ⚠️ 设备 id 必须全局单调递增:用例顺序是 shuffle 的,而 positionEstimates /
// seekGuards 都是「按 deviceId 存」的模块级 Map —— id 一旦复用,上一个用例的
// 基线/保护窗会直接漏进下一个用例(本文件初版就是这么红的)。
let seq = 0;
const nextId = () => `b32-a${++seq}-${Date.now().toString(36)}`;

/** 造一台设备进缓存:走 discovery → 缓存 → 落库,得到带 control URL 的 device。 */
async function seed(): Promise<string> {
  const did = nextId();
  DISCOVERED = [dev(did)];
  await refreshDevices(10);
  DISCOVERED = [];
  return did;
}

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  EV.positions = [];
  EV.emits = [];
  calls = [];
  soap = () => ({ xml: OK_XML });
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 「正在播放」的桩。
 *
 * ⚠️ 默认让设备**不报位置**(`RelTime=NOT_IMPLEMENTED`,MUZO 播转码 chunked 流时
 * 的真实表现):`seekDevice` 会派生 `verifySeekLanding`(sleep 1200ms),设备不报
 * 位置时它自行放弃 —— 否则它那条「落位不符就重发一次 seek」会跨用例落进下一个
 * 用例的 `calls`,让 seek 计数随 shuffle 顺序漂移(本文件初版就是这么红的)。
 * 副作用正好也是优点:此时的收敛完全走外推,与真机上这条路径一致。 */
function stubPlaying(relTime = "NOT_IMPLEMENTED", trackDuration?: string) {
  soap = (a: string) => {
    if (a === "GetTransportInfo") return { xml: transportXml("PLAYING") };
    if (a === "GetPositionInfo") return { xml: posXml(relTime, trackDuration) };
    return { xml: OK_XML };
  };
}

const seeks = () => calls.filter((c) => c.action === "Seek");

// ===========================================================================
describe("alignDeviceToPosition:一次性校准 seek", () => {
  it("设备还没进 PLAYING 时不发 seek;进了立刻校准(稳定性等待不是无限等)", async () => {
    // 现实:SetAVTransportURI/Play 后立刻 Seek 会被静默丢弃(HiVi 实锤),
    // 所以必须先等设备进入"正在播放且位置在动"的稳定态。
    const id = await seed();
    let transport = "STOPPED";
    soap = (a: string) => {
      if (a === "GetTransportInfo") return { xml: transportXml(transport) };
      if (a === "GetPositionInfo") return { xml: posXml("00:00:00") };
      return { xml: OK_XML };
    };

    const p = alignDeviceToPosition(id, 60, { settleTries: 2, settleIntervalMs: 50, tries: 1 });
    await new Promise((r) => setTimeout(r, 60)); // settle 窗 2×50ms,此刻还没走完
    expect(seeks()).toHaveLength(0); // 没进稳定态就绝不能 seek

    transport = "PLAYING";
    await p;
    expect(seeks()).toHaveLength(1);
  });

  it("已经稳定 PLAYING → 一次都不用等 settle,直接开校", async () => {
    const id = await seed();
    stubPlaying(); // 不报位置 → 只能靠外推收敛
    const out = await alignDeviceToPosition(id, 60, {
      settleTries: 2, settleIntervalMs: 20, tries: 3, intervalMs: 5,
    });
    expect(out).toBeGreaterThanOrEqual(58); // 收敛到目标附近
    expect(seeks()).toHaveLength(1);
  });

  it("落位在容差内 → 只发一次 seek(不让设备反复重跳)", async () => {
    // 容差默认 3s。读数落在容差内 = 一次收敛,多打的一枪只会让进度抖动。
    const id = await seed();
    stubPlaying();
    await alignDeviceToPosition(id, 60, { tries: 5, settleTries: 0, intervalMs: 5 });
    expect(seeks()).toHaveLength(1);
  });

  it("leader 实时位置优先于固定目标(getTargetSec 覆盖 targetSec)", async () => {
    // 场景:对齐时 leader 还在播,settle 等待期间它继续前进 —— 用固定目标会
    // 校准到一个已经过期的位置,成员一进场就落后几秒。
    const id = await seed();
    stubPlaying();
    await alignDeviceToPosition(id, 9999, { tries: 1, settleTries: 0, intervalMs: 5, getTargetSec: async () => 30 });
    const body = seeks()[0].body;
    expect(body).toContain("00:00:30"); // 用的是实时目标,不是 9999s
    expect(body).not.toContain("02:46:39");
  });

  it("settle 窗耗尽(设备始终不进 PLAYING)→ 仍尽力校准一次", async () => {
    // 这是"尽力而为":宁可试一次,也不因为设备迟迟不上报而彻底放弃对齐。
    const id = await seed();
    soap = (a: string) => {
      if (a === "GetTransportInfo") return { xml: transportXml("STOPPED") };
      if (a === "GetPositionInfo") return { xml: posXml("00:00:00") };
      return { xml: OK_XML };
    };
    await alignDeviceToPosition(id, 60, { tries: 1, settleTries: 3, settleIntervalMs: 2 });
    expect(seeks()).toHaveLength(1);
  });

  it("seek 连续失败 → 重试满次数后返回最后读数,绝不抛出", async () => {
    // 校准是"顺带"的增强,不能因为设备抽风就把续播/入对齐整个搞挂。
    const id = await seed();
    stubPlaying();
    // ⚠️ 必须先把基础桩捕获到本地:写成 `soap(a)` 会回指刚赋值的这个 lambda,
    // 非 Seek 的动作就会无限自递归(本文件初版就是这么把自己套死的)。
    const base = soap;
    soap = (a: string) => (a === "Seek" ? { fault: "401" } : base(a));
    const out = await alignDeviceToPosition(id, 60, { tries: 3, settleTries: 0, intervalMs: 1 });
    expect(seeks()).toHaveLength(3);
    expect(out).toBe(0);
  });

  it("中途一次 seek 抛错 → 后续轮继续,最终正常收敛", async () => {
    const id = await seed();
    stubPlaying();
    let first = true;
    const base = soap; // 同上:别回指自己
    soap = (a: string) => {
      if (a === "Seek" && first) { first = false; return { fault: "401" }; }
      return base(a);
    };
    const out = await alignDeviceToPosition(id, 60, { tries: 3, settleTries: 0, intervalMs: 5 });
    expect(seeks()).toHaveLength(2);
    expect(out).toBeGreaterThanOrEqual(58);
  });
});

// ===========================================================================
// seek 保护窗:getDeviceStatus 采样时,把"拖动前的陈旧读数"换成应当处于的位置。
// 这四个用例共用「seekDevice → getDeviceStatus」这条真链路,因为保护窗正是由
// seekDevice 打开的 —— 单独构造 guard 反而测不到真实时序。
// ===========================================================================
const BASE = new Date("2026-09-28T12:00:00.000Z").getTime();

describe("getDeviceStatus:seek 保护窗", () => {
  it("保护窗内的 STOPPED 不得清基线:保留基线并回填预期位置", async () => {
    // 240 实锤:170s 重投间隙的 STOPPED 样本把 170 锚点删掉,紧接着 PLAYING
    // rawPos=0 只能就地播种 0 → 进度/歌词从头重爬(声音其实已到 170s)。
    // 这里把同一个坑钉在 SOAP seek 路径上:STOPPED 样本落在窗内 → 位置仍是 100s。
    const id = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE);
    stubPlaying("00:00:00");
    await seekDevice(id, 100, { verify: false });

    vi.setSystemTime(BASE + 1000);
    soap = (a: string) =>
      a === "GetTransportInfo" ? { xml: transportXml("STOPPED") }
      : a === "GetPositionInfo" ? { xml: posXml("00:00:00") }
      : { xml: OK_XML };
    const s1 = await getDeviceStatus(id);
    expect(Math.round(s1.position)).toBe(100);

    // 紧接着恢复播放:基线还在 → 外推从 100s 起算,绝不回零。
    vi.setSystemTime(BASE + 2000);
    soap = (a: string) =>
      a === "GetTransportInfo" ? { xml: transportXml("PLAYING") }
      : a === "GetPositionInfo" ? { xml: posXml("00:00:00") }
      : { xml: OK_XML };
    const s2 = await getDeviceStatus(id);
    expect(s2.position).toBeGreaterThanOrEqual(100);
  });

  it("保护窗过期后 STOPPED 视为真停 → 清基线、回到设备读数", async () => {
    // 与上一条互补:窗内是"重投间隙",窗外就必须是"真的停了",否则暂停/切歌
    // 后基线永远赖着不走,下一首会从上一首的位置接着算。
    const id = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE);
    stubPlaying("00:00:00");
    await seekDevice(id, 100, { verify: false });

    vi.setSystemTime(BASE + 12000); // 远超 SEEK_GUARD_MS(6s)
    soap = (a: string) =>
      a === "GetTransportInfo" ? { xml: transportXml("STOPPED") }
      : a === "GetPositionInfo" ? { xml: posXml("00:00:00") }
      : { xml: OK_XML };
    const s3 = await getDeviceStatus(id);
    expect(Math.round(s3.position)).toBe(0);
  });

  it("保护窗内 PLAYING 读到陈旧读数 → 用预期值回填,不被时长封顶压回", async () => {
    // 设备读的是 seek 之前的旧位置(拖动样本)。若直接采信,进度会先跳回再爬。
    // 同时这条断言还钉住"封顶顺序":没有保护窗回填时,外推值会被 100s 曲长
    // 压回 100s,结果同样是 100s —— 两条路径必须能区分开。
    const id = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE);
    stubPlaying("00:01:00", "00:01:40"); // 先采一次,记下 dur=100s 的基线
    await getDeviceStatus(id);
    await seekDevice(id, 100, { verify: false }); // 基线改锚到 100s,dur 沿用 100s

    vi.setSystemTime(BASE + 3000); // 窗内(距 seek < 6s)
    stubPlaying("00:00:10", "00:01:40"); // 设备却回报 10s 的旧读数
    const s4 = await getDeviceStatus(id);
    expect(Math.round(s4.position)).toBe(103); // 丢弃 10s,回填 100s + 3s
    expect(s4.position).toBeGreaterThan(100); // 且没被 100s 封顶压回
  });

  it("保护窗过期后 → 正常采纳设备读数", async () => {
    // 兜底:窗一过就必须恢复"设备说什么就是什么",否则真实进度永远追不上。
    const id = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE);
    stubPlaying("00:00:00");
    await seekDevice(id, 100, { verify: false });

    vi.setSystemTime(BASE + 30000); // 窗早已过
    stubPlaying("00:00:45");
    const s5 = await getDeviceStatus(id);
    expect(Math.round(s5.position)).toBe(45);
  });
});
