// MUST be the first import: redirects DATA_DIR before the backend opens SQLite.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import { _resetSettingsCacheForTest } from "../../src/services/settings.js";
import {
  _resetPlaybackSpeedCacheForTest,
  bareSpeedId,
  getPlaybackSpeed,
  setPlaybackSpeed,
} from "../../src/services/player/playbackSpeed.js";
import {
  clearFlowProgress,
  flowRelativeContentSec,
  getFlowProgress,
  setFlowProgress,
} from "../../src/services/player/flowProgress.js";

// 4.14.3 倍速的回归守卫：
//   · 倍速是「播放器偏好」，按裸 id 持久化到 settings，重启/缓存清理后仍能回读；
//   · flow 连续流的「输出流秒 → 当前曲内容秒」换算（含稀疏/倍速/过期）。

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  _resetPlaybackSpeedCacheForTest();
  _resetSettingsCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("playbackSpeed 注册表", () => {
  it("缺省 1x；写入后带前缀/裸 id 读到同一值", () => {
    expect(getPlaybackSpeed("dlna:reg-dev-1")).toBe(1);
    expect(setPlaybackSpeed("dlna:reg-dev-1", 1.5)).toBe(1.5);
    expect(getPlaybackSpeed("reg-dev-1")).toBe(1.5);
    expect(getPlaybackSpeed("dlna:reg-dev-1")).toBe(1.5);
  });

  it("持久化：清内存缓存后从 settings 回读", () => {
    setPlaybackSpeed("group:reg-dev-2", 0.75);
    _resetPlaybackSpeedCacheForTest();
    _resetSettingsCacheForTest();
    expect(getPlaybackSpeed("group:reg-dev-2")).toBe(0.75);
  });

  it("非法值按最近白名单档位收敛后再持久化", () => {
    expect(setPlaybackSpeed("airplay:reg-dev-3", 0.9)).toBe(1);
    _resetPlaybackSpeedCacheForTest();
    _resetSettingsCacheForTest();
    expect(getPlaybackSpeed("airplay:reg-dev-3")).toBe(1);

    expect(setPlaybackSpeed("sendspin:reg-dev-4", 9)).toBe(2);
    _resetPlaybackSpeedCacheForTest();
    _resetSettingsCacheForTest();
    expect(getPlaybackSpeed("sendspin:reg-dev-4")).toBe(2);
  });

  it("四类协议前缀都剥成同一命名空间", () => {
    expect(bareSpeedId("dlna:x")).toBe("x");
    expect(bareSpeedId("group:x")).toBe("x");
    expect(bareSpeedId("airplay:x")).toBe("x");
    expect(bareSpeedId("sendspin:x")).toBe("x");
  });
});

describe("flow 进度换算", () => {
  it("按当前曲起点减出相对内容秒", () => {
    const p = { starts: [0, 100, 220], startIndex: 0, speed: 1 };
    expect(flowRelativeContentSec(p, 50)).toBe(50);
    expect(flowRelativeContentSec(p, 100)).toBe(0);
    expect(flowRelativeContentSec(p, 150)).toBe(50);
    expect(flowRelativeContentSec(p, 250)).toBe(30);
  });

  it("倍速：starts 是输出流秒，换算时乘 speed", () => {
    const p = { starts: [0, 40, 80], startIndex: 0, speed: 1.5 };
    expect(flowRelativeContentSec(p, 90)).toBe(30);
    expect(flowRelativeContentSec(p, 60)).toBe(0);
  });

  it("稀疏 starts（跳过的曲目缺失）跳过空洞，不误判当前曲", () => {
    const sparse: number[] = [];
    sparse[0] = 0;
    sparse[2] = 220;
    const p = { starts: sparse, startIndex: 0, speed: 1 };
    expect(flowRelativeContentSec(p, 150)).toBe(150);
    expect(flowRelativeContentSec(p, 250)).toBe(30);
  });

  it("无边界信息返回 null（调用方保持原值）", () => {
    expect(flowRelativeContentSec({ starts: [], startIndex: 0, speed: 1 }, 30)).toBeNull();
    expect(flowRelativeContentSec({ starts: [undefined as unknown as number], startIndex: 0, speed: 1 }, 30)).toBeNull();
  });

  it("登记/读取/清除；超过 30s 未更新视为失效", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T00:00:00.000Z"));
    setFlowProgress("flow-dev-1", { starts: [0, 60], startIndex: 0, speed: 1 });
    expect(getFlowProgress("flow-dev-1")?.starts).toEqual([0, 60]);

    vi.setSystemTime(new Date("2026-11-14T00:00:30.000Z"));
    expect(getFlowProgress("flow-dev-1")).not.toBeNull();

    vi.setSystemTime(new Date("2026-11-14T00:00:30.001Z"));
    expect(getFlowProgress("flow-dev-1")).toBeNull();
    // 过期后已删除，再取仍为 null。
    expect(getFlowProgress("flow-dev-1")).toBeNull();

    setFlowProgress("flow-dev-2", { starts: [0], startIndex: 0, speed: 1 });
    clearFlowProgress("flow-dev-2");
    expect(getFlowProgress("flow-dev-2")).toBeNull();
  });
});
