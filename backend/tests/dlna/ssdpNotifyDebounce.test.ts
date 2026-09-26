// SSDP NOTIFY 解析 / alive 去抖语义契约测试（发现层一侧）。
//
// 这是「设备上线却很久不出现」的**根因所在**：去抖窗口何时被消耗、失败后如何放开。
// 旧语义：emit 前就把 60s 用掉且失败后不再放开 → 首次抓 description 失败（设备 HTTP
//         还没就绪）后，这一批通告全被吞掉，只能等主动扫描（旧 5 分钟）。
// 新语义：emit 前只做「同批占位」；control.ts 重试全失败时调 clearAliveEmit 放开窗口，
//         让设备随后的通告立刻能再触发一次。
import { describe, it, expect, beforeEach } from "vitest";

import {
  handleNotifyText,
  onSsdpEvent,
  clearAliveEmit,
} from "../../src/services/dlna/discovery.js";

const LOC = "http://192.168.10.30:49152/description.xml";

/** 真实设备一次上电会连发多条 NOTIFY（同一 LOCATION，NT 各不相同，毫秒级）。 */
function notify(nts: string, loc = LOC, nt = "urn:schemas-upnp-org:device:MediaRenderer:1"): string {
  return [
    "NOTIFY * HTTP/1.1",
    "HOST: 239.255.255.250:1900",
    `LOCATION: ${loc}`,
    `NT: ${nt}`,
    `NTS: ${nts}`,
    `USN: uuid:hv::${nt}`,
    "",
    "",
  ].join("\r\n");
}

let events: any[] = [];
onSsdpEvent((e) => events.push(e));

const aliveCount = () => events.filter((e) => e.type === "alive").length;

beforeEach(() => {
  events = [];
  clearAliveEmit(LOC); // 每个用例从「窗口干净」起跑
});

describe("SSDP NOTIFY → alive 去抖", () => {
  it("同一批通告（多条 NT + 随后的重申）只触发一次 alive", () => {
    handleNotifyText(notify("ssdp:alive"));
    handleNotifyText(notify("ssdp:alive", LOC, "upnp:rootdevice"));
    handleNotifyText(notify("ssdp:update", LOC, "uuid:hv"));
    handleNotifyText(notify("ssdp:alive", LOC, "urn:schemas-upnp-org:service:AVTransport:1"));

    expect(aliveCount()).toBe(1);
  });

  it("处理失败后放开去抖（clearAliveEmit）→ 下一批通告能立刻再触发", () => {
    handleNotifyText(notify("ssdp:alive"));
    expect(aliveCount()).toBe(1);

    // 去抖生效：60s 内的第二批被吞掉
    handleNotifyText(notify("ssdp:alive"));
    expect(aliveCount()).toBe(1);

    // control.ts 重试全失败 → 放开
    clearAliveEmit(LOC);

    handleNotifyText(notify("ssdp:alive"));
    expect(aliveCount()).toBe(2);
  });

  it("ssdp:byebye → 触发 byebye 事件，UDN 从 USN 提取", () => {
    handleNotifyText(notify("ssdp:byebye"));

    const bye = events.filter((e) => e.type === "byebye");
    expect(bye.length).toBe(1);
    expect(bye[0].udn).toBe("hv");
  });

  it("非 NOTIFY 报文 / 缺 LOCATION 的 NOTIFY 不产生任何事件", () => {
    handleNotifyText(`HTTP/1.1 200 OK\r\nLOCATION: ${LOC}\r\n\r\n`);
    handleNotifyText("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\n\r\n");
    handleNotifyText("");

    expect(events.length).toBe(0);
  });
});
