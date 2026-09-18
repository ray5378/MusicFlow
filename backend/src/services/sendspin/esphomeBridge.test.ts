// ESPHome 6053 桥接:纯逻辑回归锁(不建立真实连接)。
//
// 这里锁住的都是**实测得出的硬约束**,改坏了会在真机上直接表现为连不上或被踢:
//   - MediaPlayerState 枚举映射(api.proto,真机实测 state=2 == PLAYING);
//   - PSK 不得外泄到任何对外出口;
//   - 没填密钥的设备不得建连接(否则白占设备 max_connections slot);
//   - 密钥是**每台设备各自一把**,不是全局共用(改回全局 = 多台只有一台连得上)。
import { describe, it, expect, beforeEach } from "vitest";
import {
  esphomeBridge,
  mediaPlayerStateName,
  probeEsphome,
  ESPHOME_API_PORT,
} from "./esphomeBridge.js";

/** TEST-NET 地址(不可路由):spawn 后 connect 必然失败,但不会真的影响局域网。 */
const H1 = "192.0.2.10";
const H2 = "192.0.2.11";
const KEY_A = "A".repeat(44);
const KEY_B = "B".repeat(44);

describe("ESPHome bridge (per-device psk)", () => {
  beforeEach(() => {
    esphomeBridge.stop();
  });

  it("MediaPlayerState 映射与 api.proto 一致(2 == PLAYING)", () => {
    expect(mediaPlayerStateName(0)).toBe("NONE");
    expect(mediaPlayerStateName(1)).toBe("IDLE");
    expect(mediaPlayerStateName(2)).toBe("PLAYING");
    expect(mediaPlayerStateName(3)).toBe("PAUSED");
    expect(mediaPlayerStateName(4)).toBe("ANNOUNCING");
    expect(mediaPlayerStateName(5)).toBe("OFF");
    expect(mediaPlayerStateName(6)).toBe("ON");
    // 未知枚举不要编造名字,原样带上数值便于排障
    expect(mediaPlayerStateName(99)).toBe("UNKNOWN(99)");
  });

  it("没填密钥 ⇒ 不建连接(不白占设备 slot)", () => {
    esphomeBridge.syncDevice(H1, "");
    expect(esphomeBridge.snapshot()).toEqual([]);
    // 空白串同样算没填(用户容易粘进空格)
    esphomeBridge.syncDevice(H1, "   ");
    expect(esphomeBridge.snapshot()).toEqual([]);
  });

  it("填了密钥 ⇒ 建连接,且快照带上 pskConfigured / port", () => {
    esphomeBridge.syncDevice(H1, KEY_A, 6054);
    const snap = esphomeBridge.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].host).toBe(H1);
    expect(snap[0].pskConfigured).toBe(true);
    expect(snap[0].port).toBe(6054);
  });

  it("关键:每台设备各用自己的密钥(不是全局共用一把)", () => {
    esphomeBridge.syncDevice(H1, KEY_A);
    esphomeBridge.syncDevice(H2, KEY_B);
    const snap = esphomeBridge.snapshot();
    expect(snap).toHaveLength(2);
    // 两台都得是「已配密钥」—— 若是全局一把,只有一台能连。
    expect(snap.every((d) => d.pskConfigured)).toBe(true);
    expect(snap.map((d) => d.host).sort()).toEqual([H1, H2].sort());
  });

  it("清空密钥 ⇒ 撤销该台(断开并移出),不影响其它台", () => {
    esphomeBridge.syncDevice(H1, KEY_A);
    esphomeBridge.syncDevice(H2, KEY_B);
    esphomeBridge.syncDevice(H1, "");
    const snap = esphomeBridge.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].host).toBe(H2);
  });

  it("同凭据重复 sync ⇒ 幂等,不会重复登记", () => {
    esphomeBridge.syncDevice(H1, KEY_A);
    esphomeBridge.syncDevice(H1, KEY_A);
    esphomeBridge.syncDevice(H1, KEY_A);
    expect(esphomeBridge.snapshot()).toHaveLength(1);
  });

  it("空 / 空白 host 被忽略", () => {
    esphomeBridge.syncDevice("", KEY_A);
    esphomeBridge.syncDevice("   ", KEY_A);
    expect(esphomeBridge.snapshot()).toEqual([]);
  });

  it("⚠️ 快照绝不携带 PSK(安全回归锁)", () => {
    esphomeBridge.syncDevice(H1, "SUPERSECRETKEY", 6053);
    const dumped = JSON.stringify(esphomeBridge.snapshot());
    expect(dumped).not.toContain("SUPERSECRETKEY");
    // 但必须如实回报「配了」—— 前端靠这个区分「没填」和「填了连不上」
    expect(esphomeBridge.snapshot()[0].pskConfigured).toBe(true);
  });

  it("端口:0 / 非法 → 回落 6053,合法自定义值保留", () => {
    esphomeBridge.syncDevice(H1, KEY_A, 0);
    expect(esphomeBridge.snapshot()[0].port).toBe(ESPHOME_API_PORT);
    esphomeBridge.syncDevice(H1, KEY_A, 999999);
    // 凭据变了会重建,端口非法 → 回落
    expect(esphomeBridge.snapshot()[0].port).toBe(ESPHOME_API_PORT);
    esphomeBridge.syncDevice(H1, KEY_A, 6054);
    expect(esphomeBridge.snapshot()[0].port).toBe(6054);
    expect(ESPHOME_API_PORT).toBe(6053);
  });

  it("syncAll:列表外的设备一律断开", () => {
    esphomeBridge.syncDevice(H1, KEY_A);
    esphomeBridge.syncDevice(H2, KEY_A);
    esphomeBridge.syncAll([{ host: H1, psk: KEY_A }]);
    const snap = esphomeBridge.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].host).toBe(H1);
  });

  it("setVolume / setMuted:没登记的设备 → no-bridge", () => {
    expect(esphomeBridge.setVolume(H1, 0.5).code).toBe("no-bridge");
    expect(esphomeBridge.setMuted(H1, true).code).toBe("no-bridge");
  });

  it("setVolume / setMuted:已登记但没连上 → not-connected(不假装成功)", () => {
    esphomeBridge.syncDevice(H1, KEY_A);
    // 192.0.2.x 不可路由,连接必然还没建立
    expect(esphomeBridge.snapshot()[0].connected).toBe(false);
    const v = esphomeBridge.setVolume(H1, 0.5);
    expect(v.ok).toBe(false);
    expect(v.code).toBe("not-connected");
    expect(esphomeBridge.setMuted(H1, true).code).toBe("not-connected");
  });

  it("mirroredVolume:没连上时返回 null(不编造音量)", () => {
    expect(esphomeBridge.mirroredVolume(H1)).toBeNull();
  });

  it("probeEsphome:缺 PSK / 缺 host 立即失败且**不发网络请求**", async () => {
    // 「测试连接」按钮最常见的两种误操作。这里必须快速返回明确的 errorCode,
    // 让前端能给出针对性提示,而不是让用户干等 10s 握手超时。
    const noPsk = await probeEsphome("192.0.2.1", "", 6053, 1000);
    expect(noPsk.ok).toBe(false);
    expect(noPsk.errorCode).toBe("no_psk");
    expect(noPsk.host).toBe("192.0.2.1");

    const noHost = await probeEsphome("", "somerealkey", 6053, 1000);
    expect(noHost.ok).toBe(false);
    expect(noHost.errorCode).toBe("no_host");

    // 空白串也要算缺省(用户容易粘进空格)
    expect((await probeEsphome("192.0.2.1", "   ", 6053, 1000)).errorCode).toBe("no_psk");
  });

  it("stop() 清空全部目标", () => {
    esphomeBridge.syncDevice(H1, KEY_A);
    esphomeBridge.syncDevice(H2, KEY_B);
    esphomeBridge.stop();
    expect(esphomeBridge.snapshot()).toEqual([]);
  });
});
