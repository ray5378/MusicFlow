import { describe, it, expect, afterEach } from "vitest";
import { isRendererForkMode } from "../../src/services/rendererHost/mode.js";
import { DEFAULT_AIRPLAY_VOLUME } from "../../src/services/airplay/volumeDefault.js";

// 常驻渲染器 fork 模式判定（leaf 零依赖）。注意 vitest 下 process.env.VITEST 已置位 → 永不真 fork。
describe("isRendererForkMode", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("单测环境永不 fork（VITEST 优先于 forkEnv）", () => {
    process.env.VITEST = "1";
    expect(isRendererForkMode({ childEnv: "X_CHILD", forkEnv: "X_FORK", defaultFork: true })).toBe(false);
  });

  it("非单测：childEnv=1 一律不 fork（最高优先）", () => {
    delete process.env.VITEST;
    process.env.X_CHILD = "1";
    process.env.X_FORK = "1";
    expect(isRendererForkMode({ childEnv: "X_CHILD", inprocEnv: "X_INPROC", forkEnv: "X_FORK", defaultFork: false })).toBe(false);
  });

  it("非单测：inprocEnv=1 不 fork", () => {
    delete process.env.VITEST;
    delete process.env.X_CHILD;
    process.env.X_INPROC = "1";
    expect(isRendererForkMode({ childEnv: "X_CHILD", inprocEnv: "X_INPROC", forkEnv: "X_FORK", defaultFork: true })).toBe(false);
  });

  it("非单测：forkEnv=1 开启 fork", () => {
    delete process.env.VITEST;
    delete process.env.X_CHILD;
    delete process.env.X_INPROC;
    process.env.X_FORK = "1";
    expect(isRendererForkMode({ childEnv: "X_CHILD", forkEnv: "X_FORK", defaultFork: false })).toBe(true);
  });

  it("非单测：无开关时用 defaultFork", () => {
    delete process.env.VITEST;
    delete process.env.X_CHILD;
    delete process.env.X_INPROC;
    delete process.env.X_FORK;
    expect(isRendererForkMode({ childEnv: "X_CHILD", defaultFork: true })).toBe(true);
    expect(isRendererForkMode({ childEnv: "X_CHILD", defaultFork: false })).toBe(false);
  });
});

describe("DEFAULT_AIRPLAY_VOLUME", () => {
  it("缺省音量恒为 80（主/子进程共用同一常量）", () => {
    expect(DEFAULT_AIRPLAY_VOLUME).toBe(80);
  });
});
