// 锁死对象:`services/dlna/control.ts` 的 `isDeviceKnown` 与它守的那条纪律 ——
// **「设备真的停了」与「我还没发现它」必须分开**。
//
// 为什么必须有这组测试:设备不在发现缓存时 `getDeviceStatus` 的早退分支会**冒充 STOPPED**
// (`state=STOPPED pos=0`)。启动 / 重新发现窗口期里 tracker 会把它读成"设备真的停了",
// 连续 2 次判卡死后**放行切歌**(真机复现:容器重启后 35s,DLNA 队列凭空少一首、位置归零)。
// 这个失效形态只在"重启 + 设备尚未被发现"的窄窗口出现,手测极难稳定复现,故用单测钉住判据。
//
// 与 sendspin 侧 `unavailable` 是同一条纪律的两端:那边管"RPC 超时不冒充 IDLE",
// 这边管"没发现不冒充 STOPPED"。
import { describe, it, expect } from "vitest";
import { isDeviceKnown, createDlnaProtocolPlayer } from "../../src/services/dlna/control.js";

/** 只造判定要用的两个字段,其余字段与本测试无关。 */
const dev = (id: string, avTransportUrl?: string) => ({ id, avTransportUrl } as any);

describe("isDeviceKnown:区分「设备真停了」与「还没发现它」", () => {
  it("不在发现缓存 → false(此时 getDeviceStatus 会冒充 STOPPED)", () => {
    expect(isDeviceKnown("unknown", [])).toBe(false);
  });

  it("在缓存且有 AVTransport 地址 → true", () => {
    expect(isDeviceKnown("d1", [dev("d1", "http://192.168.10.30:49152/upnp/control/AVTransport")])).toBe(true);
  });

  it("在缓存但缺 AVTransport 地址 → false(与 getDeviceStatus 冒充 STOPPED 的判据逐字一致)", () => {
    expect(isDeviceKnown("d1", [dev("d1", undefined)])).toBe(false);
  });

  it("空的 AVTransport 地址也算未知 —— 假值不能当真", () => {
    expect(isDeviceKnown("d1", [dev("d1", "")])).toBe(false);
  });

  it("只看目标设备:别台设备在线不能把本机读成已知", () => {
    expect(isDeviceKnown("d1", [dev("d2", "http://x/avt")])).toBe(false);
  });
});

describe("DLNA pollState:读不到真实状态时标 unavailable", () => {
  // 未发现的设备走 `getDeviceStatus` 的早退分支(不发 SOAP,故本用例不碰网络),
  // 读数恒为 STOPPED pos=0。修好后必须带上 unavailable,QueueController 才会
  // 不喂 tracker、不计数,等设备重新发现后走恢复续播。
  it("设备未在发现缓存 → unavailable=true,且状态仍是设备侧早退给的 STOPPED", async () => {
    const player = createDlnaProtocolPlayer("never-discovered-device");
    const st = await player.pollState();
    expect(st.unavailable).toBe(true);
    // 不改动读数本身(仍透传 STOPPED),只加"这条读数不可信"的标记。
    expect(st.position).toBe(0);
  });

  it("isAvailable 与 pollState 的 unavailable 取自不同判据,不应被混为一谈", () => {
    const player = createDlnaProtocolPlayer("never-discovered-device");
    // isDeviceAvailable 对未知设备**乐观**返回 true(它服务"要不要重投/续播"),
    // 这与 pollState 的 unavailable(服务"读数可不可信")必须允许同时成立。
    expect(player.isAvailable!()).toBe(true);
  });
});
