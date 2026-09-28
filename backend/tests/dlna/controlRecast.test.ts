// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import { initDatabase, sqlite } from "../../src/db/index.js";
import { getSetting, setSetting } from "../../src/services/settings.js";
import {
  castToDevice,
  playDevice,
  stopDevice,
  waitUntilStopped,
  seekDevice,
  refreshDevices,
  getDeviceStatus,
  setDeviceAlias,
  loadPersistedDevices,
  getCachedDevices,
  enqueueNextTrack,
  createDlnaProtocolPlayer,
  getEffectiveBaseUrl,
  setDeviceDisabled,
} from "../../src/services/dlna/control.js";
import type { QueueItem } from "../../src/services/player/types.js";

// ---------------------------------------------------------------------------
// 双协议互斥:castToDevice 会动态 import airplay/control 去停同 host 的 RAOP
// 会话。`AP.boom` 让这一下抛错,验证「停不掉也不能拖累投屏」这条容错契约。
// ---------------------------------------------------------------------------
const AP = vi.hoisted(() => ({ boom: false, hosts: [] as string[] }));
vi.mock("../../src/services/airplay/control.js", () => ({
  stopAirPlaySessionsForHost: vi.fn(async (host: string) => {
    if (AP.boom) throw new Error("airplay channel down");
    AP.hosts.push(host);
  }),
}));

// ---------------------------------------------------------------------------
// eventing:钉「控制动作必须同步落进事件缓存」这条契约,并能读到 emit 的 payload
// (重投完成后推的是 reason=seek_recast,HA 侧靠它刷新播放控件)。
// ---------------------------------------------------------------------------
const EV = vi.hoisted(() => ({
  position: [] as number[],
  emits: [] as { name: string; payload: any }[],
  transport: [] as string[],
  reset() {
    this.position = [];
    this.emits = [];
    this.transport = [];
  },
}));
vi.mock("../../src/services/dlna/eventing.js", () => ({
  getEventManager: () => ({
    setTransportState: (_id: string, s: string) => EV.transport.push(s),
    setPosition: (_id: string, p: number) => EV.position.push(p),
    setVolume: () => {},
    setMuted: () => {},
    emit: (name: string, ...rest: any[]) => EV.emits.push({ name, payload: rest }),
    emitDeviceListChanged: () => {},
    isSubscribed: () => true,
    subscribe: async () => {},
  }),
}));

// ---------------------------------------------------------------------------
// discovery:直接喂 discovery 结果,得到带 control URL 的设备(不牵连真 SSDP)。
// ---------------------------------------------------------------------------
let DISCOVERED: any[] = [];
vi.mock("../../src/services/dlna/discovery.js", () => ({
  discoverDlnaDevices: async () => DISCOVERED,
  fetchDeviceAtLocation: async () => null,
  lastScanWasErrored: () => false,
  onSsdpEvent: () => () => {},
  clearAliveEmit: () => {},
}));

// ---------------------------------------------------------------------------
// SOAP:整条控制链最终收口到 soapCall → 全局 fetch。桩按 SOAPAction 分发。
//   soap(action) -> { xml } | { fault }
//   gets(url)    -> 非 SOAP 的 GET(description / SCPD)
// `slow` 里的 action 会卡在一个由测试控制的闸门上,用来制造「重投进行到一半」
// 的局面。
// ---------------------------------------------------------------------------
const OK_XML = `<?xml version="1.0"?><s:Envelope><s:Body><u:OK/></s:Body></s:Envelope>`;
const NO_REPORT_POS = `<?xml version="1.0"?><s:Envelope><s:Body>` +
  `<GetPositionInfoResponse><Track><RelTime>00:00:00</RelTime>` +
  `<TrackDuration>00:05:00</TrackDuration><TrackURI>urn:mf:track</TrackURI></Track>` +
  `</GetPositionInfoResponse></s:Body></s:Envelope>`;
const TRANSITIONING_XML = `<?xml version="1.0"?><s:Envelope><s:Body><CurrentTransportState>TRANSITIONING` +
  `</CurrentTransportState><CurrentTransportActions>Play</CurrentTransportActions></s:Body></s:Envelope>`;

/** 造一条带当前传输态与位置的 GetPositionInfo 响应。 */
function withPosOnly(relTime: string, transportState: string): string {
  return OK_XML.replace("<u:OK/>",
    `<GetPositionInfoResponse><Track><RelTime>${relTime}</RelTime>` +
    `<TrackDuration>00:05:00</TrackDuration><TrackURI>urn:mf:track</TrackURI></Track>` +
    `</GetPositionInfoResponse><CurrentTransportState>${transportState}</CurrentTransportState>`);
}
const transportXml = (state: string) => OK_XML.replace("<u:OK/>",
  `<CurrentTransportState>${state}</CurrentTransportState>` +
  `<CurrentTransportActions>Play,Pause,Stop</CurrentTransportActions>`);

/** GetTransportInfo 报传输态、GetPositionInfo 报位置(两者是不同调用,别混在一个响应里)。 */
function transportAndPos(transportState: string, relTime: string) {
  soap = (a) => {
    if (a === "GetTransportInfo") return { xml: transportXml(transportState) };
    if (a === "GetPositionInfo") return { xml: withPosOnly(relTime, transportState) };
    return { xml: OK_XML };
  };
}

type SoapOut = { xml?: string; fault?: string };
let soap: (action: string, body?: string) => SoapOut = () => ({ xml: OK_XML });
let gets: ((url: string) => string | null)[] = [];
let calls: { action: string; url: string; body: string }[] = [];
/** 需要人为拖慢的 SOAP action(毫秒),用来制造「某一步进行到一半」的局面。 */
let slow: Record<string, number> = {};
let throwOnGet = false;

function resp(xml: string): any {
  return { ok: true, status: 200, text: async () => xml } as any;
}

function installFetch() {
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    const u = String(url);
    const headers = init?.headers ?? {};
    const action = String(headers.SOAPAction ?? "").replace(/^"|"$/g, "").split("#")[1];
    if (action) {
      calls.push({ action, url: u, body: init?.body ?? "" });
      if (slow[action]) await new Promise<void>((r) => setTimeout(r, slow[action]));
      const out = soap(action, init?.body ?? "");
      if (out.fault !== undefined) throw new Error(`soap fault ${out.fault}`);
      return resp(out.xml ?? OK_XML);
    }
    if (throwOnGet) throw new Error("description unreachable");
    for (const g of gets) {
      const r = g(u);
      if (r !== null) return resp(r);
    }
    return resp("");
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

// 设备 id 必须全局单调递增:用例顺序是 shuffle 的,而 runtime / 基线 / 重投代际
// 这些都是模块级可变状态,一旦 id 复用就会跨用例污染。
let seq = 0;
const nextId = () => `b33-d${++seq}`;
const actions = () => calls.map((c) => c.action);
const last = <T,>(arr: T[]): T => arr[arr.length - 1];

/** 一次「重建流」的四个关键动作,顺序不可换:
 *  Stop 清空队列 → SetAVTransportURI 换源 → GetTransportInfo 等可播放 → Play 起播。 */
const RECAST_STEPS = ["Stop", "SetAVTransportURI", "GetTransportInfo", "Play"];
/** 只留这四个动作、按相对先后比较。
 *  落位校验是 sleep(1200) 后异步派出的协程(`void verifySeekLanding`),它读到的
 *  GetPositionInfo 有可能插在这四步中间 —— 那是**前一条 seek 留下的异步尾巴**,不是
 *  本次重投的步骤。断言要钉的是这四步的先后,不能让它把用例变成偶发红。 */
const recastSteps = () => actions().filter((a) => RECAST_STEPS.includes(a));

/** 落位校验是 `void verifySeekLanding(...)` 派出的异步协程,前面 sleep(1200)。
 *  要断言它的行为就必须真等过这 1.2s —— 否则断言跑在协程之前,等于什么都没测。 */
const settle = (ms = 1500) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  EV.reset();
  calls = [];
  AP.boom = false;
  AP.hosts = [];
  soap = () => ({ xml: OK_XML });
  gets = [];
  slow = {};
  throwOnGet = false;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 造一台设备进缓存:走 discovery → 缓存 → 落库,得到带 control URL 的 device。 */
async function seed(id?: string): Promise<string> {
  const did = id ?? nextId();
  DISCOVERED = [dev(did)];
  await refreshDevices(10);
  DISCOVERED = [];
  return did;
}

const castOpts = (id: string, songId = "s-1"): any => ({
  songId,
  title: "桩曲",
  deviceId: id,
  baseUrl: "http://192.168.10.230:46400",
  mime: "audio/flac",
});

// ===========================================================================
describe("seek 不可靠的学习过程:两次不报位置 → 判定 SOAP Seek 无效", () => {
  // 这是整条「重投流重建」能力的入口。设备固件属性(播实时转码流恒回 RelTime=0)
  // 是学出来的,不是猜出来的:前两次 seek 只能靠落位校验观察,第三次才开始改走重投。
  it("前两次 seek 仍走 SOAP(未判定前不得提前降级)", async () => {
    const id = await seed();
    soap = (a) => (a === "GetPositionInfo" ? { xml: NO_REPORT_POS } : { xml: OK_XML });

    await seekDevice(id, 30);
    await settle();
    // 第一次只观察到 1 次不报位置,计数不够,不该提前降级。
    expect(actions()[0]).toBe("Seek");

    await seekDevice(id, 60);
    await settle();
    // 第二次补上第 2 次观察 → 在落位校验协程里判定,本次 seek 本身仍是 SOAP。
    expect(actions()[0]).toBe("Seek");
    expect(getSetting(`dlna.seek.unreliable.${id}`)).toBe("1");
  });

  it("连续两次不报位置 → 判定无效并落库,后续 seek 改走重投流", async () => {
    const id = await seed();
    // 重投需要「有投屏上下文」(lastCastOptions),这是 castToDevice 留下的 ——
    // 也就是说:用户必须先播一首歌,之后拖动才会走重投,而不是一进服就重投。
    await castToDevice(castOpts(id));
    soap = (a) => (a === "GetPositionInfo" ? { xml: NO_REPORT_POS } : { xml: OK_XML });

    await seekDevice(id, 30);
    await settle();
    await seekDevice(id, 60);
    await settle();
    // 判定已在第 2 次观察后落定(rt.unreliableSeek = true + setSetting 落库)。
    expect(getSetting(`dlna.seek.unreliable.${id}`)).toBe("1");

    // 关键契约:第 3 次 seek 不再发 SOAP Seek,而是用 timeOffset 重建整条流。
    calls = [];
    await seekDevice(id, 170);
    expect(recastSteps()).toEqual(["Stop", "SetAVTransportURI", "GetTransportInfo", "Play"]);
    const uriCall = calls.find((c) => c.action === "SetAVTransportURI")!;
    expect(uriCall.body).toContain("timeOffset=170");
  });

  it("内存里的判定优先于落库:持久化的那条被重置后,内存标记仍生效", async () => {
    // isSeekUnreliable 是「内存标记 → 落库」两级判定,内存命中就不再查库(见 288-298)。
    // 只测「库里有、内存没有」抓不到这条契约:那条分支命中与不命中结果一样(都 true)。
    // 真正的分歧点在**内存为真、库里为假** —— 也就是运维把持久化判定重置掉之后,
    // 该设备仍应当记得自己「学过了」,否则每清一次库就得重新学两遍拖动。
    const id = await seed();
    await castToDevice(castOpts(id));
    soap = (a) => (a === "GetPositionInfo" ? { xml: NO_REPORT_POS } : { xml: OK_XML });

    // 真实地学一遍:两次不报位置 → 判定落库 + 回填内存。
    await seekDevice(id, 30);
    await settle();
    await seekDevice(id, 60);
    await settle();
    expect(getSetting(`dlna.seek.unreliable.${id}`)).toBe("1");

    // 把落库那条判定重置成 0(与「清掉持久化状态」同一个动作)。
    setSetting(`dlna.seek.unreliable.${id}`, "0");
    expect(getSetting(`dlna.seek.unreliable.${id}`)).toBe("0");

    calls = [];
    await seekDevice(id, 170);
    // 内存标记还在 → 仍然直接重投,不去重试那条注定无效的 SOAP Seek。
    expect(recastSteps()).toEqual(["Stop", "SetAVTransportURI", "GetTransportInfo", "Play"]);
    expect(calls.find((c) => c.action === "SetAVTransportURI")!.body).toContain("timeOffset=170");
  });

  it("已落库判定过的设备(重启后回填内存)首次 seek 就直接重投,不再重试 SOAP", async () => {
    // 第 293-295 行:getSetting ⇒ "1" ⇒ 回填 rt.unreliableSeek。没有这一步,容器
    // 重启后头两三次拖动又会被 SOAP 静默吞掉(每次都要重新学习一遍)。
    const id = nextId();
    setSetting(`dlna.seek.unreliable.${id}`, "1");
    await seed(id);
    await castToDevice(castOpts(id));

    calls = [];
    await seekDevice(id, 42);
    expect(actions()).not.toContain("Seek");
    expect(recastSteps()).toEqual(["Stop", "SetAVTransportURI", "GetTransportInfo", "Play"]);
  });
});

// ===========================================================================
describe("reseekByRecast:重投流重建的契约", () => {
  /** 走到「已判定 seek 不可靠 + 有投屏上下文」的状态。 */
  async function armed(): Promise<string> {
    const id = nextId();
    setSetting(`dlna.seek.unreliable.${id}`, "1");
    await seed(id);
    await castToDevice(castOpts(id));
    return id;
  }

  it("重投的流地址必须带上 timeOffset(设备从新起点拉新流,而不是跳一下)", async () => {
    const id = await armed();
    calls = [];
    await seekDevice(id, 91);
    const uriCall = calls.find((c) => c.action === "SetAVTransportURI")!;
    expect(uriCall.body).toContain("timeOffset=91");
    // 顺序不可换:Stop 清空队列 → SetURI 换源 → 等可播放 → Play 起播。
    expect(recastSteps()).toEqual(["Stop", "SetAVTransportURI", "GetTransportInfo", "Play"]);
  });

  it("重投自己开的落位保护窗,在 castToDevice 返回后依然存活(不再被误删)", async () => {
    // 修复 Dxx-1 后的契约:control.ts:1141 重投开窗 → 1143 调 castToDevice。
    // 修复前 castToDevice 尾段无条件 `seekGuards.delete`(本意"换歌清掉上一首的窗"),
    // 把重投这场不换歌(timeOffset 有值)的窗也一起删了 → getDeviceStatus 读不到窗,
    // 240 实锤「170s 重投后 STOPPED 样本删掉锚点 → 进度从头重爬」。修复后(timeOffset
    // 有值不删窗)窗在 castToDevice 返回后仍存活,设备回的旧读数 5s 被按预期值回填成 ≥87。
    const id = await armed();
    await seekDevice(id, 88);
    // 重投刚落地,设备此刻报的还是「跳之前的位置」5s。
    soap = (a) => (a === "GetPositionInfo" ? { xml: withPosOnly("00:00:05", "PLAYING") } : { xml: OK_XML });
    const s = await getDeviceStatus(id);
    expect(s.position).toBeGreaterThanOrEqual(87);
    expect(s.position).toBeLessThan(88 + 6);
  });

  it("重投失败回退时,护栏已经开着:设备那次陈旧读数不得顶掉基线", async () => {
    // 这条用例是**变异反证逼出来的**:把 control.ts:1141 的 `seekGuards.set` 删掉,
    // 原本 22 条用例一条都抓不到 —— 因为正常路径上紧接着的 castToDevice 会无条件
    // `seekGuards.delete`(见 914),窗开等于没开。
    // 要让这行可观测,必须让 castToDevice **在 914 之前**就退出。设备已被禁用时
    // castToDevice 在 813 直接抛 —— 窗保留下来,于是「重投失败回退」这一步就有了
    // 可断言的护栏现场。
    const id = await armed();
    setDeviceDisabled(id, true);
    // 回退的那发 SOAP Seek 也失败:否则 seekDevice 会重新开窗,把差异抹平。
    soap = (a) => (a === "Seek" ? { fault: "500" } : { xml: OK_XML });

    await expect(seekDevice(id, 88)).rejects.toThrow();
    // 此刻设备报的仍是「跳之前的位置」5s,且仍在 PLAYING。
    soap = (a) => (a === "GetTransportInfo" ? { xml: transportXml("PLAYING") }
      : a === "GetPositionInfo" ? { xml: withPosOnly("00:00:05", "PLAYING") } : { xml: OK_XML });

    const s = await getDeviceStatus(id);
    // 护栏在 → 陈旧读数 5s 被丢弃,回填成「目标 88 + 窗内已过时间」。
    expect(s.position).toBeGreaterThanOrEqual(88);
    expect(s.position).toBeLessThan(88 + 6);
  });

  it("重投成功后位置基线改锚到目标,并推 reason=seek_recast 刷新", async () => {
    const id = await armed();
    calls = [];
    EV.position = [];
    EV.emits = [];
    await seekDevice(id, 120);
    expect(EV.position).toContain(120);
    // castToDevice 自己会先推一次 reason=play_started,收尾那次才是 seek_recast。
    const refreshes = EV.emits.filter((e) => e.name === "player_refresh");
    expect(last(refreshes).payload?.[1]).toEqual({ reason: "seek_recast" });
  });

  it("settle 窗内被更新的 seek 取代 → 旧的一次直接放弃,只跑一次重投", async () => {
    // 连续拖动会背靠背产生重投,小设备 HTTP 栈扛不住。旧重投在 settle 窗醒来后
    // 发现代际已变就自己退出,最终只留下最新那一次的结果。
    const id = await armed();
    const p1 = seekDevice(id, 10);
    await new Promise<void>((r) => setTimeout(r, 120)); // 落进 settle 窗(400ms)
    calls = [];
    const p2 = seekDevice(id, 20);
    await Promise.all([p1, p2]);

    const recasts = calls.filter((c) => c.action === "SetAVTransportURI");
    expect(recasts.length).toBe(1);
    expect(recasts[0].body).toContain("timeOffset=20");
  });

  it("重投抛错 → 回退到 SOAP Seek,不把错误抛给调用方", async () => {
    // 重投是"尽力而为"的增强:设备偶发失联时不该让用户拖不动进度,退回 SOAP 至少
    // 基线还是改锚了(即使设备没真跳)。
    const id = await armed();
    soap = (a) => (a === "Play" ? { fault: "500" } : { xml: OK_XML });
    calls = [];
    await expect(seekDevice(id, 33)).resolves.toBeUndefined();
    const seekIdx = actions().lastIndexOf("Seek");
    const playIdx = actions().indexOf("Play");
    expect(seekIdx).toBeGreaterThan(playIdx);
  });

  it("重投风暴串行化:旧重投跑完后让位(1131),最终只最新目标落锚(1145 安全网保留)", async () => {
    // 纠正缺陷台账误判:Dxx-2 原把 control.ts:1145-1147 标成死代码,重读确认**可达**。
    // castToDevice 内部在 849/861/867 行有 `shouldAbort()` 检查点,当后续重投推进代际
    // (recastGens 变大)时,旧重投会在 castToDevice 内抛 `SeekSupersededError`,
    // 被 1145 的 catch 接住优雅退出 —— 删掉它反而在那种时序下把错误抛给调用方
    // (seekDevice 报错)。本用例守串行化正面效果:同设备重投排队,旧重投跑完自己
    // 让位(1131 处 recastAborted 为 true),两次重投都完整跑、无中途 abort。
    const id = await armed();
    // 把第一次重投的 Play 拖慢 600ms,制造「重投进行到一半」的现场。
    slow.Play = 600;
    const p = seekDevice(id, 77);
    await new Promise<void>((r) => setTimeout(r, 250));
    // 第二次 seek 到达:它排在第一次后面,连第一步 Stop 都还没发出。
    const p2 = seekDevice(id, 99);
    await new Promise<void>((r) => setTimeout(r, 250));
    expect(actions().filter((a) => a === "Stop").length).toBe(1);
    await settle(2200);
    await Promise.all([p, p2]);
    // 串行化的正面效果:两次重投都完整跑完,没有一次被中途 abort 掉。
    expect(actions().filter((a) => a === "Play").length).toBe(2);
    expect(actions().filter((a) => a === "Stop").length).toBe(2);
  });
});

// ===========================================================================
describe("castToDevice:容错分支", () => {
  it("停同 host AirPlay 会话失败 → 只告警,投屏继续(音频输入互斥不能拖垮 DLNA)", async () => {
    const id = await seed();
    AP.boom = true;
    calls = [];
    await castToDevice(castOpts(id));
    expect(recastSteps()).toEqual(["Stop", "SetAVTransportURI", "GetTransportInfo", "Play"]);
  });

  it("waitForCanPlay 等不到可播放态 → 10s 超时后仍然继续 Play(尽力和)", async () => {
    const id = await seed();
    soap = (a) => (a === "GetTransportInfo" ? { xml: TRANSITIONING_XML } : { xml: OK_XML });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const p = castToDevice(castOpts(id));
    await vi.advanceTimersByTimeAsync(10_600);
    await expect(p).resolves.toBeTruthy();
    expect(actions()).toContain("Play");
  });

  it("playDevice:失败必须 markFailed 后抛出(否则离线设备会被继续轮询)", async () => {
    const id = await seed();
    soap = (a) => (a === "Play" ? { fault: "500" } : { xml: OK_XML });
    await expect(playDevice(id)).rejects.toThrow();
    expect(EV.transport).not.toContain("PLAYING");
  });

  it("stopDevice:失败必须 markFailed 后抛出", async () => {
    const id = await seed();
    soap = (a) => (a === "Stop" ? { fault: "500" } : { xml: OK_XML });
    await expect(stopDevice(id)).rejects.toThrow();
    expect(EV.transport).not.toContain("STOPPED");
  });
});

// ===========================================================================
describe("enqueueNextTrack:SCPD 探测失败", () => {
  it("description.xml 拉不到 → 判定不支持预载,不发 SetNextAVTransportURI", async () => {
    // 探测失败和设备明确不支持是同一处置(返回 false),绝不在这时硬发 SOAP ——
    // 那只会撞上设备的 401,把一次「不支持」放大成一次错误日志和一次失败污点。
    const id = await seed();
    throwOnGet = true;
    expect(await enqueueNextTrack(castOpts(id))).toBe(false);
    expect(actions()).not.toContain("SetNextAVTransportURI");
  });
});

// ===========================================================================
describe("getDeviceStatus:暂停冻结位置基线", () => {
  it("暂停后设备回 0 → 冻结基线,进度不得回退到 0", async () => {
    const id = await seed();
    soap = (a) => (a === "GetPositionInfo" ? { xml: NO_REPORT_POS } : { xml: OK_XML });
    await castToDevice(castOpts(id));

    // 起播后设备报了真实位置 → 建立正基线(90s)。
    transportAndPos("PLAYING", "00:01:30");
    const playing = await getDeviceStatus(id);
    expect(playing.state).toBe("PLAYING");
    expect(playing.position).toBeGreaterThan(0);

    // 暂停:设备回 0(PAUSED 态常如此),必须冻结而不是采纳 0。
    transportAndPos("PAUSED_PLAYBACK", "00:00:00");
    await playDevice(id);
    const paused1 = await getDeviceStatus(id);
    expect(paused1.state).toBe("PAUSED_PLAYBACK");
    expect(paused1.position).toBeGreaterThan(0);

    // 暂停持续中:继续回 0,仍须回读出冻结值(不能退回基线的原点)。
    const paused2 = await getDeviceStatus(id);
    expect(paused2.position).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe("getDeviceStatus:恢复播放后的位置重算", () => {
  it("暂停冻结后再恢复(设备仍回 0)→ 从冻结读数起算,不得继续从 0 爬", async () => {
    const id = await seed();
    soap = (a) => (a === "GetPositionInfo" ? { xml: NO_REPORT_POS } : { xml: OK_XML });
    await castToDevice(castOpts(id));

    // 起播报真实位置 → 基线 90s。
    transportAndPos("PLAYING", "00:01:30");
    expect((await getDeviceStatus(id)).position).toBeGreaterThan(0);

    // 暂停 → 冻结。
    transportAndPos("PAUSED_PLAYBACK", "00:00:00");
    const frozen = await getDeviceStatus(id);
    expect(frozen.position).toBeGreaterThan(0);

    // 恢复播放,但设备此刻还没爬起来(仍回 0)→ 必须沿用冻结读数**原值**。
    // 这里必须比**精确相等**:用 `frozen + 2` 这种容差会同时放过两条变异 ——
    //   ① 冻结分支不写 pausedAt(M07):恢复后走外推,加进的是暂停后的那点墙钟;
    //   ② 「暂停后恢复重算」分支被关掉(M14):恢复后从 base.at(=冻结那一刻)起算,
    //      同样会多爬一段。只有精确相等能把「暂停时长不许算进进度」钉死。
    transportAndPos("PLAYING", "00:00:00");
    const resumed = await getDeviceStatus(id);
    expect(resumed.position).toBeGreaterThan(0);
    expect(resumed.position).toBe(frozen.position);
  });
});

// ===========================================================================
describe("落位校验:异常必须被吞掉", () => {
  it("重发 seek 抛错 → 校验协程自己收场,不影响调用方已经返回的结果", async () => {
    // verifySeekLanding 整个包在 try 里:它是 `void` 派出的,任何冒泡都会变成
    // 无人接收的 unhandled rejection,把整条控制链的进程日志搞脏。
    // 「没冒泡」不能只看它自己没报错 —— 必须**直接守在 unhandledRejection 上**:
    // catch 里改成 `throw e` 时,校验函数照样正常跑完,只有这层监听能看见。
    const rejects: any[] = [];
    const onReject = (e: any) => rejects.push(e);
    process.on("unhandledRejection", onReject);
    const id = await seed();
    let seeks = 0;
    soap = (a) => {
      if (a === "Seek") {
        seeks++;
        // 落位校验的重发必须失败(设备此时开始抽风),验证「异常到此为止」。
        return seeks === 1 ? { xml: OK_XML } : { fault: "401" };
      }
      if (a === "GetPositionInfo") return { xml: withPosOnly("00:10:00", "PLAYING") };
      return { xml: OK_XML };
    };
    try {
      await seekDevice(id, 30);
      await settle();
      // 校验发现「目标 30s 但设备报 600s」→ 重发一次;重发又抛 → 到此为止。
      expect(seeks).toBe(2);
      expect(rejects).toEqual([]);
    } finally {
      process.off("unhandledRejection", onReject);
    }
  });
});

// ===========================================================================
describe("waitUntilStopped:等设备自己停下", () => {
  it("设备先报 PLAYING 再报 STOPPED → 轮询到 STOPPED 才返回", async () => {
    const id = await seed();
    let probes = 0;
    soap = (a) => {
      if (a === "GetTransportInfo") {
        probes++;
        return { xml: transportXml(probes === 1 ? "PLAYING" : "STOPPED") };
      }
      return { xml: OK_XML };
    };
    // 5s 预算:1500ms 缓冲 + 一轮 1000ms 轮询(970 行)+ 再一轮读到 STOPPED。
    const t0 = Date.now();
    await waitUntilStopped(id, 5000);
    const elapsed = Date.now() - t0;
    expect(probes).toBe(2);
    // 光数 probe 次数杀不掉「轮询不让步」:把 1000ms 间隔改成 0 也照样探 2 次就
    // 读到 STOPPED。这里把**墙钟**钉住 —— 两次探测之间必须真的退让,否则就是用
    // 忙轮询去吊设备(每次 GetTransportInfo 都是一次真实往返)。
    expect(elapsed).toBeGreaterThanOrEqual(2400);
  });
});

// ===========================================================================
describe("设备记录:库里有、缓存里没有", () => {
  it("setDeviceAlias 对仅存于 DB 的设备:写库成功且返回重建后的设备(不再 undefined→404)", () => {
    // 修复 Dxx-3 后的契约:DB-only 设备写库后从 DB 读回构造 DlnaDevice 返回,
    // 调用方(api/dlna.ts)不再拿到 undefined 误判 404。缓存命中路径不受影响
    // (`dev ?? readDlnaDeviceRow` 在缓存命中时短路,无额外 DB 读)。
    const id = nextId();
    sqlite.prepare("INSERT INTO dlna_devices (id, name) VALUES (?, ?)")
      .run(id, "只在库里的设备");
    const dev = setDeviceAlias(id, "新名字");
    expect(dev).toBeDefined();
    expect(dev!.id).toBe(id);
    expect(dev!.alias).toBe("新名字");
    expect(dev!.name).toBe("只在库里的设备");
    const row: any = sqlite.prepare("SELECT alias FROM dlna_devices WHERE id = ?").get(id);
    expect(row.alias).toBe("新名字");
  });

  it("setDeviceDisabled 对仅存于 DB 的设备同样返回重建后的设备(同形缺陷)", () => {
    // setDeviceDisabled 与 setDeviceAlias 同形:DB-only 设备原先返回 undefined。
    // 修复后改成 `dev ?? readDlnaDeviceRow`,离线/禁用后仅留记录的设备也能返回。
    const id = nextId();
    sqlite.prepare("INSERT INTO dlna_devices (id, name) VALUES (?, ?)")
      .run(id, "仅库里的禁用设备");
    const dev = setDeviceDisabled(id, true);
    expect(dev).toBeDefined();
    expect(dev!.id).toBe(id);
    expect(dev!.disabled).toBe(true);
  });

  it("loadPersistedDevices:DB 里有缓存里没有的记录 → 以离线形态补进缓存", () => {
    const id = nextId();
    sqlite.prepare("INSERT INTO dlna_devices (id, name, alias, disabled) VALUES (?, ?, ?, ?)")
      .run(id, "持久化设备", "库里的别名", 1);
    loadPersistedDevices();
    const d = getCachedDevices().find((x) => x.id === id);
    expect(d).toBeDefined();
    expect(d!.alias).toBe("库里的别名");
    expect(d!.available).toBe(false);
    expect(d!.disabled).toBe(true);
  });
});

// ===========================================================================
describe("拉流地址:无 HTTP 上下文时自动探测", () => {
  it("DLNA_BASE_URL 未设置且无历史记录 → 探测本机可路由的 LAN 地址", () => {
    const saved = process.env.DLNA_BASE_URL;
    delete process.env.DLNA_BASE_URL;
    const spy = vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
      eth0: [{ address: "192.168.10.55", family: "IPv4", internal: false }],
    } as any);
    try {
      // docker0 命中 unroutable 前缀必须被跳过,取 eth0。
      expect(getEffectiveBaseUrl()).toBe("http://192.168.10.55:46400");
    } finally {
      spy.mockRestore();
      if (saved !== undefined) process.env.DLNA_BASE_URL = saved;
    }
  });
});

// ===========================================================================
describe("createDlnaProtocolPlayer:UniversalPlayer 绑定", () => {
  it("playMedia 走的是同一条投屏链路(返回设备真正拉到的 mediaUri)", async () => {
    const id = await seed();
    const player = createDlnaProtocolPlayer(id);
    const item: QueueItem = { songId: "s-p1", title: "协议曲", mime: "audio/flac" } as any;
    const out = await player.playMedia!(item, "http://192.168.10.230:46400");
    expect(out.mediaUri).toContain("/rest/dlna/stream/");
    expect(last(actions())).toBe("Play");
  });
});

// ===========================================================================
describe("verifySeekLanding:GetPositionInfo 异常路径(覆盖 readRawPosition 1228-1230)", () => {
  it("落位校验时 GetPositionInfo 抛错 → readRawPosition 吞异常返回 null,不冒泡", async () => {
    // 1228-1230 是 readRawPosition 的 catch:设备在校验读位置那一刻抽风
    // (GetPositionInfo 网络错)必须当成"无从校验"返回 null,不能把异常甩给
    // verifySeekLanding 的 `void` 协程(否则变成 unhandled rejection 污染进程日志)。
    const id = await seed();
    await castToDevice(castOpts(id));
    let threw = false;
    soap = (a) => {
      if (a === "Seek") return { xml: OK_XML };
      if (a === "GetPositionInfo") { threw = true; throw new Error("device dropped"); }
      return { xml: OK_XML };
    };
    // 未判定不可靠 → 走 SOAP Seek → 派发 verifySeekLanding(异步,先 sleep 1200ms)。
    await expect(seekDevice(id, 30)).resolves.toBeUndefined();
    // 等校验协程跑到 readRawPosition(1200ms 之后)。
    await new Promise<void>((r) => setTimeout(r, 1500));
    expect(threw).toBe(true);
    // 异常被吞:没有 unhandled rejection,设备仍可被正常查询。
    soap = (a) => (a === "GetPositionInfo" ? { xml: withPosOnly("00:00:10", "PLAYING") } : { xml: OK_XML });
    expect((await getDeviceStatus(id)).state).toBeDefined();
  });
});
