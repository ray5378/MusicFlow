// A 类回归守卫(2026-09-29 SENDSPIN 心跳修复)。
//
// 事故:此前心跳「1 次未回 PONG 即 ws.terminate() 摘牌」,设备解码/I2S 抖动期
// 漏回一帧 PONG 就被杀 → 服务端每 ~70s 循环 terminate→重拨,设备播 ~7s 即无声。
// 修复:容忍单次抖动,连续 HEARTBEAT_MAX_MISSES(=3,≈30s)次未回 PONG 才摘牌,
// 对齐文档 §2.9 容忍精神。本文件把「连续 3 次才杀」固化成确定性门禁。
//
// 端到端行为(真实连接 + 漏回 PONG → 约 40s 才 terminate)已在 240 真机验证,
// 此处用纯函数 + 常量守卫锁定核心状态机,CI 确定性、无 flaky。
import { describe, it, expect } from "vitest";
import { SendspinConnection, nextHeartbeatState } from "./server.js";

describe("心跳状态机 nextHeartbeatState(纯函数)", () => {
  it("alive=true → 发 PING,清零 misses,不摘牌", () => {
    expect(nextHeartbeatState(true, 0)).toEqual({ alive: false, misses: 0, terminate: false });
    // 即便之前已累计,一旦收到 PONG(alive=true)即重置。
    expect(nextHeartbeatState(true, 2)).toEqual({ alive: false, misses: 0, terminate: false });
  });

  it("连续未回 PONG 累计到 MAX_MISSES(=3)才摘牌,而非 1 次即杀", () => {
    // 修复前 MAX_MISSES=1:第 1 次未回即 terminate。修复后须容忍到阈值。
    expect(nextHeartbeatState(false, 0)).toEqual({ alive: false, misses: 1, terminate: false });
    expect(nextHeartbeatState(false, 1)).toEqual({ alive: false, misses: 2, terminate: false });
    // 第 3 次(达到 MAX_MISSES=3)才摘牌:
    expect(nextHeartbeatState(false, 2)).toEqual({ alive: false, misses: 3, terminate: true });
    // 越界(已超过)仍摘牌,不回弹:
    expect(nextHeartbeatState(false, 3)).toEqual({ alive: false, misses: 4, terminate: true });
  });

  it("中间挤出一帧 PONG 重置计数(容忍间歇性抖动)", () => {
    // 漏 2 次后回一帧 PONG → 计数归零,不再累计(抖动期挤出一帧即救活)。
    expect(nextHeartbeatState(true, 2)).toEqual({ alive: false, misses: 0, terminate: false });
  });

  it("守卫:HEARTBEAT_MAX_MISSES 必须是 3(不为 1,否则回到事故现场)", () => {
    expect(SendspinConnection.HEARTBEAT_MAX_MISSES).toBe(3);
  });

  it("守卫:nextHeartbeatState 的阈值严格等于 HEARTBEAT_MAX_MISSES", () => {
    // 把阈值当作变量代入,确认纯函数与常量同源(有人改常量须同步改逻辑)。
    const MAX = SendspinConnection.HEARTBEAT_MAX_MISSES;
    expect(nextHeartbeatState(false, MAX - 1)).toEqual({ alive: false, misses: MAX, terminate: true });
    expect(nextHeartbeatState(false, MAX - 2)).toEqual({ alive: false, misses: MAX - 1, terminate: false });
  });
});
