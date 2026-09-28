// `discoverDlnaDevices` 的扫描 / 合并 / 陈旧剔除契约测试(services/dlna/discovery.ts)。
//
// 盯住三条最容易「静默退化」的纪律:
//   1. socket 出错必须早退并**标记本轮不可信** —— 一次瞬时 socket 错误若被当成
//      「权威答案」,空集就会把**全网设备一次性判成离线**(设备集体消失、日志无异常)。
//   2. 被动通告(alive)登记的设备要和主动 M-SEARCH 的结果**合并**,不能互相覆盖;
//      家常场景是设备已开机、正等着被拉起来,用户刷新列表就该看到它。
//   3. 超过过期窗口没再听到的通告必须**剔除**,否则设备拔电后会在注册表里 linger 到
//      下一次被扫描当成活设备。
//
// dgram 与 fetch 是仅有的两个网络边界,全部换成假体;其余(解析、合并、去重)走真实实现。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const sockets: any[] = [];
  return {
    sockets,
    failMembership: false,
    // ⚠️ 必须写 `h.failMembership`:对象字面量里的 `failMembership: false` 只是属性,
    // 不是词法变量,直接写裸标识符在 reset() 调用时是 ReferenceError(本文件初版就踩了)。
    reset() { sockets.length = 0; h.failMembership = false; },
    createSocket(opts: any) {
      const listeners: Record<string, Function[]> = {};
      const sock: any = {
        opts,
        listeners,
        sent: [] as any[][],
        on(ev: string, cb: Function) { (listeners[ev] ||= []).push(cb); return sock; },
        emit(ev: string, ...a: any[]) { for (const cb of listeners[ev] || []) cb(...a); },
        // ⚠️ 必须按 Node 的真实签名实现:监听端是 `bind(port, cb)`(回调在**最后一个**
        // 参数),扫描端才是 `bind(cb)`。本文件初版只认单参,把监听器的回调静默丢了 ——
        // 结果是 discovery.ts 里 addMembership 那行(唯一的空 catch)在测试中永远
        // 执行不到,覆盖率数字看着漂亮,那条分支其实从没被验证过(变异反证最先暴露)。
        bind(...args: any[]) {
          const cb = args[args.length - 1];
          if (typeof cb === "function") cb();
        },
        send(...a: any[]) { sock.sent.push(a); },
        close() { sock.closed = true; },
        addMembership() {
          // 用于覆盖「加入组播组失败」的 catch:真机上容器/多网卡环境下
          // addMembership 抛 EADDRNOTAVAIL 是常态,这里必须吞掉而不是让监听器崩掉
          if (h.failMembership) throw new Error("EADDRNOTAVAIL");
        },
      };
      sockets.push(sock);
      return sock;
    },
  };
});

vi.mock("dgram", () => ({ default: { createSocket: h.createSocket } }));

import { discoverDlnaDevices, lastScanWasErrored, handleNotifyText, onSsdpEvent, clearAliveEmit } from "../../src/services/dlna/discovery.js";

const A = "http://192.168.10.30:49152/description.xml";
const B = "http://192.168.10.31:8200/desc.xml";

/** 通告注册表 `announced` 是模块级 Map,跨用例残留会把上一台设备带进下一轮扫描结果,
 *  所以每个用例开跑前统一用一条 byebye 清场(byebye 正是它唯一的删除入口)。 */
const USN = {
  A: "uuid:a-a-a-a-a::urn:schemas-upnp-org:service:AVTransport:1",
  B: "uuid:b-b-b-b-b::urn:schemas-upnp-org:service:AVTransport:1",
  C: "uuid:c-c-c-c-c::urn:x",
};

// ⚠️ 清场报文必须带 LOCATION:`handleNotifyText` 开头就是 `if (!loc) return`,
// 缺了它连 `announced.delete(usn)` 那一段都执行不到(本文件初版就漏了这行,
// 导致上一台设备一直残留、把「一个 LOCATION 都没收到」用例顶红)。
function notifyBye(usn: string) {
  handleNotifyText([
    "NOTIFY * HTTP/1.1",
    "HOST: 239.255.255.250:1900",
    `LOCATION: ${A}`,
    "NT: urn:schemas-upnp-org:service:AVTransport:1",
    "NTS: ssdp:byebye",
    `USN: ${usn}`,
    "",
    "",
  ].join("\r\n"));
}

const XML_A = `<root><device><friendlyName>主卧</friendlyName><manufacturer>HiVi</manufacturer>
<modelName>H5MKII</modelName><UDN>uuid:a-a-a-a-a</UDN>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/avt/a</controlURL></service>
</device></root>`;

const XML_B = `<root><device><friendlyName>客厅</friendlyName>
<UDN>uuid:b-b-b-b-b</UDN>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/avt/b</controlURL></service>
</device></root>`;

/** 按 location 分发 description(未登记的返回 404 → 该设备被跳过)。 */
function stubDevices(map: Record<string, string>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = map[url];
    if (!body) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => body };
  }));
}

/** 构造一台假 socket:discoverDlnaDevices 内部创建的那个(最后一个 bind 的)。 */
function scanSocket() { return h.sockets[h.sockets.length - 1]; }

beforeEach(() => {
  h.reset();
  // ⚠️ Date 必须一起 fake:不 fake 的话 `vi.setSystemTime` 对 `Date.now()` 完全无效,
  // 「超过过期窗口」这类用例会拿到真实时钟,断言与预期南辕北辙(本文件初版就栽在这)。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-28T10:00:00.000Z"));
  // 让监听器的 addMembership 抛错:这条 catch 分支(加入组播组失败必须静默忽略)
  // 只在 startListener 首次执行时经过一次,是 discovery.ts 最后一处未覆盖行。
  h.failMembership = true;
  for (const u of Object.values(USN)) notifyBye(u); // 清掉上一轮残留的通告登记
  // ⚠️ 还必须放开 alive 去抖窗口:`lastAliveEmitAt` 同样是模块级 Map,上一个用例若用
  // 过同一 LOCATION 会把 60s 窗口占掉(每个用例都把时钟拨回同一基准,间隔≈0),于是
  // 排在它后面的用例发 alive 会被直接吞掉 —— 表现为「用例顺序一 shuffle 就偶发红」
  // (实测:8 轮里红 4 轮,恰好是「订阅者异常」排在 alive 用例之后的那些顺序)。
  // 这是测试自身的顺序耦合,不是产品缺陷;用官方清理入口 clearAliveEmit 兜住。
  clearAliveEmit(A);
  clearAliveEmit(B);
  stubDevices({ [A]: XML_A, [B]: XML_B });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 跑一轮扫描(默认 50ms 窗口),必要时先把给定的 LOCATION 报文喂进去。 */
async function scan(locations: string[] = [], timeoutMs = 50) {
  const p = discoverDlnaDevices(timeoutMs);
  const sock = scanSocket();
  for (const loc of locations) {
    sock.emit("message", Buffer.from(`HTTP/1.1 200 OK\r\nLOCATION: ${loc}\r\n\r\n`));
  }
  await vi.advanceTimersByTimeAsync(timeoutMs + 20);
  return p;
}

function notifyAlive(loc: string, usn: string) {
  handleNotifyText([
    "NOTIFY * HTTP/1.1",
    "HOST: 239.255.255.250:1900",
    `LOCATION: ${loc}`,
    `NT: urn:schemas-upnp-org:service:AVTransport:1`,
    "NTS: ssdp:alive",
    `USN: ${usn}`,
    "",
    "",
  ].join("\r\n"));
}

describe("discoverDlnaDevices:socket 错误早退", () => {
  it("socket 报错 → 立刻结束,并且本轮结果被标记不可信", async () => {
    const p = discoverDlnaDevices(5000);
    await vi.advanceTimersByTimeAsync(5);
    scanSocket().emit("error", new Error("EADDRINUSE"));
    const devices = await p;
    // 早退时 locations 还是空集 —— 必须返回空,且必须留下「不可信」标记
    expect(devices).toEqual([]);
    expect(lastScanWasErrored()).toBe(true);
  });

  it("新一轮扫描开始时先把上一轮的不可信标记清掉(不能把旧污点带进新轮次)", async () => {
    const first = discoverDlnaDevices(5000);
    await vi.advanceTimersByTimeAsync(5);
    scanSocket().emit("error", new Error("EADDRINUSE"));
    await first;
    expect(lastScanWasErrored()).toBe(true);

    // 正常跑完一轮(有 LOCATION 进来)后,标记必须归零
    await scan([A]);
    expect(lastScanWasErrored()).toBe(false);
  });
});

describe("discoverDlnaDevices:主动扫描 + 解析", () => {
  it("收集到的 LOCATION 全部去抓 description 并合并成设备列表", async () => {
    const devices = await scan([A, B]);
    expect(devices.map((d: any) => d.id).sort()).toEqual(["a-a-a-a-a", "b-b-b-b-b"]);
    expect(devices.find((d: any) => d.id === "a-a-a-a-a").name).toBe("主卧");
    // XML_B 没写 modelName → `pick()` 找不到时返回空串(不是 undefined),这里按现状钉住
    expect(devices.find((d: any) => d.id === "b-b-b-b-b").model).toBe("");
  });

  it("抓不到的设备(404)被跳过,不能拖垮同轮里其他设备", async () => {
    const devices = await scan([A, "http://192.168.10.99:1/desc.xml", B]);
    expect(devices.map((d: any) => d.id).sort()).toEqual(["a-a-a-a-a", "b-b-b-b-b"]);
  });

  it("一个 LOCATION 都没收到 → 返回空数组", async () => {
    expect(await scan([])).toEqual([]);
  });

  it("发出的 M-SEARCH 报文带 ssdp:discover +正确的 ST/MX", async () => {
    const p = discoverDlnaDevices(50);
    await vi.advanceTimersByTimeAsync(60);
    await p;
    const req = Buffer.from(scanSocket().sent[0][0]).toString();
    expect(req).toContain('MAN: "ssdp:discover"');
    expect(req).toContain("MX: 3");
    expect(req).toContain("ST: urn:schemas-upnp-org:device:MediaRenderer:1");
  });
});

describe("discoverDlnaDevices:被动通告与主动扫描合并", () => {
  it("通告过的设备即使这轮没回 M-SEARCH,也要出现在结果里", async () => {
    notifyAlive(A, USN.A);
    const devices = await scan([]); // 主动扫描一条都没收到
    // 合并的关键:设备不是靠 M-SEARCH 回来的,而是靠之前登记过的通告
    expect(devices.map((d: any) => d.id)).toEqual(["a-a-a-a-a"]);
  });

  it("同一台设备既被通告又被 M-SEARCH 命中 → 只出现一次(按 id 去重)", async () => {
    notifyAlive(A, USN.A);
    const devices = await scan([A]);
    expect(devices.filter((d: any) => d.id === "a-a-a-a-a")).toHaveLength(1);
  });

  it("通告里的设备抓不到 description(HTTP 还没就绪)→ 不出现在列表里", async () => {
    // 真机场景:设备刚被第三方 App 拉起,SSDP 已广播但内嵌 HTTP 还没起来
    notifyAlive("http://192.168.10.77:1/desc.xml", USN.C);
    expect(await scan([])).toEqual([]);
  });

  it("超过过期窗口(10 分钟)没再听到 → 通告被剔除,不会再被扫进来", async () => {
    notifyAlive(A, USN.A);
    vi.setSystemTime(new Date("2026-09-28T10:10:01.000Z")); // 刚过窗口
    expect(await scan([])).toEqual([]);
  });

  it("窗口内(9 分 59 秒)仍然算活设备,不会被剔除", async () => {
    notifyAlive(A, USN.A);
    vi.setSystemTime(new Date("2026-09-28T10:09:59.000Z"));
    expect((await scan([])).map((d: any) => d.id)).toEqual(["a-a-a-a-a"]);
  });
});

describe("discoverDlnaDevices:加入组播组失败", () => {
  it("addMembership 抛错 → 监听器不得崩,后续扫描照常进行", async () => {
    // 容器 / 多网卡环境下 EADDRNOTAVAIL 是常态;这里一旦往外冒,整个实时的
    // SSDP 监听就死了(设备上线不再被即时感知),只能等下一轮周期扫描才发现。
    const devices = await scan([A]);
    expect(devices.map((d: any) => d.id)).toContain("a-a-a-a-a");
  });
});

describe("discoverDlnaDevices:订阅者异常不影响扫描", () => {
  it("alive 事件订阅者抛错 → 广播不被打断(订阅者是可选的,不是关键路径)", async () => {
    // 用独立 LOCATION:这条考的是「订阅者抛错不影响其他订阅者」,不该和别的用例
    // 抢同一把去抖锁(见 beforeEach 里 clearAliveEmit 的注释)。
    const seen: any[] = [];
    const ok = (e: any) => seen.push(e);
    const bad = () => { throw new Error("订阅者炸了"); };
    onSsdpEvent(ok);
    onSsdpEvent(bad);
    onSsdpEvent(ok);

    let threw: any = null;
    try {
      notifyAlive(A, USN.A);
      await scan([A]);
    } catch (e) { threw = e; }
    // 抛错的订阅者不能把事件循环带崩,后面的订阅者照常收到
    expect(threw).toBeNull();
    expect(seen.filter((e) => e.type === "alive")).toHaveLength(1);
  });
});
