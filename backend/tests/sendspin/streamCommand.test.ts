// sendspin streamCommand 纯函数契约测试:
// seek 位置钳制 / 时钟收敛门 / stream 起始命令拼装。这些是 server.ts 命令处理
// 与 drift 聚合共用的判定口径,改错会直接表现为「拖动后跳回」或「多端不同步」。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import {
  clampPositionMs,
  clockConverged,
  driftAggregateGate,
  buildStreamStart,
  DEFAULT_CONVERGE_MS,
} from "../../src/services/sendspin/streamCommand.js";

describe("clampPositionMs: seek 位置必须落在 [0, duration]", () => {
  it("负数一律归零(客户端回传负值不能把播放位置推成负)", () => {
    expect(clampPositionMs(-5, 100_000)).toBe(0);
  });

  it("NaN / Infinity 视为无效请求 → 归零", () => {
    expect(clampPositionMs(Number.NaN, 100_000)).toBe(0);
    expect(clampPositionMs(Number.POSITIVE_INFINITY, 100_000)).toBe(0);
  });

  it("超过时长则钳到时长本身(不能 seek 到片尾之后)", () => {
    expect(clampPositionMs(200_000, 100_000)).toBe(100_000);
  });

  it("正常值向下取整(位置统一毫秒整数,避免浮点漂移)", () => {
    expect(clampPositionMs(12_345.9, 100_000)).toBe(12_345);
  });

  it("时长未知(非有限)时不钳上限,只钳下限", () => {
    expect(clampPositionMs(200_000, Number.NaN)).toBe(200_000);
    expect(clampPositionMs(-1, Number.NaN)).toBe(0);
  });
});

describe("clockConverged: 时钟收敛门", () => {
  it("默认阈值 3s 内算收敛", () => {
    expect(DEFAULT_CONVERGE_MS).toBe(3000);
    expect(clockConverged(2_999_000n)).toBe(true);
  });

  it("超出阈值不收敛", () => {
    expect(clockConverged(3_001_000n)).toBe(false);
  });

  it("按绝对值判定:负向偏移同样适用", () => {
    expect(clockConverged(-2_000_000n)).toBe(true);
    expect(clockConverged(-5_000_000n)).toBe(false);
  });

  it("阈值可覆写", () => {
    expect(clockConverged(5_000_000n, 10_000)).toBe(true);
    expect(clockConverged(5_000_000n, 1_000)).toBe(false);
  });
});

describe("driftAggregateGate: drift 聚合前要求全体收敛", () => {
  it("全部收敛才放行", () => {
    expect(driftAggregateGate([1_000n, -2_000_000n, 0n])).toBe(true);
  });

  it("任一未收敛即拦截(否则脏偏移会污染整组)", () => {
    expect(driftAggregateGate([1_000n, 9_000_000n])).toBe(false);
  });

  it("空集合视为通过(没有样本时不阻断)", () => {
    expect(driftAggregateGate([])).toBe(true);
  });
});

describe("buildStreamStart: 各 codec 的起始命令拼装", () => {
  it("pcm 必须带 containers/sample_rate/channels", () => {
    const out = buildStreamStart({ codec: "pcm", sampleRate: 44100, channels: 2, sendAheadMs: 120.4 });
    expect(out.type).toBe("server/command.stream.pcm");
    expect(out.payload).toMatchObject({
      codec: "pcm",
      send_ahead: 120,
      timestamp: 0,
      containers: ["f32le"],
      sample_rate: 44100,
      channels: 2,
    });
  });

  it("flac 只带 containers,不带 pcm 的采样率字段", () => {
    const out = buildStreamStart({ codec: "flac", sampleRate: 48000, channels: 2, sendAheadMs: 0 });
    expect(out.type).toBe("server/command.stream.flac");
    expect(out.payload.containers).toEqual(["flac"]);
    expect(out.payload.sample_rate).toBeUndefined();
  });

  it("opus 是裸包:不得出现 containers 字段", () => {
    const out = buildStreamStart({ codec: "opus", sampleRate: 48000, channels: 2, sendAheadMs: 100 });
    expect(out.type).toBe("server/command.stream.opus");
    expect(out.payload.containers).toBeUndefined();
    expect(Object.keys(out.payload).sort()).toEqual(["codec", "send_ahead", "timestamp"]);
  });

  it("未知 codec 只保留公共字段(不臆造容器)", () => {
    const out = buildStreamStart({ codec: "aac", sampleRate: 44100, channels: 2, sendAheadMs: 50 });
    expect(out.type).toBe("server/command.stream.aac");
    expect(out.payload).toEqual({ codec: "aac", send_ahead: 50, timestamp: 0 });
  });
});
