// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import {
  castToDevice,
  playUriOnDevice,
  waitUntilStopped,
  stopDevicePlayback,
  enqueueNextTrack,
  notifyTrackChanged,
  playDevice,
  pauseDevice,
  stopDevice,
  seekDevice,
  setDeviceVolume,
  getDeviceVolume,
  setDeviceMute,
  getDeviceStatus,
  getCurrentMedia,
  isDeviceAvailable,
  shouldPollDevice,
  refreshDevices,
  deleteDeviceRecord,
  setDeviceDisabled,
  SeekSupersededError,
} from "../../src/services/dlna/control.js";

// ---------------------------------------------------------------------------
// 双协议互斥:castToDevice 会动态 import airplay/control 去停同 host 的 RAOP
// 会话。测试里不牵连真实 RAOP/ffmpeg,只桩掉这个调用并记录它是否被触发。
// ---------------------------------------------------------------------------
const AP = vi.hoisted(() => ({ stopHosts: [] as string[] }));
vi.mock("../../src/services/airplay/control.js", () => ({
  stopAirPlaySessionsForHost: vi.fn(async (host: string) => {
    AP.stopHosts.push(host);
  }),
}));

// ---------------------------------------------------------------------------
// eventing:钉死「控制动作必须同步写进事件缓存并推 WS」这条契约。桩掉真
// EventManager,断言就能直接落在 setTransportState / setVolume / setPosition /
// setMuted 的写入值上 —— 这正是 HA 侧「免等轮询」所依赖的写入面。
// ---------------------------------------------------------------------------
const EV = vi.hoisted(() => ({
  transport: [] as string[],
  volume: [] as any[],
  position: [] as number[],
  muted: [] as any[],
  emits: [] as string[],
  subscribed: 0,
  isSubscribed: false,
  reset() {
    this.transport = [];
    this.volume = [];
    this.position = [];
    this.muted = [];
    this.emits = [];
    this.subscribed = 0;
    this.isSubscribed = false;
  },
}));
vi.mock("../../src/services/dlna/eventing.js", () => ({
  getEventManager: () => ({
    setTransportState: (_id: string, s: string) => EV.transport.push(s),
    setVolume: (_id: string, v: number) => EV.volume.push(v),
    setPosition: (_id: string, p: number) => EV.position.push(p),
    setMuted: (_id: string, m: boolean) => EV.muted.push(m),
    emit: (name: string) => EV.emits.push(name),
    emitDeviceListChanged: () => {},
    isSubscribed: () => EV.isSubscribed,
    subscribe: async () => {
      EV.subscribed++;
    },
  }),
}));

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

// ---------------------------------------------------------------------------
// SOAP:control.ts 里对设备的每一次调用最终都收口到 soapCall → 全局 fetch。
// 用一个「按 SOAPAction 分发」的桩替换 fetch,不碰真网络就能跑通整条控制链路,
// 并断言每一下发的动作名与参数。
//   soap(action) -> { xml } | { fault } | { throw }
//   gets(url)    -> 非 SOAP 的 GET(description/SCPD) 由这组按 URL 分发
// ---------------------------------------------------------------------------
type SoapOut = { xml?: string; fault?: string; throw?: string };
let soap: (action: string, body?: string) => SoapOut = () => ({ xml: OK_XML });
let gets: ((url: string) => string | null)[] = [];
let calls: { action: string; url: string; body: string }[] = [];

const OK_XML = `<?xml version="1.0"?><s:Envelope><s:Body><u:OK/></s:Body></s:Envelope>`;
const TRANSPORT_PLAYING = `<?xml version="1.0"?><s:Envelope><s:Body><CurrentTransportState>PLAYING</CurrentTransportState><CurrentTransportActions>Play,Pause,Stop</CurrentTransportActions></s:Body></s:Envelope>`;
const AV_DESC = `<?xml version="1.0"?><root><serviceList><service>` +
  `<serviceType>urn:schemas-upnp-org:serviceId:AVTransport 1</serviceType>` +
  `<SCPDURL>/dev/scpd.xml</SCPDURL></service></serviceList></root>`;

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
      const out = soap(action, init?.body ?? "");
      if (out.throw !== undefined) throw new Error(out.throw);
      if (out.fault !== undefined) throw new Error(`soap fault ${out.fault}`);
      return resp(out.xml ?? OK_XML);
    }
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

// 设备 id 必须全局单调递增:用例顺序是 shuffle 的,而「已禁用设备」这类用例会
// 把 disabled 落进 DB,一旦 id 复用,后面的用例一进场就被判「设备已禁用」。
let seq = 0;
const nextId = () => `b30-d${++seq}`;
const last = <T,>(arr: T[]): T => arr[arr.length - 1];
/** 落位校验是 `void verifySeekLanding(...)` 派出的异步协程,前面 sleep(1200)。
 *  要断言它的行为就必须真等过这 1.2s —— 否则断言跑在协程之前,等于什么都没测。 */
const settle = (ms = 1500) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

beforeEach(async () => {
  EV.reset();
  calls = [];
  AP.stopHosts = [];
  soap = () => ({ xml: OK_XML });
  gets = [];
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

/** 让某台设备不提供 RenderingControl(音量/静音的「不支持」分支)。 */
async function seedNoRendering(): Promise<string> {
  const did = nextId();
  DISCOVERED = [{ ...dev(did), renderingControlUrl: undefined }];
  await refreshDevices(10);
  DISCOVERED = [];
  return did;
}

const country = (s: string) => expect(s).toBeDefined();

// ===========================================================================
describe("castToDevice:四步链路", () => {
  it("Stop → SetAVTransportURI → waitForCanPlay → Play 顺序不可换", async () => {
    const id = await seed();
    await castToDevice({ songId: "s-1", title: "曲一", deviceId: id, baseUrl: "http://192.168.10.230:46400", mime: "audio/flac" });
    expect(calls.map((c) => c.action)).toEqual(["Stop", "SetAVTransportURI", "GetTransportInfo", "Play"]);
  });

  it("Step 1 的 Stop 失败必须被容忍(设备报 705 transport locked 是常态)", async () => {
    const id = await seed();
    soap = (a) => (a === "Stop" ? { fault: "705" } : { xml: OK_XML });
    await expect(castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" })).resolves.toBeTruthy();
    // 被容忍 ≠ 跳过第二步:SetAVTransportURI 仍然发得出去
    expect(calls.map((c) => c.action)).toContain("SetAVTransportURI");
  });

  it("SetAVTransportURI 失败 → 直接抛出,绝不继续 Play", async () => {
    const id = await seed();
    soap = (a) => (a === "SetAVTransportURI" ? { fault: "401" } : { xml: OK_XML });
    await expect(castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" })).rejects.toThrow();
    expect(calls.map((c) => c.action)).not.toContain("Play");
  });

  it("Play 是关键路径:失败必须抛出,不能假装投屏成功", async () => {
    const id = await seed();
    soap = (a) => (a === "Play" ? { fault: "500" } : { xml: OK_XML });
    await expect(castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" })).rejects.toThrow();
    expect(calls.length).toBe(4); // 前三步都走了,第四步失败
  });

  it("shouldAbort 在 Step 2 之后命中 → SeekSupersededError(拖动引发的重投由此中止)", async () => {
    const id = await seed();
    let n = 0;
    await expect(
      castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h", shouldAbort: () => ++n >= 2 }),
    ).rejects.toBeInstanceOf(SeekSupersededError);
    expect(calls.map((c) => c.action)).not.toContain("Play");
  });

  // shouldAbort 在 castToDevice 里被查三次(Step2 后 / Step3 后 / Step4 Play 前)。
  // 只测「第一次命中」是钉不住的:变异只改掉第一处时,第二三处照样抛错,测试照样绿。
  // 所以这里用「第 N 次调用才返回 true」的谓词,把三次检查逐一点名。
  it("shouldAbort 在第 2 次检查命中 → 必须在 Play 之前刹住(就绪闸门与 Play 都不许跑)", async () => {
    const id = await seed();
    let n = 0;
    await expect(
      castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h", shouldAbort: () => ++n === 2 }),
    ).rejects.toBeInstanceOf(SeekSupersededError);
    // 第 1 道检查(Step 1 后)放行 → Step 2 照发;第 2 道检查(Step 2 后)命中 → 收手
    expect(calls.map((c) => c.action)).toEqual(["Stop", "SetAVTransportURI"]);
    expect(calls.map((c) => c.action)).not.toContain("GetTransportInfo");
  });

  it("shouldAbort 在第 3 次检查命中 → 必须在 waitForCanPlay 之后、Play 之前刹住", async () => {
    const id = await seed();
    let n = 0;
    await expect(
      castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h", shouldAbort: () => ++n === 3 }),
    ).rejects.toBeInstanceOf(SeekSupersededError);
    expect(calls.map((c) => c.action)).toEqual(["Stop", "SetAVTransportURI", "GetTransportInfo"]);
    expect(calls.map((c) => c.action)).not.toContain("Play");
  });

  it("timeOffset>0 → 起播 URL 带 timeOffset(起播位置直接编码进流,而不是先播再 Seek)", async () => {
    const id = await seed();
    const { mediaUri } = await castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h", timeOffset: 61.4 });
    expect(mediaUri).toMatch(/timeOffset=61(&|$)/);
  });

  it("coverArt 会进 DIDL-Lite 元数据(否则前端封面丢失)", async () => {
    const id = await seed();
    await castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h", coverArt: "art-9" });
    expect(calls.find((c) => c.action === "SetAVTransportURI")!.body).toContain("getCoverArt");
    expect(calls.find((c) => c.action === "SetAVTransportURI")!.body).toContain("art-9");
  });

  it("标题里的 XML 特殊字符必须被转义(不转义设备解析 DIDL-Lite 会整条失败)", async () => {
    const id = await seed();
    await castToDevice({ songId: "s-1", title: `A&B<"c">'d`, artist: "张三", deviceId: id, baseUrl: "http://h" });
    const body = calls.find((c) => c.action === "SetAVTransportURI")!.body;
    country(body);
    expect(body).not.toMatch(/<title>A&B</); // & 必须变成 &amp;
    expect(body).toContain("&amp;");
  });

  it("起播必须记下 currentMedia(HA/前端靠它显示曲目,不必再回查设备)", async () => {
    const id = await seed();
    await castToDevice({ songId: "s-1", title: "曲一", deviceId: id, baseUrl: "http://h", artist: "甲", album: "专辑" });
    expect(getCurrentMedia(id)).toMatchObject({ songId: "s-1", title: "曲一", artist: "甲", album: "专辑" });
  });

  it("起播成功即 markOk:设备重新回到可用态(否则会被判离线)", async () => {
    const id = await seed();
    await castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" });
    expect(isDeviceAvailable(id)).toBe(true);
  });

  it("起播顺带拉起 GENA 订阅(best-effort,失败也要能退化为轮询)", async () => {
    const id = await seed();
    await castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" });
    expect(EV.subscribed).toBe(1);
  });

  it("已禁用设备直接拒绝投屏(防绕过:不只是 UI 不可见)", async () => {
    const id = await seed();
    setDeviceDisabled(id, true);
    await expect(castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" })).rejects.toThrow("设备已禁用");
  });

  it("未知设备 → 抛错而不是静默", async () => {
    await expect(castToDevice({ songId: "s-1", title: "t", deviceId: "b30-nope", baseUrl: "http://h" })).rejects.toThrow("设备未找到或不可用");
  });

  it("投屏前会停掉同 host 的 AirPlay 会话(双协议输入互斥,否则 DLNA 起播无声音)", async () => {
    const id = await seed();
    await castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" });
    expect(AP.stopHosts).toContain("192.168.10.30");
  });
});

// ===========================================================================
describe("waitForCanPlay:起播前的就绪闸门", () => {
  it("CurrentTransportActions 含 Play → 一次通过", async () => {
    const id = await seed();
    soap = (a) => (a === "GetTransportInfo" ? { xml: TRANSPORT_PLAYING } : { xml: OK_XML });
    await castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" });
    expect(calls.filter((c) => c.action === "GetTransportInfo")).toHaveLength(1);
  });

  it("设备漏报(actions 为空)→ 乐观放行,不能卡死", async () => {
    const id = await seed();
    soap = (a) =>
      a === "GetTransportInfo"
        ? { xml: `<?xml version="1.0"?><s:Body><CurrentTransportState>PLAYING</CurrentTransportState><CurrentTransportActions></CurrentTransportActions></s:Body>` }
        : { xml: OK_XML };
    await expect(castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" })).resolves.toBeTruthy();
  });

  it("TRANSITIONING → 必须轮询重试(凭一次读数就放行会让 Play 撞 transport locked)", async () => {
    const id = await seed();
    let n = 0;
    soap = (a) => {
      if (a !== "GetTransportInfo") return { xml: OK_XML };
      n++;
      return n <= 2
        ? { xml: `<?xml version="1.0"?><s:Body><CurrentTransportState>TRANSITIONING</CurrentTransportState><CurrentTransportActions>Play</CurrentTransportActions></s:Body>` }
        : { xml: TRANSPORT_PLAYING };
    };
    await castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" });
    expect(n).toBe(3); // 首次 + 两次重试
  });

  it("闸门自身报错 → 放行而不是让投屏整体失败(设备已下线也不该吞掉 Play)", async () => {
    const id = await seed();
    soap = (a) => (a === "GetTransportInfo" ? { fault: "timeout" } : { xml: OK_XML });
    await expect(castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" })).resolves.toBeTruthy();
    expect(calls.map((c) => c.action)).toContain("Play");
  });
});

// ===========================================================================
describe("enqueueNextTrack:无缝隙预载", () => {
  const SCPD_WITH = `<?xml version="1.0"?><scpd><actionList><action><name>SetNextAVTransportURI</name></action></actionList></scpd>`;
  const SCPD_WITHOUT = `<?xml version="1.0"?><scpd><actionList><action><name>Stop</name></action></actionList></scpd>`;

  function stubScpd(scpdXml: string) {
    soap = () => ({ xml: OK_XML });
    // description.xml(任意 /dev/* 路径)→ 报出 AVTransport 的 SCPDURL;
    // SCPD 正文只在被显式请求时才给,用来区分「拉过几次」。
    gets = [
      (u) => (u.includes("/dev/scpd.xml") ? scpdXml : null),
      (u) => (u.includes("/dev/") ? AV_DESC : null),
    ];
  }

  it("SCPD 声明了 SetNextAVTransportURI → 预载成功", async () => {
    const id = await seed();
    stubScpd(SCPD_WITH);
    await expect(enqueueNextTrack({ songId: "s-2", title: "曲二", deviceId: id, baseUrl: "http://h" })).resolves.toBe(true);
    expect(calls.map((c) => c.action)).toContain("SetNextAVTransportURI");
  });

  it("未按声明预载 → 返回 false(绝不硬发设备不支持的动作)", async () => {
    const id = await seed();
    stubScpd(SCPD_WITHOUT);
    await expect(enqueueNextTrack({ songId: "s-2", title: "曲二", deviceId: id, baseUrl: "http://h" })).resolves.toBe(false);
    expect(calls.map((c) => c.action)).not.toContain("SetNextAVTransportURI");
  });

  it("探测结果要缓存:第二次预载不再重复拉 SCPD", async () => {
    const id = await seed();
    stubScpd(SCPD_WITH);
    await enqueueNextTrack({ songId: "s-2", title: "a", deviceId: id, baseUrl: "http://h" });
    const n1 = calls.filter((c) => c.url.includes("scpd")).length;
    await enqueueNextTrack({ songId: "s-3", title: "b", deviceId: id, baseUrl: "http://h" });
    expect(calls.filter((c) => c.url.includes("scpd")).length).toBe(n1);
  });

  // 缓存判据是 `!== undefined` 而不是真值判断:支持与不支持两种结论都要缓存。
  // 只测「支持」那条会把 `&& supportsEnqueue` 这类退化变异放过去。
  it("探测结论为「不支持」同样要缓存:第二次不再重复拉 SCPD", async () => {
    const id = await seed();
    stubScpd(SCPD_WITHOUT);
    await expect(enqueueNextTrack({ songId: "s-2", title: "a", deviceId: id, baseUrl: "http://h" })).resolves.toBe(false);
    const n1 = calls.filter((c) => c.url.includes("scpd")).length;
    await expect(enqueueNextTrack({ songId: "s-3", title: "b", deviceId: id, baseUrl: "http://h" })).resolves.toBe(false);
    expect(calls.filter((c) => c.url.includes("scpd")).length).toBe(n1);
  });

  it("已经预载过 → 直接返回 true,不再第二次下发", async () => {
    const id = await seed();
    stubScpd(SCPD_WITH);
    await enqueueNextTrack({ songId: "s-2", title: "a", deviceId: id, baseUrl: "http://h" });
    const n = calls.length;
    await expect(enqueueNextTrack({ songId: "s-2", title: "a", deviceId: id, baseUrl: "http://h" })).resolves.toBe(true);
    expect(calls.length).toBe(n);
  });

  it("换首后必须重新预载(notifyTrackChanged 复位 nextEnqueued)", async () => {
    const id = await seed();
    stubScpd(SCPD_WITH);
    await enqueueNextTrack({ songId: "s-2", title: "a", deviceId: id, baseUrl: "http://h" });
    notifyTrackChanged(id);
    const n = calls.length;
    await enqueueNextTrack({ songId: "s-3", title: "b", deviceId: id, baseUrl: "http://h" });
    expect(calls.length).toBeGreaterThan(n);
  });

  it("下发被设备拒绝 → 记成不支持(不再重试),返回 false", async () => {
    const id = await seed();
    stubScpd(SCPD_WITH);
    soap = (a) => (a === "SetNextAVTransportURI" ? { fault: "401" } : { xml: OK_XML });
    await expect(enqueueNextTrack({ songId: "s-2", title: "a", deviceId: id, baseUrl: "http://h" })).resolves.toBe(false);
  });

  // 「记成不支持」必须真的关掉后续下发:否则设备每次被拒都会再撞一次,
  // 播完一首歌就要重试一轮。断言第二次调用不再发出 SetNextAVTransportURI。
  it("被拒之后必须彻底关闭预载:重复调用不再下发第二次", async () => {
    const id = await seed();
    stubScpd(SCPD_WITH);
    soap = (a) => (a === "SetNextAVTransportURI" ? { fault: "401" } : { xml: OK_XML });
    await expect(enqueueNextTrack({ songId: "s-2", title: "a", deviceId: id, baseUrl: "http://h" })).resolves.toBe(false);
    const n1 = calls.filter((c) => c.action === "SetNextAVTransportURI").length;
    await expect(enqueueNextTrack({ songId: "s-3", title: "b", deviceId: id, baseUrl: "http://h" })).resolves.toBe(false);
    expect(calls.filter((c) => c.action === "SetNextAVTransportURI").length).toBe(n1);
  });
});

// ===========================================================================
describe("playUriOnDevice / waitUntilStopped / stopDevicePlayback", () => {
  it("播报路径:Stop(容错) → SetAVTransportURI → 闸门口 → Play", async () => {
    const id = await seed();
    await playUriOnDevice(id, "http://cdn/tts.mp3", { title: "播报" });
    expect(calls.map((c) => c.action)).toEqual(["Stop", "SetAVTransportURI", "GetTransportInfo", "Play"]);
    expect(calls.find((c) => c.action === "SetAVTransportURI")!.body).toContain("tts.mp3");
  });

  it("播报不得污染 currentMedia(瞬时插播不该被显示成「正在播放的曲目」)", async () => {
    const id = await seed();
    await playUriOnDevice(id, "http://cdn/tts.mp3", { title: "播报" });
    expect(getCurrentMedia(id)).toBeUndefined();
  });

  it("播报的 Stop 失败同样被吞掉(一次旧状态报错不该让播报发不出去)", async () => {
    const id = await seed();
    soap = (a) => (a === "Stop" ? { fault: "705" } : { xml: OK_XML });
    await expect(playUriOnDevice(id, "http://cdn/tts.mp3")).resolves.toBeUndefined();
  });

  it("waitUntilStopped:读到 STOPPED 才返回", async () => {
    const id = await seed();
    soap = (a) => (a === "GetTransportInfo" ? { xml: `<?xml version="1.0"?><s:Body><CurrentTransportState>PLAYING</CurrentTransportState></s:Body>` } : { xml: OK_XML });
    const t = waitUntilStopped(id, 5000);
    soap = (a) => (a === "GetTransportInfo" ? { xml: `<?xml version="1.0"?><s:Body><CurrentTransportState>STOPPED</CurrentTransportState></s:Body>` } : { xml: OK_XML });
    await t;
    expect(calls.some((c) => c.action === "GetTransportInfo")).toBe(true);
  });

  it("waitUntilStopped:设备失联立刻返回(别把调用方永久吊住)", async () => {
    const id = await seed();
    soap = () => ({ fault: "timeout" });
    const t0 = Date.now();
    await expect(waitUntilStopped(id, 30000)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("stopDevicePlayback:发 Stop、清 currentMedia、并推刷新信号", async () => {
    const id = await seed();
    await castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" });
    await stopDevicePlayback(id);
    expect(getCurrentMedia(id)).toBeUndefined();
    expect(calls.some((c) => c.action === "Stop")).toBe(true);
  });

  it("stopDevicePlayback 的 Stop 失败被容忍(双协议互斥失败不该中断 AirPlay 起播)", async () => {
    const id = await seed();
    soap = () => ({ fault: "705" });
    await expect(stopDevicePlayback(id)).resolves.toBeUndefined();
  });
});

// ===========================================================================
describe("play / pause / stop 三件套", () => {
  it("play → 立即写 PLAYING 事件缓存,HA 免等轮询", async () => {
    const id = await seed();
    await playDevice(id);
    expect(EV.transport).toEqual(["PLAYING"]);
  });

  it("pause → PAUSED_PLAYBACK(不能伪造成 PLAYING,否则 tracker 认为仍在播)", async () => {
    const id = await seed();
    await pauseDevice(id);
    expect(EV.transport).toEqual(["PAUSED_PLAYBACK"]);
  });

  it("stopDevice → STOPPED", async () => {
    const id = await seed();
    await stopDevice(id);
    expect(EV.transport).toEqual(["STOPPED"]);
  });

  it("三个动作对未知设备都抛「设备未找到」", async () => {
    await expect(playDevice("b30-nope")).rejects.toThrow("设备未找到");
    await expect(pauseDevice("b30-nope")).rejects.toThrow("设备未找到");
    await expect(stopDevice("b30-nope")).rejects.toThrow("设备未找到");
  });

  it("失败 → 抛出,并且必须标记设备不可用(否则离线设备会被继续轮询)", async () => {
    const id = await seed();
    soap = () => ({ fault: "500" });
    await expect(pauseDevice(id)).rejects.toThrow();
    expect(isDeviceAvailable(id)).toBe(false);
    expect(shouldPollDevice(id)).toBe(true);
  });
});

// ===========================================================================
// soapCall 的 fault 识别有两个独立判据(HTTP 200 + 错误体),缺一个就会把
// 设备的错误响应当成成功。之前只覆盖到「fetch 直接抛网络错」那条路,
// 200 + 错误体这一路从未被执行过。
// ===========================================================================
describe("soapCall:UPnP fault 必须被识别成错误", () => {
  // ① 只带 <errorCode> 的错误体(部分设备的soap错误包长这样)
  const FAULT_BY_ERRORCODE = `<?xml version="1.0"?><s:Envelope><s:Body>` +
    `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0">` +
    `<errorCode>401</errorCode><errorDescription>Invalid Action</errorDescription>` +
    `</UPnPError></s:Body></s:Envelope>`;

  // ② 只带 <s:Fault> 包壳的错误体(无 <errorCode> 字段)
  const FAULT_BY_FAULT_TAG = `<?xml version="1.0"?><s:Envelope><s:Body>` +
    `<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>` +
    `<detail><UPnPError><errorDescription>Invalid Action</errorDescription></UPnPError>` +
    `</detail></s:Fault></s:Body></s:Envelope>`;

  it("HTTP 200 + 带 <errorCode> 的错误体 → 必须判为错误并带上错误码", async () => {
    const id = await seed();
    soap = (a) => (a === "SetVolume" ? { xml: FAULT_BY_ERRORCODE } : { xml: OK_XML });
    await expect(setDeviceVolume(id, 50)).rejects.toThrow("UPnP error 401");
  });

  it("HTTP 200 + 带 <errorCode> 的错误体 → 错误信息要带上 errorDescription 原文", async () => {
    const id = await seed();
    soap = (a) => (a === "SetVolume" ? { xml: FAULT_BY_ERRORCODE } : { xml: OK_XML });
    await expect(setDeviceVolume(id, 50)).rejects.toThrow("Invalid Action");
  });

  it("HTTP 200 + 只有 <s:Fault> 包壳、没有 errorCode → 也要判为错误", async () => {
    const id = await seed();
    soap = (a) => (a === "SetVolume" ? { xml: FAULT_BY_FAULT_TAG } : { xml: OK_XML });
    // 没有 errorCode 字段时错误码位置显示 "?",但不能因此放过这条 fault
    await expect(setDeviceVolume(id, 50)).rejects.toThrow("UPnP error ?");
  });

  it("HTTP 200 + 正常响应 → 不得被误判成 fault", async () => {
    const id = await seed();
    await expect(setDeviceVolume(id, 50)).resolves.toBeUndefined();
  });
});

// ===========================================================================
describe("音量 / 静音", () => {
  it("越界值必须夹到 0-100", async () => {
    const id = await seed();
    await setDeviceVolume(id, 140);
    expect(last(calls.filter((c) => c.action === "SetVolume")).body).toContain("<DesiredVolume>100</DesiredVolume>");
    await setDeviceVolume(id, -8);
    expect(last(calls.filter((c) => c.action === "SetVolume")).body).toContain("<DesiredVolume>0</DesiredVolume>");
  });

  it("立刻写事件缓存(HA 免等轮询即可显示新音量)", async () => {
    const id = await seed();
    await setDeviceVolume(id, 42);
    expect(EV.volume).toEqual([42]);
  });

  it("设备无 RenderingControl → 明确报错,不静默吞掉", async () => {
    const id = await seedNoRendering();
    await expect(setDeviceVolume(id, 50)).rejects.toThrow("设备不支持音量控制");
    await expect(getDeviceVolume(id)).rejects.toThrow("设备不支持音量控制");
    await expect(setDeviceMute(id, true)).rejects.toThrow("设备不支持静音控制");
  });

  it("SetVolume 失败 → 抛出(让调用方知道没设上)", async () => {
    const id = await seed();
    soap = (a) => (a === "SetVolume" ? { fault: "401" } : { xml: OK_XML });
    await expect(setDeviceVolume(id, 50)).rejects.toThrow();
  });

  it("getDeviceVolume:解析 CurrentVolume", async () => {
    const id = await seed();
    soap = (a) => (a === "GetVolume" ? { xml: `<?xml version="1.0"?><s:Body><CurrentVolume>37</CurrentVolume></s:Body>` } : { xml: OK_XML });
    await expect(getDeviceVolume(id)).resolves.toBe(37);
  });

  it("getDeviceVolume:缺字段 / 非数字都要报错,不能被当成 0 传给前端", async () => {
    const id = await seed();
    soap = (a) => (a === "GetVolume" ? { xml: `<?xml version="1.0"?><s:Body></s:Body>` } : { xml: OK_XML });
    await expect(getDeviceVolume(id)).rejects.toThrow("缺少 CurrentVolume");
    soap = (a) => (a === "GetVolume" ? { xml: `<?xml version="1.0"?><s:Body><CurrentVolume>abc</CurrentVolume></s:Body>` } : { xml: OK_XML });
    await expect(getDeviceVolume(id)).rejects.toThrow("非数字");
  });

  it("静音写 1 / 取消静音写 0(不能用设 0 冒充静音)", async () => {
    const id = await seed();
    await setDeviceMute(id, true);
    expect(last(calls.filter((c) => c.action === "SetMute")).body).toContain("<DesiredMute>1</DesiredMute>");
    expect(EV.muted).toEqual([true]);
    await setDeviceMute(id, false);
    expect(last(calls.filter((c) => c.action === "SetMute")).body).toContain("<DesiredMute>0</DesiredMute>");
    expect(EV.muted).toEqual([true, false]);
  });

  // catch 块里是 `markFailed(...)` 之后必须 rethrow。只断言「音量没被改」是不够的:
  // 吞掉异常的写法同样满足那句话,调用方会以为静音已经设上。
  it("SetMute 失败必须抛出(不能吞掉异常假装静音成功)", async () => {
    const id = await seed();
    soap = (a) => (a === "SetMute" ? { fault: "401" } : { xml: OK_XML });
    await expect(setDeviceMute(id, true)).rejects.toThrow();
    expect(EV.muted).toEqual([]); // 失败路径不得写入「已静音」事件缓存
    expect(isDeviceAvailable(id)).toBe(false);
  });

  it("静音不得改音量读数(两者是独立通道)", async () => {
    const id = await seed();
    await setDeviceVolume(id, 60);
    await setDeviceMute(id, true);
    expect(EV.volume).toEqual([60]);
    expect(EV.muted).toEqual([true]);
  });
});

// ===========================================================================
describe("seek:SOAP 路径", () => {
  /** seek 主干用例都关掉落位校验,避免每条都白等 1.2s。 */
  const noVerify = { verify: false } as const;

  it("REL_TIME 补零到两位(HH:MM:SS)", async () => {
    const id = await seed();
    soap = (a) => (a === "GetPositionInfo" ? { xml: `<?xml version="1.0"?><s:Body><RelTime>00:10:00</RelTime></s:Body>` } : { xml: OK_XML });
    await seekDevice(id, 3661, noVerify);
    expect(calls.find((c) => c.action === "Seek")!.body).toContain("<Target>01:01:01</Target>");
  });

  it("seek 成功必须同时写三处:事件缓存 / 外推基线 / 保护窗", async () => {
    const id = await seed();
    soap = (a) => (a === "GetPositionInfo" ? { xml: `<?xml version="1.0"?><s:Body><RelTime>00:01:00</RelTime></s:Body>` } : { xml: OK_XML });
    await seekDevice(id, 60, noVerify);
    expect(EV.position).toContain(60); // ① 事件缓存(推 WS/HA)
    const st = await getDeviceStatus(id); // ② 基线与 ③ 保护窗
    expect(st.position).toBeGreaterThanOrEqual(60);
  });

  it("Seek 失败 → 抛出并标记不可用", async () => {
    const id = await seed();
    soap = (a) => (a === "Seek" ? { fault: "401" } : { xml: OK_XML });
    await expect(seekDevice(id, 30, noVerify)).rejects.toThrow();
    expect(isDeviceAvailable(id)).toBe(false);
  });

  it("verify:false 用于校验失败后的重发,必须不再派生新校验(否则 seek 风暴)", async () => {
    const id = await seed();
    soap = (a) => (a === "GetPositionInfo" ? { xml: `<?xml version="1.0"?><s:Body><RelTime>NOT_IMPLEMENTED</RelTime></s:Body>` } : { xml: OK_XML });
    await seekDevice(id, 60, noVerify);
    // 判据不是 Seek 条数(重发那一步也发 Seek),而是**有没有派生校验协程**:
    // 校验协程的第一件事就是 readRawPosition 再发一次 GetPositionInfo。
    await settle();
    expect(calls.filter((c) => c.action === "GetPositionInfo")).toHaveLength(0);
    expect(calls.filter((c) => c.action === "Seek")).toHaveLength(1); // 只有用户自己那一下
  });

  it("默认校验:确实会派生出一次落位复核(否则「未落位」永远发现不了)", async () => {
    const id = await seed();
    soap = (a) => (a === "GetPositionInfo" ? { xml: `<?xml version="1.0"?><s:Body><RelTime>NOT_IMPLEMENTED</RelTime></s:Body>` } : { xml: OK_XML });
    await seekDevice(id, 60);
    await settle();
    // 复核用了 readRawPosition 的发法:GetPositionInfo 被查过至少一次
    expect(calls.filter((c) => c.action === "GetPositionInfo").length).toBeGreaterThanOrEqual(1);
  });

  it("设备恒不报位置 → 落位校验无从进行,直接放弃(不能当成未落位去重发)", async () => {
    const id = await seed();
    soap = (a) => (a === "GetPositionInfo" ? { xml: `<?xml version="1.0"?><s:Body><RelTime>00:00:00</RelTime></s:Body>` } : { xml: OK_XML });
    await expect(seekDevice(id, 60)).resolves.toBeUndefined();
    await settle();
    expect(calls.filter((c) => c.action === "Seek").length).toBe(1); // 没有重发
  });

  it("落位判定带容差(设备报的位置差几秒也算落位,不能无脑重发)", async () => {
    const id = await seed();
    soap = (a) => {
      if (a === "GetPositionInfo") return { xml: `<?xml version="1.0"?><s:Body><RelTime>00:01:02</RelTime></s:Body>` };
      return { xml: OK_XML };
    };
    await expect(seekDevice(id, 60)).resolves.toBeUndefined();
    await settle();
    expect(calls.filter((c) => c.action === "Seek").length).toBe(1); // 目标 60,设备报 62,容差内
  });

  it("落位偏低也算未落位(容差是 [target-3, target+6],低于 3 秒的偏差不认)", async () => {
    const id = await seed();
    soap = (a) => (a === "GetPositionInfo" ? { xml: `<?xml version="1.0"?><s:Body><RelTime>00:00:55</RelTime></s:Body>` } : { xml: OK_XML });
    await expect(seekDevice(id, 60)).resolves.toBeUndefined();
    await settle();
    expect(calls.filter((c) => c.action === "Seek").length).toBe(2); // 首发 + 恰好一次重发
  });

  it("落位偏高超出容差 → 同样重发(上界是 target+6 秒)", async () => {
    const id = await seed();
    soap = (a) => (a === "GetPositionInfo" ? { xml: `<?xml version="1.0"?><s:Body><RelTime>00:01:10</RelTime></s:Body>` } : { xml: OK_XML });
    await expect(seekDevice(id, 60)).resolves.toBeUndefined();
    await settle();
    expect(calls.filter((c) => c.action === "Seek").length).toBe(2);
  });
});

// ===========================================================================
describe("getDeviceStatus:采样与位置外推", () => {
  function stub(xmls: Record<string, string> = {}) {
    soap = (a: string) => {
      const map: Record<string, string> = {
        GetTransportInfo: `<?xml version="1.0"?><s:Body><CurrentTransportState>PLAYING</CurrentTransportState></s:Body>`,
        GetPositionInfo: `<?xml version="1.0"?><s:Body><RelTime>00:00:30</RelTime><TrackDuration>00:05:00</TrackDuration><TrackURI>http://x/s-1</TrackURI></s:Body>`,
        GetVolume: `<?xml version="1.0"?><s:Body><CurrentVolume>50</CurrentVolume></s:Body>`,
        GetMute: `<?xml version="1.0"?><s:Body><CurrentMute>0</CurrentMute></s:Body>`,
        ...xmls,
      };
      return { xml: map[a] ?? OK_XML };
    };
  }

  it("一次成功采样:state / position / duration / volume / muted 齐备", async () => {
    const id = await seed();
    stub();
    const st = await getDeviceStatus(id);
    expect(st.state).toBe("PLAYING");
    expect(st.position).toBe(30);
    expect(st.duration).toBe(300);
    expect(st.volume).toBe(50);
    expect(st.muted).toBe(false);
  });

  it("GetTransportInfo 抖动 → 沿用最近一次成功读数(一次抖动不能被当成「播完了」)", async () => {
    const id = await seed();
    stub();
    expect((await getDeviceStatus(id)).state).toBe("PLAYING");
    // 第二次:GetTransportInfo 报错(网络抖动),设备并没有真的停止
    soap = (a: string) => (a === "GetTransportInfo" ? { fault: "timeout" } : { xml: OK_XML });
    expect((await getDeviceStatus(id)).state).toBe("PLAYING");
  });

  it("NOT_IMPLEMENTED 字段必须被忽略(不能把 NOT_IMPLEMENTED 当成有效秒数写进位置)", async () => {
    const id = await seed();
    stub({ GetPositionInfo: `<?xml version="1.0"?><s:Body><RelTime>NOT_IMPLEMENTED</RelTime><TrackDuration>NOT_IMPLEMENTED</TrackDuration></s:Body>` });
    const st = await getDeviceStatus(id); // 干净设备、无历史基线 → 位置应停在 0
    expect(st.position).toBe(0);
    expect(st.duration).toBe(0);
    expect(Number.isNaN(st.position)).toBe(false);
  });

  it("GetMute 失败不能连累音量读数(部分设备有 GetVolume 没 GetMute)", async () => {
    const id = await seed();
    // 把 GetMute 换成抛错,其余走默认实现
    soap = (a: string) => {
      if (a === "GetMute") throw new Error("405 Method Not Allowed");
      const map: Record<string, string> = {
        GetTransportInfo: `<?xml version="1.0"?><s:Body><CurrentTransportState>PLAYING</CurrentTransportState></s:Body>`,
        GetPositionInfo: `<?xml version="1.0"?><s:Body><RelTime>00:00:30</RelTime><TrackDuration>00:05:00</TrackDuration><TrackURI>http://x/s-1</TrackURI></s:Body>`,
        GetVolume: `<?xml version="1.0"?><s:Body><CurrentVolume>50</CurrentVolume></s:Body>`,
      };
      return { xml: map[a] ?? OK_XML };
    };
    const st = await getDeviceStatus(id);
    expect(st.volume).toBe(50);
    expect(st.muted).toBe(false);
  });

  it("muted 的多种真值写法都要认(1 / true / YES)", async () => {
    const id = await seed();
    for (const v of ["1", "true", "YES"]) {
      stub({ GetMute: `<?xml version="1.0"?><s:Body><CurrentMute>${v}</CurrentMute></s:Body>` });
      expect((await getDeviceStatus(id)).muted, `CurrentMute=${v}`).toBe(true);
    }
  });

  it("设备不报位置(PLAYING + position=0)→ 用墙上时钟外推,且不超总时长", async () => {
    const id = await seed();
    await castToDevice({ songId: "s-1", title: "t", deviceId: id, baseUrl: "http://h" });
    // 第一次:设备正常报位置 → 建立可信基线
    stub();
    expect((await getDeviceStatus(id)).position).toBe(30);
    // 第二次:设备转而不报位置(MUZO/HiVi 播转码 chunked 流恒如此)→ 靠墙上时钟外推。
    // 先睡一小会儿:外推量是 `基线 + 墙钟差`,两次采样落在同一毫秒里差值就是 0,
    // 断言会变成「恰好等于」而不是「前进了」。
    await new Promise((r) => setTimeout(r, 30));
    stub({ GetPositionInfo: `<?xml version="1.0"?><s:Body><RelTime>00:00:00</RelTime><TrackDuration>00:05:00</TrackDuration></s:Body>` });
    const st = await getDeviceStatus(id);
    expect(st.position).toBeGreaterThan(30); // 接上基线继续前进
    expect(st.position).toBeLessThanOrEqual(301); // 封顶到 5 分钟
  });

  it("未知设备 → 返回 STOPPED 默认态而不是抛错(前端每几秒轮询一次)", async () => {
    const st = await getDeviceStatus("b30-nope");
    expect(st.state).toBe("STOPPED");
    expect(st.position).toBe(0);
  });

  it("设备记录可以删干净(deleteDeviceRecord 后不再残留)", async () => {
    const id = await seed();
    expect(deleteDeviceRecord(id)).toBe(true);
    expect(deleteDeviceRecord(id)).toBe(false);
    expect(await getDeviceStatus(id)).toMatchObject({ state: "STOPPED" });
  });
});
