// ==================== realigned 日志分级(降噪 rider) ====================
//
// 钉死:无动作(insert/drop/skip 全 0)的恒定漂移 → DEBUG(稳态噪声,实测
// 2.1 万行/20min 低功耗机白烧 CPU);动作型对齐(补静音/裁头/跳段任一 >0)→ WARN。
import { describe, expect, it } from "vitest";

import { realignedLogLevel } from "../../src/services/airplay/bridgeSession.js";

describe("realignedLogLevel", () => {
  it("无动作(insert/drop/skip 全 0)→ DEBUG(稳态噪声降噪)", () => {
    expect(realignedLogLevel({ insertFrames: 0, dropFrames: 0, skipFrames: 0 })).toBe("debug");
  });

  it("动作型:补静音/裁头/跳段任一 >0 → WARN", () => {
    expect(realignedLogLevel({ insertFrames: 5, dropFrames: 0, skipFrames: 0 })).toBe("warn");
    expect(realignedLogLevel({ insertFrames: 0, dropFrames: 5, skipFrames: 0 })).toBe("warn");
    expect(realignedLogLevel({ insertFrames: 0, dropFrames: 0, skipFrames: 5 })).toBe("warn");
    expect(realignedLogLevel({ insertFrames: 1, dropFrames: 1, skipFrames: 1 })).toBe("warn");
  });
});
