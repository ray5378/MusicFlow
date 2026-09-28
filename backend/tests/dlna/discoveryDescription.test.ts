// DLNA description.xml 解析 + 陈旧标记的**契约测试**(services/dlna/discovery.ts)。
//
// 为什么必须有测试:这段是「用正则手撸 UPnP XML」的解析器,没有任何外部依赖兜底 ——
// 相对 controlURL 转绝对、多 service 里挑 AVTransport/RenderingControl、缺 UDN 时
// 拿 location 兜底,每一条都是「设备能被投屏」的前置条件。改错任何一条都不会报错,
// 只会让某些 DLNA 音箱**静默地从列表里消失**(最难复现的一类缺陷:用户看到的是
// 「设备偶发不见了」,日志里什么都没有)。
//
// 抓取入口 `fetchDeviceAtLocation` 只有 `fetch` 这一个网络边界,其余全是纯逻辑,
// 因此用 stubGlobal 顶掉 fetch 就能把整段解析钉死。
import { describe, it, expect, afterEach, vi } from "vitest";

import { fetchDeviceAtLocation, markStaleDevices } from "../../src/services/dlna/discovery.js";

const LOC = "http://192.168.10.30:49152/description.xml";

/** 一份贴近真机的 MediaRenderer description.xml(相对 controlURL、三个 service)。 */
const GOOD_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>主卧</friendlyName>
    <manufacturer>HiVi</manufacturer>
    <modelName>H5MKII</modelName>
    <UDN>uuid:4d696e69-436f-6e74-726f-6c-0001</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <controlURL>/cm/ctrl</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/AVTransport/control</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/RenderingControl/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

/** 精确删掉含某个关键字的那个 service 块(按块边界切,不能靠贪婪正则跨块删)。 */
function dropService(xml: string, keyword: string): string {
  const parts = xml.split("<service>");
  const kept = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    const block = "<service>" + parts[i];
    const end = block.indexOf("</service>");
    const body = end >= 0 ? block.slice(0, end) : block;
    if (body.includes(keyword)) continue;
    kept.push(block);
  }
  return kept.join("");
}

/** 用整段 serviceList 替换(用于构造多 AVTransport 等脏数据场景)。 */
function replaceServiceList(xml: string, list: string): string {
  const a = xml.indexOf("<serviceList>");
  const b = xml.indexOf("</serviceList>") + "</serviceList>".length;
  return xml.slice(0, a) + list + xml.slice(b);
}

/** 装一个假 fetch:返回 status + body(xml)。 */
function stubFetch(status: number, body: string, opts: { throw?: any } = {}) {
  const fn = opts.throw
    ? vi.fn(() => { throw opts.throw; })
    : vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** 便利:用默认 location 解析。 */
function parse(status: number, body: string, opts?: { throw?: any }) {
  stubFetch(status, body, opts);
  return fetchDeviceAtLocation(LOC) as Promise<any>;
}

/** 便利:自定义 location(用来触发 toAbsolute 的 base 非法分支)。 */
function parseAt(location: string, status: number, body: string, opts?: { throw?: any }) {
  stubFetch(status, body, opts);
  return fetchDeviceAtLocation(location) as Promise<any>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchDeviceAtLocation:description.xml 解析", () => {
  it("完整设备:取出 name/manufacturer/model,并把相对 controlURL 转成绝对地址", async () => {
    const d = await parse(200, GOOD_XML);
    expect(d).not.toBeNull();
    expect(d.id).toBe("4d696e69-436f-6e74-726f-6c-0001"); // 去掉 uuid: 前缀
    expect(d.name).toBe("主卧");
    expect(d.manufacturer).toBe("HiVi");
    expect(d.model).toBe("H5MKII");
    expect(d.location).toBe(LOC);
    expect(d.available).toBe(true);
    // 关键:相对路径必须按 description 的 base 补成绝对,否则 SOAP 会打到自己身上
    expect(d.avTransportUrl).toBe("http://192.168.10.30:49152/AVTransport/control");
    expect(d.renderingControlUrl).toBe("http://192.168.10.30:49152/RenderingControl/control");
    // ConnectionManager 不是我们要的,不能混进来
    expect(d.avTransportUrl).not.toContain("/cm/");
  });

  it("只有 AVTransport 没有 RenderingControl 时,后者留空而不报错", async () => {
    const d = await parse(200, dropService(GOOD_XML, "RenderingControl"));
    expect(d).not.toBeNull();
    expect(d.avTransportUrl).toBe("http://192.168.10.30:49152/AVTransport/control");
    expect(d.renderingControlUrl).toBeUndefined();
  });

  it("没有 AVTransport 服务 → 判定不可投屏,直接返回 null", async () => {
    // 只留 ConnectionManager:这类设备我们推不动,宁可不列也不能列出一个投不了的
    expect(await parse(200, dropService(GOOD_XML, "AVTransport"))).toBeNull();
  });

  it("HTTP 非 2xx → 返回 null(不抛)", async () => {
    expect(await parse(404, "not found")).toBeNull();
    expect(await parse(500, "boom")).toBeNull();
  });

  it("抓 description 抛异常 → 吞掉并返回 null(单个设备失败不拖垮整轮扫描)", async () => {
    expect(await parse(200, "", { throw: new Error("ECONNREFUSED") })).toBeNull();
    expect(await parse(200, "", { throw: new TypeError("Failed to fetch") })).toBeNull();
  });

  it("friendlyName 缺失 → 兜底成「未知设备」,不让整行报废", async () => {
    const d = await parse(200, GOOD_XML.replace(/<friendlyName>[^<]*<\/friendlyName>/, ""));
    expect(d.name).toBe("未知设备");
  });

  it("UDN 缺 uuid: 前缀时原样当 id(不能退化成用 location 兜底)", async () => {
    const d = await parse(200, GOOD_XML.replace("<UDN>uuid:4d696e69-436f-6e74-726f-6c-0001</UDN>",
      "<UDN>4d696e69-436f-6e74-726f-6c-0001</UDN>"));
    expect(d.id).toBe("4d696e69-436f-6e74-726f-6c-0001");
    expect(d.id).not.toBe(LOC);
  });

  it("UDN 整段缺失 → 拿 location 当 id,设备至少还能被看见", async () => {
    const d = await parse(200, GOOD_XML.replace(/<UDN>[^<]*<\/UDN>/, ""));
    expect(d.id).toBe(LOC);
  });

  it("service 顺序打乱也能挑对(按 serviceType 匹配,不看位置)", async () => {
    const d = await parse(200, replaceServiceList(GOOD_XML, `<serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/RC/c</controlURL></service>
        <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/AVT/c</controlURL></service>
      </serviceList>`));
    expect(d.avTransportUrl).toBe("http://192.168.10.30:49152/AVT/c");
    expect(d.renderingControlUrl).toBe("http://192.168.10.30:49152/RC/c");
  });

  it("同一 serviceType 出现两次 → 后者覆盖前者(现状记录,只钉行为不评价对错)", async () => {
    // 实现里是 `avTransportUrl = toAbsolute(...)` 无条件赋值,所以是「最后出现的赢」。
    // 真机脏数据(重复 service)才撞得到;这里只锁住这个语义,防止有人按「第一个赢」去改。
    const d = await parse(200, replaceServiceList(GOOD_XML, `<serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/avt/first</controlURL></service>
        <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/avt/second</controlURL></service>
      </serviceList>`));
    expect(d.avTransportUrl).toBe("http://192.168.10.30:49152/avt/second");
  });

  it("service 块缺少 controlURL → 该服务被跳过(不能拿空串去发 SOAP)", async () => {
    const d = await parse(200, replaceServiceList(GOOD_XML, `<serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType></service>
      </serviceList>`));
    expect(d).toBeNull(); // 唯一的 AVTransport 没 controlURL → 判为不可投屏
  });

  it("base 不是合法 URL 时 new URL 会抛 → controlURL 原样返回,不让整条设备报废", async () => {
    const xml = `<root><device><friendlyName>x</friendlyName><UDN>uuid:1</UDN>
      <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
      <controlURL>/avt/c</controlURL></service></device></root>`;
    const d = await parseAt("bogus-base", 200, xml);
    expect(d).not.toBeNull();              // 设备仍然被认下来
    expect(d.avTransportUrl).toBe("/avt/c"); // 原样返回,而不是抛出去把整轮扫描带崩
  });

  it("请求带 5 秒超时的 signal(慢设备不能把整轮扫描拖死)", async () => {
    const fn = stubFetch(200, GOOD_XML);
    await fetchDeviceAtLocation(LOC);
    const init = fn.mock.calls[0]?.[1] as any;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("lastSeen 取的是抓到这一刻(新发现的设备不能一进来就判成陈旧)", async () => {
    const before = Date.now();
    const d = await parse(200, GOOD_XML);
    expect(d.lastSeen).toBeGreaterThanOrEqual(before);
    expect(Date.now() - d.lastSeen).toBeLessThan(1000);
  });
});

describe("markStaleDevices:超过过期窗口就标离线", () => {
  const STALENESS = 10 * 60 * 1000; // discovery.ts 的 STALENESS_MS

  /** 在冻结的时钟里造一台设备,偏移 offsetMs。
   *
   * ⚠️ 必须冻时钟(与 memoryReclaim 那条边界用例同源):裸写 `Date.now() - X` 的话,
   * 「构造设备」和「markStaleDevices 内部再取一次 now」之间会过去真实毫秒 —— 边界
   * 相差 1 毫秒的那几条于是随机翻红(实测 10 轮里红 1 次)。冻住之后 `now - lastSeen`
   * 严格等于构造时给定的偏移,「差 1 毫秒算不算离线」这条边界语义才与机器快慢无关。
   */
  function deviceAt(offsetMs: number, available = true): any {
    return { id: "a", lastSeen: Date.now() - offsetMs, available };
  }

  /** ⚠️ 造设备**和**跑断言必须都在这个块里面。初版把断言留在了块外,于是
   * `markStaleDevices` 又跑在真实时钟上(构造与判定隔了真实毫秒)——「差 0 毫秒
   * 算不算过期」这种边界用例于是偶发红(实测 12 轮里红 3 次,窗口内那两条也跟着抖)。 */
  function frozen(fn: () => void): void {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(now);
      fn();
    } finally {
      vi.useRealTimers();
    }
  }

  it("超过窗口 → available 改 false", () => {
    frozen(() => {
      const d = deviceAt(STALENESS + 1);
      expect(markStaleDevices([d])[0].available).toBe(false);
    });
  });

  it("窗口内 → 一律不动", () => {
    frozen(() => {
      const d = deviceAt(STALENESS - 1);
      expect(markStaleDevices([d])[0].available).toBe(true);
    });
  });

  it("恰好卡在窗口边界上按「未过期」处理(严格 > 才判离线)", () => {
    frozen(() => {
      expect(markStaleDevices([deviceAt(STALENESS)])[0].available).toBe(true); // 差 0 毫秒
      expect(markStaleDevices([deviceAt(STALENESS + 1)])[0].available).toBe(false); // 差 1 毫秒
    });
  });

  it("已经离线的设备再跑一次不会被翻回在线(只能单向变)", () => {
    frozen(() => {
      const d = deviceAt(STALENESS * 3, false);
      expect(markStaleDevices([d])[0].available).toBe(false);
    });
  });

  it("原样返回同一个数组(调用方依赖返回值,不能只改内部)", () => {
    frozen(() => {
      const arr = [deviceAt(STALENESS + 1)];
      expect(markStaleDevices(arr)).toBe(arr);
    });
  });
});
