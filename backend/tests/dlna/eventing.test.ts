// ==================== DLNA GENA 事件订阅(eventing) ====================
// 覆盖:事件状态解析(AVTransport / RenderingControl)、SUBSCRIBE 建链与续订、
// 后端主动下发(音量/传输态/静音/定位)的即时推送、孤儿清理。
// 网络层全部替换:对外 SUBSCRIBE 用 mock fetch;对内的 NOTIFY 走本机回环真实 HTTP。
// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const M = vi.hoisted(() => ({
  trackChanged: [] as string[],
  reported: [] as any[],
  subscribeOk: true as boolean,
  subscribeTimeout: "Second-300" as string | null,
  fetchCalls: [] as Array<{ url: string; method: string; headers: Record<string, string> }>,
}));

vi.mock("../../src/services/dlna/control.js", () => ({
  notifyTrackChanged: (deviceId: string) => M.trackChanged.push(deviceId),
}));

vi.mock("../../src/services/player/index.js", () => ({
  getPlayerController: () => ({
    reportState: (s: any) => M.reported.push(s),
  }),
}));

import { getEventManager, type DeviceEventState } from "../../src/services/dlna/eventing.js";

const realFetch = globalThis.fetch;

const DEVICE = {
  id: "dev-1",
  name: "测试音箱",
  location: "http://192.168.1.50:8080/desc.xml",
  avTransportUrl: "http://192.168.1.50:8080/AVTransport/control",
  renderingControlUrl: "http://192.168.1.50:8080/RenderingControl/control",
} as any;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 构造 GENA NOTIFY 体(LastChange 内容是转义后的 XML)。 */
function notifyBody(innerXml: string): string {
  return `<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>${esc(
    innerXml,
  )}</LastChange></e:property></e:propertyset>`;
}

let em: ReturnType<typeof getEventManager>;
let port = 0;

beforeEach(async () => {
  M.trackChanged = [];
  M.reported = [];
  M.subscribeOk = true;
  M.subscribeTimeout = "Second-300";
  M.fetchCalls = [];

  vi.stubGlobal("fetch", async (url: any, init: any) => {
    const u = String(url);
    // 本机回环的 NOTIFY 走真实 HTTP(打到 EventManager 自己的 server)
    if (u.startsWith("http://127.0.0.1:")) return realFetch(u, init);
    M.fetchCalls.push({ url: u, method: init?.method, headers: init?.headers || {} });
    if (!M.subscribeOk) throw new Error("network down");
    const headers = new Headers();
    headers.set("SID", "uuid:SID-1");
    if (M.subscribeTimeout) headers.set("TIMEOUT", M.subscribeTimeout);
    return new Response("", { status: 200, headers });
  });

  em = getEventManager();
  em.pruneOrphans(new Set()); // 清掉上一用例残留的事件状态(单例跨用例共享)
  await em.subscribe(DEVICE);
  port = (em as any).server?.address()?.port ?? 0;
});

afterEach(async () => {
  em.unsubscribeAll(DEVICE.id);
  vi.unstubAllGlobals();
});

// EventManager 的 NOTIFY server 是常驻的,测试结束必须显式关闭,
// 否则 vitest 主进程不会退出(表现为"跑完不收尾")。
afterAll(async () => {
  unsubscribeHook();
  await new Promise<void>((resolve) => {
    const srv = (getEventManager() as any).server;
    if (srv) srv.close(() => resolve());
    else resolve();
  });
});

/** 关掉续订定时器,避免 dangling timer 拖住进程。 */
function unsubscribeHook(): void {
  const m = (getEventManager() as any).subs as Map<string, any>;
  for (const sub of m.values()) if (sub?.renewTimer) clearTimeout(sub.renewTimer);
  m.clear();
}

async function notify(svcIdx: string, innerXml: string, deviceId = DEVICE.id) {
  const res = await realFetch(`http://127.0.0.1:${port}/rest/dlna/event/${deviceId}/${svcIdx}`, {
    method: "NOTIFY",
    body: notifyBody(innerXml),
  });
  return res.status;
}

async function settle() {
  await new Promise((r) => setTimeout(r, 60));
}

describe("GENA 订阅建链", () => {
  it("对 AVTransport + RenderingControl 各发一次 SUBSCRIBE", () => {
    expect(M.fetchCalls.length).toBe(2);
    expect(M.fetchCalls[0].url).toBe(DEVICE.avTransportUrl);
    expect(M.fetchCalls[1].url).toBe(DEVICE.renderingControlUrl);
    expect(M.fetchCalls[0].method).toBe("SUBSCRIBE");
    expect(M.fetchCalls[0].headers.NT).toBe("upnp:event");
    expect(M.fetchCalls[0].headers.TIMEOUT).toBe("Second-300");
    expect(M.fetchCalls[0].headers.CALLBACK).toContain(`/rest/dlna/event/${DEVICE.id}/0`);
  });

  it("订阅成功后 isSubscribed 为 true", () => {
    expect(em.isSubscribed(DEVICE.id)).toBe(true);
  });

  it("重复 subscribe 不重复建链(幂等)", async () => {
    await em.subscribe(DEVICE);
    expect(M.fetchCalls.length).toBe(2);
  });

  it("SUBSCRIBE 失败被吞掉:不抛、isSubscribed=false(前端退化为轮询)", async () => {
    M.subscribeOk = false;
    em.unsubscribeAll(DEVICE.id);
    await expect(em.subscribe(DEVICE)).resolves.toBeUndefined();
    expect(em.isSubscribed(DEVICE.id)).toBe(false);
  });

  it("首次订阅且 location 非法 → 无从推导回调基址,直接返回不发 SUBSCRIBE", async () => {
    // callbackBase 一旦建立就会复用,该分支只在"全新实例 + 首次订阅"时可达,
    // 故这里重置模块拿到独立的 EventManager。
    vi.resetModules();
    const mod = await import("../../src/services/dlna/eventing.js");
    const fresh = mod.getEventManager();
    M.fetchCalls = [];
    await fresh.subscribe({ ...DEVICE, id: "bad-loc", location: "not-a-url" } as any);
    expect(M.fetchCalls.length).toBe(0);
    await new Promise<void>((resolve) => {
      const srv = (fresh as any).server;
      if (srv) srv.close(() => resolve());
      else resolve();
    });
  });

  it("callbackBase 已建立后,即使 location 非法也能继续订阅(走已缓存基址)", async () => {
    const before = M.fetchCalls.length;
    await em.subscribe({ ...DEVICE, id: "odd-loc", location: "not-a-url" } as any);
    expect(M.fetchCalls.length).toBe(before + 2);
  });

  it("unsubscribeAll 清掉该设备的所有订阅", () => {
    em.unsubscribeAll(DEVICE.id);
    expect(em.isSubscribed(DEVICE.id)).toBe(false);
  });

  it("续订(renew)用 SID 头,失败时丢弃订阅", async () => {
    const key = `${DEVICE.id}|urn:schemas-upnp-org:service:AVTransport:1`;
    // 成功续订
    await (em as any).renew(DEVICE.avTransportUrl, DEVICE.id, "0");
    expect(M.fetchCalls.some((c) => c.headers.SID === "uuid:SID-1")).toBe(true);
    expect((em as any).subs.get(key)).toBeTruthy();
    // 失败续订 → 订阅被丢弃
    M.subscribeOk = false;
    await (em as any).renew(DEVICE.avTransportUrl, DEVICE.id, "0");
    expect((em as any).subs.get(key)).toBeUndefined();
    M.subscribeOk = true;
  });
});

describe("NOTIFY 解析:AVTransport", () => {
  it("解析传输状态 / 进度 / 时长(hh:mm:ss → 秒)", async () => {
    const status = await notify(
      "0",
      `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/"><InstanceID val="0">` +
        `<TransportState val="PLAYING"/><RelTime val="00:01:30"/><TrackDuration val="00:03:20"/>` +
        `</InstanceID></Event>`,
    );
    expect(status).toBe(200);
    const st = em.getEventState(DEVICE.id)!;
    expect(st.state).toBe("PLAYING");
    expect(st.position).toBe(90);
    expect(st.duration).toBe(200);
    expect(typeof st.updatedAt).toBe("number");
  });

  it("兼容 value= 写法(非标准设备)", async () => {
    await notify("0", `<Event><InstanceID value="0"><TransportState value="PAUSED_PLAYBACK"/></InstanceID></Event>`);
    expect(em.getEventState(DEVICE.id)!.state).toBe("PAUSED_PLAYBACK");
  });

  it("NOT_IMPLEMENTED 的 RelTime/TrackDuration 不覆盖已有值", async () => {
    await notify("0", `<Event><TransportState val="PLAYING"/><RelTime val="00:00:10"/></Event>`);
    expect(em.getEventState(DEVICE.id)!.position).toBe(10);
    await notify(
      "0",
      `<Event><TransportState val="PLAYING"/><RelTime val="NOT_IMPLEMENTED"/><TrackDuration val="NOT_IMPLEMENTED"/></Event>`,
    );
    const st = em.getEventState(DEVICE.id)!;
    expect(st.position).toBe(10); // 保留上一次的有效值
    expect(st.duration).toBeUndefined();
  });

  it("CurrentTrackURI 变化 → 通知 control 层重置预取标记", async () => {
    await notify("0", `<Event><CurrentTrackURI val="http://x/t1.mp3"/></Event>`);
    expect(M.trackChanged).toEqual([DEVICE.id]);
    // 同一 URI 不重复通知
    await notify("0", `<Event><CurrentTrackURI val="http://x/t1.mp3"/></Event>`);
    expect(M.trackChanged.length).toBe(1);
  });

  it("状态上报给 PlayerController(playerId 带 dlna: 前缀)", async () => {
    await notify("0", `<Event><TransportState val="PLAYING"/><RelTime val="00:00:05"/></Event>`);
    await settle();
    const r = M.reported[M.reported.length - 1];
    expect(r.playerId).toBe(`dlna:${DEVICE.id}`);
    expect(r.position).toBe(5);
  });

  it("TRANSLATING / TRANSITIONING → BUFFERING;未知态 → IDLE", async () => {
    await notify("0", `<Event><TransportState val="TRANSITIONING"/></Event>`);
    await settle();
    expect(M.reported[M.reported.length - 1].playbackState).toBe("BUFFERING");
    await notify("0", `<Event><TransportState val="WEIRD"/></Event>`);
    await settle();
    expect(M.reported[M.reported.length - 1].playbackState).toBe("IDLE");
  });

  it("非法 XML / 无 LastChange → 静默忽略(等服务推下一条)", async () => {
    const res = await realFetch(`http://127.0.0.1:${port}/rest/dlna/event/${DEVICE.id}/0`, {
      method: "NOTIFY",
      body: "<not-a-propertyset>",
    });
    expect(res.status).toBe(200);
    expect(() => em.getEventState(DEVICE.id)).not.toThrow();
  });

  it("非 NOTIFY 方法 → 405", async () => {
    const res = await realFetch(`http://127.0.0.1:${port}/rest/dlna/event/${DEVICE.id}/0`, { method: "GET" });
    expect(res.status).toBe(405);
  });
});

describe("NOTIFY 解析:RenderingControl", () => {
  it("解析 Master 声道音量(channel 在 val 之前)", async () => {
    await notify(
      "1",
      `<Event><InstanceID val="0"><Volume channel="Master" val="42"/></InstanceID></Event>`,
    );
    expect(em.getEventState(DEVICE.id)!.volume).toBe(42);
  });

  it("解析 Master 声道音量(channel 在 val 之后)", async () => {
    await notify("1", `<Event><Volume val="17" channel="Master"/></Event>`);
    expect(em.getEventState(DEVICE.id)!.volume).toBe(17);
  });

  it("无 channel 属性 → 取第一个 Volume", async () => {
    await notify("1", `<Event><Volume val="9"/></Event>`);
    expect(em.getEventState(DEVICE.id)!.volume).toBe(9);
  });

  it("Mute 支持 0/1 与 true/false 多种写法", async () => {
    await notify("1", `<Event><Mute channel="Master" val="1"/></Event>`);
    expect(em.getEventState(DEVICE.id)!.muted).toBe(true);
    await notify("1", `<Event><Mute channel="Master" val="0"/></Event>`);
    expect(em.getEventState(DEVICE.id)!.muted).toBe(false);
    await notify("1", `<Event><Mute val="TRUE"/></Event>`);
    expect(em.getEventState(DEVICE.id)!.muted).toBe(true);
    await notify("1", `<Event><Mute val="yes"/></Event>`);
    expect(em.getEventState(DEVICE.id)!.muted).toBe(true);
    await notify("1", `<Event><Mute val="whatever"/></Event>`);
    expect(em.getEventState(DEVICE.id)!.muted).toBe(false);
  });

  it("音量与传输态合并进同一份状态(状态跨服务累加)", async () => {
    await notify("0", `<Event><TransportState val="PLAYING"/></Event>`);
    await notify("1", `<Event><Volume val="55" channel="Master"/></Event>`);
    const st = em.getEventState(DEVICE.id)!;
    expect(st.state).toBe("PLAYING");
    expect(st.volume).toBe(55);
  });
});

describe("后端主动下发的即时推送", () => {
  function collect(): DeviceEventState[] {
    const got: DeviceEventState[] = [];
    em.on("state_changed", (_id: string, st: DeviceEventState) => got.push(st));
    return got;
  }

  it("setVolume 更新缓存并广播", () => {
    const got = collect();
    em.setVolume(DEVICE.id, 77);
    expect(em.getEventState(DEVICE.id)!.volume).toBe(77);
    expect(got[got.length - 1].volume).toBe(77);
    em.removeAllListeners("state_changed");
  });

  it("setTransportState 更新缓存并广播", () => {
    const got = collect();
    em.setTransportState(DEVICE.id, "STOPPED");
    expect(em.getEventState(DEVICE.id)!.state).toBe("STOPPED");
    expect(got[got.length - 1].state).toBe("STOPPED");
    em.removeAllListeners("state_changed");
  });

  it("setMuted / setPosition 更新缓存并广播", () => {
    em.setMuted(DEVICE.id, true);
    expect(em.getEventState(DEVICE.id)!.muted).toBe(true);
    em.setPosition(DEVICE.id, 123);
    expect(em.getEventState(DEVICE.id)!.position).toBe(123);
    em.removeAllListeners("state_changed");
  });

  it("device_list_changed 事件带设备数", () => {
    let n = -1;
    em.once("device_list_changed", (c: number) => { n = c; });
    em.emitDeviceListChanged(4);
    expect(n).toBe(4);
  });
});

describe("孤儿清理", () => {
  it("pruneOrphans 清掉已下线设备的状态与曲目缓存", async () => {
    const gone = "dev-gone-" + Date.now();
    // 本用例自造两条状态(不依赖其它用例的残留):一条保留、一条待清理
    await notify("0", `<Event><TransportState val="PLAYING"/></Event>`);
    await notify("0", `<Event><TransportState val="PLAYING"/><CurrentTrackURI val="http://x/g.mp3"/></Event>`, gone);
    expect(em.getEventState(gone)).toBeTruthy();
    em.pruneOrphans(new Set([DEVICE.id]));
    expect(em.getEventState(gone)).toBeUndefined();
    expect(em.getEventState(DEVICE.id)).toBeTruthy();
  });
});
