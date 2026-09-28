// services/dlna/control.ts —— 残余分支:「某一层坏了」时的降级契约。
//
// 已有 controlSoap / controlRecast / deviceKnown 覆盖的是**主干**,这里补的是主干
// 之外的每一处早退与容错。它们的共同特征是:在真机上**偶发**(一次 SOAP 抖动、
// 一台设备的 (a) 接口没实现),一旦写坏就是「歌莫名停了 / 播放器列表空了 / 位置归 0」。
//
// 手法与 controlRecast 一致:discovery 喂桩设备、eventing 换成可控的假 EventManager、
// 所有 SOAP 收口到一个 stub 化的全局 fetch 上。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import { setSetting } from "../../src/services/settings.js";

// ---------------------------------------------------------------------------
// eventing:把 GENA 订阅状态的掌控权交给用例 —— `shouldPollDevice` 的判定依赖它。
// ---------------------------------------------------------------------------
const EV = vi.hoisted(() => ({
  subscribed: true,
  reset() { this.subscribed = true; },
}));
vi.mock("../../src/services/dlna/eventing.js", () => ({
  getEventManager: () => ({
    setTransportState: () => {},
    setPosition: () => {},
    setVolume: () => {},
    setMuted: () => {},
    emit: () => {},
    emitDeviceListChanged: () => {},
    isSubscribed: () => EV.subscribed,
    subscribe: async () => {},
  }),
}));

vi.mock("../../src/services/airplay/control.js", () => ({
  stopAirPlaySessionsForHost: async () => {},
}));

let DISCOVERED: any[] = [];
vi.mock("../../src/services/dlna/discovery.js", () => ({
  discoverDlnaDevices: async () => DISCOVERED,
  fetchDeviceAtLocation: async () => null,
  lastScanWasErrored: () => false,
  onSsdpEvent: () => () => {},
  clearAliveEmit: () => {},
}));

import {
  castToDevice,
  seekDevice,
  alignDeviceToPosition,
  getDeviceStatus,
  getDeviceVolume,
  playDevice,
  pauseDevice,
  stopDevice,
  stopDevicePlayback,
  waitUntilStopped,
  playUriOnDevice,
  enqueueNextTrack,
  shouldPollDevice,
  isDeviceAvailable,
  refreshDevices,
  createDlnaProtocolPlayer,
  SeekSupersededError,
} from "../../src/services/dlna/control.js";

const OK_XML = `<?xml version="1.0"?><s:Envelope><s:Body><u:OK/></s:Body></s:Envelope>`;
const transportXml = (state: string) => OK_XML.replace("<u:OK/>",
  `<CurrentTransportState>${state}</CurrentTransportState>` +
  `<CurrentTransportActions>Play,Pause,Stop</CurrentTransportActions>`);
const posXml = (relTime: string, dur = "00:05:00") => OK_XML.replace("<u:OK/>",
  `<GetPositionInfoResponse><Track><RelTime>${relTime}</RelTime>` +
  `<TrackDuration>${dur}</TrackDuration><TrackURI>urn:mf:track</TrackURI></Track>` +
  `</GetPositionInfoResponse>`);

/** 造一条 SOAP 成功/报错 known:按 action 分发的桩全局 fetch。
 *  soap(action) -> { xml } | { fault } | { throw } */
type SoapOut = { xml?: string; fault?: string; throw?: unknown };
let soap: (action: string) => SoapOut = () => ({ xml: OK_XML });
let calls: string[] = [];

function installFetch(): void {
  vi.stubGlobal("fetch", async (_url: unknown, init: any) => {
    const action = String(init?.headers?.SOAPAction ?? "").replace(/^"|"$/g, "").split("#")[1] ?? "";
    calls.push(action);
    const out = soap(action);
    if (out.throw !== undefined) throw out.throw;
    if (out.fault !== undefined) {
      return { ok: true, status: 200, text: async () => out.fault } as any;
    }
    return { ok: true, status: 200, text: async () => out.xml ?? OK_XML } as any;
  });
}

/** 桩设备的 states:只有 transport state 与 position 可变,其余固定。 */
function dev(id: string) {
  return {
    id,
    name: "桩音箱",
    location: `http://192.168.10.30:49152/dev/${id}.xml`,
    avTransportUrl: `http://192.168.10.30:49152/ctl/AVTransport`,
    renderingControlUrl: `http://192.168.10.30:49152/ctl/RenderingControl`,
    available: true,
  };
}

// 设备 id 必须全局单调递增:用例是 shuffle 的,而 runtime / 基线都是模块级可变状态,
// id 复用会跨用例污染。
let seq = 0;
const nextId = () => `b7-d${++seq}`;

async function seed(): Promise<string> {
  const id = nextId();
  DISCOVERED = [dev(id)];
  await refreshDevices(10);
  DISCOVERED = [];
  return id;
}

const castOpts = (id: string, songId = "b7-song") => ({
  songId,
  title: "桩曲",
  deviceId: id,
  baseUrl: "http://192.168.10.230:46400",
  mime: "audio/flac",
});

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(() => {
  EV.reset();
  calls = [];
  soap = () => ({ xml: OK_XML });
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ===========================================================================
describe("soapCall:网络层与 UPnP 故障必须变成可识别的错误", () => {
  it("fetch 抛 Error → 原文带过去(便于定位是哪台设备 / 哪个 action)", async () => {
    const id = await seed();
    soap = () => ({ throw: new Error("connect ECONNREFUSED 192.168.10.30:49152") });
    await expect(getDeviceVolume(id)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("fetch 抛非 Error(字符串/自定义值)→ 回落成 network error,不把 undefined 顶上去", async () => {
    const id = await seed();
    soap = () => ({ throw: "socket hang up" });
    await expect(getDeviceVolume(id)).rejects.toThrow(/network error/);
  });

  it("UPnP fault 缺 errorCode/errorDescription → 仍给出可定位的文案", async () => {
    const id = await seed();
    const bare = `<?xml version="1.0"?><s:Envelope><s:Body>` +
      `<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring></s:Fault>` +
      `</s:Body></s:Envelope>`;
    soap = () => ({ fault: bare });
    await expect(getDeviceVolume(id)).rejects.toThrow(/UPnP error \?: fault/);
  });
});

// ===========================================================================
describe("castToDevice:投递链路上的故障必须是可容忍的", () => {
  it("Step 1 Stop 失败(otransport locked)不影响后面三步", async () => {
    const id = await seed();
    soap = (a) => {
      if (a === "Stop") return { fault: "<errorCode>705</errorCode><errorDescription>transport locked</errorDescription>" };
      if (a === "GetTransportInfo") return { xml: transportXml("STOPPED") };
      return { xml: OK_XML };
    };
    await expect(castToDevice(castOpts(id))).resolves.toMatchObject({ mediaUri: expect.any(String) });
    expect(calls).toContain("SetAVTransportURI");
    expect(calls).toContain("Play");
  });

  it("shouldAbort 在 Stop 之后生效 → 立刻抛 SeekSupersededError,不再发后续 SOAP", async () => {
    const id = await seed();
    let stopSent = false;
    soap = () => ({ xml: OK_XML });
    // Stop 一下发就把中止开关打开 —— 对应重投链路里「Stop 后用户又拖了一次」的现场。
    vi.stubGlobal("fetch", async (_url: unknown, init: any) => {
      const action = String(init?.headers?.SOAPAction ?? "").replace(/^"|"$/g, "").split("#")[1] ?? "";
      calls.push(action);
      if (action === "Stop") stopSent = true;
      return { ok: true, status: 200, text: async () => OK_XML } as any;
    });
    await expect(castToDevice({ ...castOpts(id), shouldAbort: () => stopSent }))
      .rejects.toBeInstanceOf(SeekSupersededError);
    expect(calls).toEqual(["Stop"]);
  });

  it("shouldAbort 在 SetAVTransportURI 之后生效 → Play 不得下发", async () => {
    const id = await seed();
    let uriSent = false;
    vi.stubGlobal("fetch", async (_url: unknown, init: any) => {
      const action = String(init?.headers?.SOAPAction ?? "").replace(/^"|"$/g, "").split("#")[1] ?? "";
      calls.push(action);
      if (action === "SetAVTransportURI") uriSent = true;
      if (action === "GetTransportInfo") {
        return { ok: true, status: 200, text: async () => transportXml("STOPPED") } as any;
      }
      return { ok: true, status: 200, text: async () => OK_XML } as any;
    });
    await expect(castToDevice({ ...castOpts(id), shouldAbort: () => uriSent }))
      .rejects.toBeInstanceOf(SeekSupersededError);
    expect(calls).toContain("SetAVTransportURI");
    expect(calls).not.toContain("Play");
  });
});

// ===========================================================================
describe("transport action 失败必须上报给调用方(并转入待轮询)", () => {
  it("Play 失败 → 抛错给调用方,并在已经 GENA 订阅的情况下转入轮询", async () => {
    const id = await seed();
    EV.subscribed = true;
    soap = () => ({ fault: "<errorCode>701</errorCode><errorDescription>transition</errorDescription>" });
    await expect(playDevice(id)).rejects.toThrow(/transition/);
    expect(isDeviceAvailable(id)).toBe(false);
    // 虽然 GENA 订阅还在,但 SOAP 已经失败过 ⇒ forcePoll 必须让它退回轮询
    expect(shouldPollDevice(id)).toBe(true);
  });

  it("Pause / Stop 失败同样抛错并标记失败", async () => {
    const id = await seed();
    soap = () => ({ fault: "<errorCode>701</errorCode><errorDescription>transition</errorDescription>" });
    await expect(pauseDevice(id)).rejects.toThrow(/transition/);
    await expect(stopDevice(id)).rejects.toThrow(/transition/);
    expect(isDeviceAvailable(id)).toBe(false);
  });
});

// ===========================================================================
describe("shouldPollDevice:什么时候必须靠轮询补", () => {
  it("未知设备 → 乐观轮询 true", () => {
    expect(shouldPollDevice("never-seen-" + nextId())).toBe(true);
  });

  it("GENA 已订阅且未失败 → 不需要轮询", async () => {
    const id = await seed();
    EV.subscribed = true;
    await playDevice(id); // 成功 ⇒ markOk
    expect(shouldPollDevice(id)).toBe(false);
  });

  it("设备存在但没有 GENA 订阅 → 必须轮询", async () => {
    const id = await seed();
    EV.subscribed = false;
    await playDevice(id);
    expect(shouldPollDevice(id)).toBe(true);
  });
});

// ===========================================================================
describe("未知设备的守卫:不抛、不死等、不误报", () => {
  it("设备不在缓存:四条路径按各自的约定表现", async () => {
    const ghost = "ghost-" + nextId();
    await expect(playUriOnDevice(ghost, "http://x/y.mp3")).rejects.toThrow("设备未找到或不可用");
    // 这两个是“尽量让设备安静”的路径 —— 设备不在就不该消耗任何等待时间
    await expect(waitUntilStopped(ghost, 10)).resolves.toBeUndefined();
    await expect(stopDevicePlayback(ghost)).resolves.toBeUndefined();
    expect(await enqueueNextTrack(castOpts(ghost))).toBe(false);
  });
});

// ===========================================================================
describe("getDeviceStatus:采样降级(读不到就不读,不许污染其它读数)", () => {
  it("GetVolume 响应缺当前音量 / 直接失败 → volume 归 0,其余读数照报", async () => {
    const id = await seed();
    soap = (a) => {
      if (a === "GetTransportInfo") return { xml: transportXml("PLAYING") };
      if (a === "GetPositionInfo") return { xml: posXml("00:01:30") };
      if (a === "GetVolume") return { xml: OK_XML };            // 缺 CurrentVolume
      if (a === "GetMute") return { throw: new Error("GetMute not implemented") };
      return { xml: OK_XML };
    };
    const st = await getDeviceStatus(id);
    expect(st.state).toBe("PLAYING");
    expect(st.position).toBeCloseTo(90, 1);
    expect(st.volume).toBe(0);      // 读不到就按 0,不得因此整状态码失败
    expect(st.muted).toBe(false);
  });

  it("RelTime/TrackDuration 是垃圾值 → 位置与时长归 0,不把 undefined 冒出去", async () => {
    const id = await seed();
    soap = (a) => {
      if (a === "GetTransportInfo") return { xml: transportXml("PLAYING") };
      if (a === "GetPositionInfo") return { xml: posXml("junk-timing", "not-a-time") };
      return { xml: OK_XML };
    };
    const st = await getDeviceStatus(id);
    expect(st.position).toBe(0);
    expect(st.duration).toBe(0);
  });
});

// ===========================================================================
describe("createDlnaProtocolPlayer.pollState:传输态映射", () => {
  it("PLAYING / PAUSED_PLAYBACK / TRANSITIONING / STOPPED 各归其位", async () => {
    const id = await seed();
    const player = createDlnaProtocolPlayer(id);
    for (const [upnp, expected] of [
      ["PLAYING", "PLAYING"],
      ["PAUSED_PLAYBACK", "PAUSED"],
      ["TRANSITIONING", "BUFFERING"],
      ["STOPPED", "IDLE"],
      ["NO_MEDIA_PRESENT", "IDLE"],
    ] as const) {
      soap = (a) => {
        if (a === "GetTransportInfo") return { xml: transportXml(upnp) };
        return { xml: OK_XML };
      };
      const st = await player.pollState();
      expect(st.playbackState as string).toBe(expected);
      // 设备在发现缓存里 ⇒ 不许打 unavailable 标记(否则 queue 会被当成失踪)
      expect(st.unavailable).toBeUndefined();
    }
  });
});

// ===========================================================================
describe("alignDeviceToPosition:校准期间设备抖动不能放弃", () => {
  it("seek 持续失败 → 重试到上限后返回最后读数,不把错误抛给调用方", async () => {
    const id = await seed();
    soap = (a) => {
      if (a === "GetTransportInfo") return { xml: transportXml("PLAYING") };
      if (a === "Seek") return { fault: "<errorCode>701</errorCode><errorDescription>transition</errorDescription>" };
      return { xml: OK_XML };
    };
    const pos = await alignDeviceToPosition(id, 120, {
      tries: 3, intervalMs: 1, settleTries: 1, settleIntervalMs: 1,
    });
    expect(pos).toBe(0);
    expect(calls.filter((c) => c === "Seek").length).toBe(3);
  });
});

// ===========================================================================
describe("seekDevice:重投失败必须退回 SOAP Seek 而不是把错误抛给用户", () => {
  it("已被判定 SOAP Seek 无效的设备,重投流失败 → 回退 SOAP Seek 且调用方不感知", async () => {
    const id = await seed();
    // 先有一次正常投屏,给重投留下 lastCastOptions。
    await castToDevice(castOpts(id));
    // 直接落持久化判定:重启后首次 seek 就会走重投分支(跳过两次学习过程)。
    setSetting(`dlna.seek.unreliable.${id}`, "1");

    calls = [];
    soap = (a) => {
      if (a === "GetTransportInfo") return { xml: transportXml("PLAYING") };
      // 让重投的 SetAVTransportURI 失败 ⇒ reseekByRecast 抛错,由 seekDevice 兜住
      if (a === "SetAVTransportURI") return { fault: "<errorCode>715</errorCode><errorDescription>illegal mime</errorDescription>" };
      return { xml: OK_XML };
    };
    await expect(seekDevice(id, 45)).resolves.toBeUndefined();
    // 兜住的证据:最终仍然下发了 SOAP Seek,而不是把 UPnP 错误抛给调用方。
    expect(calls).toContain("Seek");
  });
});
