// services/dlna/control.ts —— `autoDetectBaseUrl` 的网卡选择。
//
// 为什么值得单独钉:内部触发的投屏(自动切歌 / 卡死重试 / 重启续播)**没有 HTTP 上下文**,
// 拿不到请求 Host 头,只能自动探测本机地址。探测结果一旦落到 docker0 / 0.0.0.0,
// 设备拉不到流 ⇒ 乐观窗口超时 ⇒ stalled 重播 ⇒ 无限重投(源码注释里那次事故)。
// 这段逻辑依赖 `os.networkInterfaces()`,真机上拿不到想要的组合 ⇒ 必须换掉 os 假体。
import "../plugins/_env.js";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const IF = vi.hoisted(() => ({ interfaces: {} as Record<string, any[]> }));

// 只替换 `networkInterfaces`,其余成员原样透出 —— os 还被测试环境自己用着(tmpdir 等)。
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, default: { ...actual, networkInterfaces: () => IF.interfaces } };
});

import { getEffectiveBaseUrl } from "../../src/services/dlna/control.js";

const PORT_PREV = process.env.PORT;
const iface = (address: string) => [{ family: "IPv4", internal: false, address }];
const loopbackIface = (address: string) => [{ family: "IPv4", internal: true, address }];

beforeEach(() => {
  IF.interfaces = {};
  // 清掉这两条优先级更高的来源,才是纯粹的"自动探测"路径。
  delete process.env.DLNA_BASE_URL;
  process.env.PORT = "46401";
});

describe("autoDetectBaseUrl:选哪张网卡 = 设备能不能拉到流", () => {
  it("有 docker / veth / tailscale 时,优先真实网卡地址", () => {
    IF.interfaces = {
      docker0: iface("172.17.0.1"),
      "br-1a2b": iface("172.18.0.1"),
      veth9f1: iface("172.19.0.1"),
      tailscale0: iface("100.64.0.7"),
      eth0: iface("192.168.3.77"),
    };
    expect(getEffectiveBaseUrl()).toBe("http://192.168.3.77:46401");
  });

  it("只剩容器桥接网段时也要给出地址(不能因为没有干净网卡就整体失败)", () => {
    // 这一条是在锁 `candidates.find(...) || candidates[0]`:找不到"干净"网卡时
    // 仍然要用第一个候选,否则下面的 `if (!pick)` 会落成不可达的 0.0.0.0。
    IF.interfaces = { docker0: iface("172.17.0.1"), "br-x": iface("172.18.0.1") };
    expect(getEffectiveBaseUrl()).toBe("http://172.17.0.1:46401");
  });

  it("一张可用网卡都没有 → 回落到 http://0.0.0.0:$PORT(只留回环也不算)", () => {
    IF.interfaces = { lo: loopbackIface("127.0.0.1") };
    const base = getEffectiveBaseUrl();
    expect(base).toBe("http://0.0.0.0:46401");
    // 这条回落在真机上意味着设备必然拉不到流 —— 保留断言以便在 Graylog 里一眼认出
    // 它已经是"尽力而为"的最后一步,而不是一条正常路径。
    expect(base).toContain("0.0.0.0");
  });

  it("端口跟随 PORT 环境变量(服务起在非默认端口时回环地址要跟着变)", () => {
    IF.interfaces = { eth0: iface("192.168.3.77") };
    process.env.PORT = "51234";
    expect(getEffectiveBaseUrl()).toBe("http://192.168.3.77:51234");
  });
});

// PORT 是本文件的用例自己改的,跑完必须还原,避免影响同进程后续加载的模块。
afterAll(() => {
  process.env.PORT = PORT_PREV ?? "";
  if (PORT_PREV === undefined) delete process.env.PORT;
});
