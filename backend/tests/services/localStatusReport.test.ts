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

  it("STOPPED 清空 songId —— 客户端停止时根本不发 songId 字段,不能沿用上一首", () => {
    const pm = getPeerManager();
    const id = "local:u1:stop-clear-song";
    // 先播起来,账本里留下曲目。
    pm.reportLocalStatus(id, {
      state: "PLAYING", position: 12, duration: 200, songId: "s-old",
    });
    expect(pm.getLocalStatusReport(id)?.songId).toBe("s-old");
    // 客户端停止:只报 state —— 见客户端 _pushLocalStatus,songId 为空时整个字段不发。
    pm.reportLocalStatus(id, { state: "STOPPED" });
    const read = pm.getLocalStatusReport(id);
    expect(read?.state).toBe("STOPPED");
    // 回归点:字段级合并若沿用旧值,已停止的端会在 /status 里永远挂着上一首,
    // 对端据此刷新封面/歌词,表现为「这台还在播」。且客户端每 4s 续报,
    // 30s TTL 永不到期 —— 只能靠这里显式清空。
    expect(read?.songId).toBeUndefined();
  });

  it("STOPPED 只清曲目,不整条作废(音量/时长仍沿用)", () => {
    const pm = getPeerManager();
    const id = "local:u1:stop-keep-volume";
    pm.reportLocalStatus(id, {
      state: "PLAYING", position: 30, duration: 180, volume: 40, songId: "s-1",
    });
    pm.reportLocalStatus(id, { state: "STOPPED" });
    const read = pm.getLocalStatusReport(id);
    expect(read?.volume).toBe(40);
    expect(read?.duration).toBe(180);
    expect(read?.songId).toBeUndefined();
  });

  it("PAUSED_PLAYBACK 保留 songId(暂停=曲目没变,与 STOPPED 区别对待)", () => {
    const pm = getPeerManager();
    const id = "local:u1:paused-keep-song";
    pm.reportLocalStatus(id, {
      state: "PLAYING", position: 8, duration: 100, songId: "s-keep",
    });
    pm.reportLocalStatus(id, { state: "PAUSED_PLAYBACK" });
    expect(pm.getLocalStatusReport(id)?.songId).toBe("s-keep");
  });

  it("clearLocalStatusReport 丢弃整条上报 —— 流转/销毁收尾后 /status 只回队列快照", () => {
    const pm = getPeerManager();
    const id = "local:u1:clear-report";
    pm.reportLocalStatus(id, {
      state: "PLAYING", position: 9, duration: 90, songId: "s-gone",
    });
    expect(pm.getLocalStatusReport(id)).toBeTruthy();
    pm.clearLocalStatusReport(id);
    expect(pm.getLocalStatusReport(id)).toBeUndefined();
    // 幂等:重复清 / 清一个从没上报过的端,都不报错。
    expect(() => pm.clearLocalStatusReport(id)).not.toThrow();
    expect(() => pm.clearLocalStatusReport("local:u1:never-reported")).not.toThrow();
  });
});
