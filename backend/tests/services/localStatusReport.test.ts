// 本机实例「播放状态上报」账本(2026-09-15)。
//
// 背景:本机播放的传输状态权威在客户端本地播放器,服务端只有队列元数据。当**别的**
// 播放端(网页 / HA / 另一台客户端)切成遥控这台本机实例时,它靠轮询
// `GET /v1/peers/:peerId/status` 镜像进度条与播放按钮 —— 没有这份上报,对端只能读到
// 队列快照,进度条恒为 0、按钮恒显示「未播放」。
//
// 本文件锁住这份内存账本的语义:字段级合并、音量夹取、非 local 拒绝、TTL 过期。
//
// MUST be the first import: redirects DATA_DIR to an isolated temp dir.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { initDatabase } from "../../src/db/index.js";
import { getPeerManager } from "../../src/services/peer.js";

const SELF = "local:u1:app-bbb";

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("本机实例播放状态上报 PeerManager.reportLocalStatus", () => {
  it("记录一次完整上报,读回同值", () => {
    const pm = getPeerManager();
    const rep = pm.reportLocalStatus(SELF, {
      state: "PLAYING", position: 42.5, duration: 210, volume: 66, songId: "s-1",
    });
    expect(rep).toBeTruthy();
    const read = pm.getLocalStatusReport(SELF);
    expect(read?.state).toBe("PLAYING");
    expect(read?.position).toBe(42.5);
    expect(read?.duration).toBe(210);
    expect(read?.volume).toBe(66);
    expect(read?.songId).toBe("s-1");
  });

  it("字段级合并:未给的字段沿用上次(暂停时只报 state 不会把进度/曲目清掉)", () => {
    const pm = getPeerManager();
    const id = "local:u1:merge-1";
    pm.reportLocalStatus(id, { state: "PLAYING", position: 30, duration: 200, songId: "s-9", volume: 50 });
    pm.reportLocalStatus(id, { state: "PAUSED_PLAYBACK" });
    const read = pm.getLocalStatusReport(id);
    expect(read?.state).toBe("PAUSED_PLAYBACK");
    expect(read?.position).toBe(30);   // 未被清掉
    expect(read?.duration).toBe(200);
    expect(read?.songId).toBe("s-9");
    expect(read?.volume).toBe(50);
  });

  it("首次上报只给 state 时,数值字段落到安全缺省(0),不产生 NaN", () => {
    const pm = getPeerManager();
    const id = "local:u1:partial-1";
    pm.reportLocalStatus(id, { state: "STOPPED" });
    const read = pm.getLocalStatusReport(id);
    expect(read?.state).toBe("STOPPED");
    expect(read?.position).toBe(0);
    expect(read?.duration).toBe(0);
    expect(read?.volume).toBeUndefined();
    expect(read?.songId).toBeUndefined();
  });

  it("音量夹取到 0-100;非法数值(负数 position)不被采信", () => {
    const pm = getPeerManager();
    const id = "local:u1:clamp-1";
    pm.reportLocalStatus(id, { state: "PLAYING", volume: 250, position: 10 });
    expect(pm.getLocalStatusReport(id)?.volume).toBe(100);
    pm.reportLocalStatus(id, { volume: -20, position: -5 });
    const read = pm.getLocalStatusReport(id);
    expect(read?.volume).toBe(0);
    expect(read?.position).toBe(10); // 负数不采信 → 沿用上次
  });

  it("非 local 一律拒绝(投屏设备的状态由各自链路实时查询,不走这份账本)", () => {
    const pm = getPeerManager();
    expect(pm.reportLocalStatus("dlna:dev-1", { state: "PLAYING" })).toBeUndefined();
    expect(pm.reportLocalStatus("group:g-1", { state: "PLAYING" })).toBeUndefined();
    expect(pm.reportLocalStatus("sendspin:sp-1", { state: "PLAYING" })).toBeUndefined();
    expect(pm.reportLocalStatus("garbage", { state: "PLAYING" })).toBeUndefined();
    expect(pm.getLocalStatusReport("dlna:dev-1")).toBeUndefined();
  });

  it("上报过期(>30s)后读回 undefined —— 掉线端不会永远显示「播放中」", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
    const pm = getPeerManager();
    const id = "local:u1:ttl-1";
    pm.reportLocalStatus(id, { state: "PLAYING", position: 5, duration: 100 });
    expect(pm.getLocalStatusReport(id)?.state).toBe("PLAYING");
    // 29s:仍在窗口内
    vi.setSystemTime(new Date("2026-09-15T10:00:29Z"));
    expect(pm.getLocalStatusReport(id)).toBeTruthy();
    // 31s:过期
    vi.setSystemTime(new Date("2026-09-15T10:00:31Z"));
    expect(pm.getLocalStatusReport(id)).toBeUndefined();
  });
});
