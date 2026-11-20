// 服务端自我重启闸的回归锁（2026-11-20）
//
// 客户端「设置 → 维护 → 重启服务」最终落到 requestRestart。这里锁三件事：
//  ① 没注册处理器时不能假装能重启（否则客户端会傻等一个永不到来的重启）；
//  ② 受理后必须"先回响应、再退出"（延迟调用 handler），不能同步退；
//  ③ 5s 冷却 —— 连点/重试只能退一次，否则会连续经历两轮启动。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRestartAvailable,
  requestRestart,
  setRestartHandler,
} from "../../src/services/system/restartControl.js";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("restartControl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setRestartHandler(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    setRestartHandler(null);
  });

  it("未注册处理器 → 拒绝（不假装能重启）", () => {
    expect(isRestartAvailable()).toBe(false);
    expect(requestRestart("test")).toBe(false);
  });

  it("注册后受理，且延迟 500ms 才调用处理器（先让 HTTP 响应飞回去）", () => {
    const fn = vi.fn();
    setRestartHandler(fn);
    expect(isRestartAvailable()).toBe(true);
    expect(requestRestart("api:admin")).toBe(true);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("api:admin");
  });

  it("★5s 冷却内连点只退一次", () => {
    const fn = vi.fn();
    setRestartHandler(fn);
    expect(requestRestart("a")).toBe(true);
    vi.advanceTimersByTime(600);
    expect(requestRestart("b")).toBe(true); // 受理但被冷却忽略
    vi.advanceTimersByTime(600);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("冷却过后可再次受理", () => {
    const fn = vi.fn();
    setRestartHandler(fn);
    requestRestart("a");
    vi.advanceTimersByTime(6_000);
    expect(requestRestart("b")).toBe(true);
    vi.advanceTimersByTime(600);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("路由与接线契约", () => {
  it("GET 探测与 POST 执行同路径，且都挂管理员鉴权", () => {
    const s = read("routes/api/system.ts");
    expect(s).toContain('app.get("/v1/system/restart", adminMiddleware');
    expect(s).toContain('app.post("/v1/system/restart", adminMiddleware');
    // 执行端点必须真的把请求交给闸，而不是直接本地 exit（那样无法回 202）
    expect(s).toContain("requestRestart(");
  });

  it("index.ts 把 gracefulShutdown 注入为重启处理器", () => {
    const s = read("index.ts");
    expect(s).toContain("setRestartHandler");
    expect(s).toContain('gracefulShutdown(reason)');
  });
});
