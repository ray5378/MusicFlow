// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { FLOW_DEFAULT_CODEC, FLOW_DEFAULT_SAMPLE_RATE, flowEncodeArgs } from "../../src/services/audio/flow.js";

// ==================== batch49 契约锁：flow 链的位深贯通 ====================
//
// 与 HTTP/DLNA 的 `resolveRequestAf` 不同，flow 是**连续混合流**（多曲交叉淡入
// 后重新编码），没有「源」可跟随 ⇒ `FlowEncodeRequest.targetBits` 是**必填**的
// 具体值，由调用方（`serveFlowQueue`）从 `resolveTargetBits(flowRateKey)` 裁决
// （自动档落 16）。
//
// 这条接线的静默失效方式很隐蔽：`flowEncodeArgs` 里原本写死 `targetBits: 16`，
// 于是「整组一键设置 24bit」在普通 HTTP/DLNA 链上生效、**在 flow 链上被吃掉**
// —— 用户听到的是同一台设备有时 24bit 有时 16bit，且不报任何错。
//
// 本文件锁「配置 → flow 编码命令」这一段（纯函数，无需起 ffmpeg）：
//   ① 16bit 目标 → `aresample=osf=s16:dither_method=triangular_hp`；
//   ② 24bit 目标 → **不降位**（24 就该走 f32→24bit，多挂一次降位才是回归）；
//   ③ 限制器恒在链首（先限幅**再**降位深 —— 反了会把抖动噪声算进天花板）；
//   ④ 两种位深给出的命令必须**不同**（写死 = 命令相同 = 用例转红）。
function encode(targetBits: number): string[] {
  return flowEncodeArgs({
    sampleRate: FLOW_DEFAULT_SAMPLE_RATE,
    channels: 2,
    targetBits,
    codec: FLOW_DEFAULT_CODEC,
  });
}

function afChain(args: string[]): string[] {
  const i = args.indexOf("-af");
  return i >= 0 ? args[i + 1].split(",") : [];
}

describe("flow 编码命令的位深接线（targetBits 必须真的贯通）", () => {
  it("16bit 目标 → osf=s16 + 三角高频抖动（降位深必须抖动，直接截断有相关失真）", () => {
    const af = afChain(encode(16)).join(",");
    expect(af).toContain("osf=s16");
    expect(af).toContain("dither_method=triangular_hp");
  });

  it("24bit 目标 → **不**降位（24 走 f32→24bit，多挂一次降位才是回归）", () => {
    const af = afChain(encode(24)).join(",");
    expect(af).not.toContain("osf=s16");
    expect(af).not.toContain("dither_method");
  });

  it("限制器恒在滤镜链**最前**（先限幅再降位深，反了会把抖动噪声算进天花板）", () => {
    for (const bits of [16, 24]) {
      const chain = afChain(encode(bits));
      expect(chain[0], `bits=${bits}`).toContain("alimiter");
    }
  });

  it("两种位深命令必须不同（写死 16 会让 flow 链上的 24bit 设置静默失效）", () => {
    expect(encode(16).join(" ")).not.toBe(encode(24).join(" "));
  });
});
