import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getLogLevel: vi.fn(() => "info" as string),
  getLogLevelSource: vi.fn(() => "default" as string),
  isLogLevel: vi.fn((v: string) => ["debug", "info", "warn", "error"].includes(v)),
  setLogLevel: vi.fn(),
  LOG_LEVELS: ["debug", "info", "warn", "error"] as readonly string[],
}));

vi.mock("../../src/services/settings.js", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));
vi.mock("../../src/utils/logger.js", () => ({
  getLogLevel: mocks.getLogLevel,
  getLogLevelSource: mocks.getLogLevelSource,
  isLogLevel: mocks.isLogLevel,
  setLogLevel: mocks.setLogLevel,
  LOG_LEVELS: mocks.LOG_LEVELS,
}));

import {
  LOG_LEVEL_SETTING_KEY,
  getSettingLogLevel,
  logLevelSnapshot,
  applyLogLevelFromSettings,
  saveLogLevel,
} from "../../src/services/logSettings.js";

// 日志等级运行时可调：设置表真源 > env > 默认，写库 + 注入内存 + 同步子进程 env。
describe("logSettings（运行时日志等级）", () => {
  const savedEnv = process.env.LOG_LEVEL;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isLogLevel.mockImplementation((v: string) => ["debug", "info", "warn", "error"].includes(v));
    mocks.getLogLevel.mockReturnValue("info");
    mocks.getLogLevelSource.mockReturnValue("default");
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedEnv;
  });

  it("getSettingLogLevel：设置值 trim/lower，非法返回 null", () => {
    mocks.getSetting.mockReturnValue("  DEBUG ");
    expect(getSettingLogLevel()).toBe("debug");
    expect(mocks.getSetting).toHaveBeenCalledWith(LOG_LEVEL_SETTING_KEY, "");
    mocks.getSetting.mockReturnValue("verbose");
    expect(getSettingLogLevel()).toBeNull();
  });

  it("logLevelSnapshot：汇总 level/source/envLevel/levels/settingLevel", () => {
    process.env.LOG_LEVEL = "warn";
    mocks.getSetting.mockReturnValue("debug");
    mocks.getLogLevel.mockReturnValue("debug");
    mocks.getLogLevelSource.mockReturnValue("setting");
    const s = logLevelSnapshot();
    expect(s.level).toBe("debug");
    expect(s.source).toBe("setting");
    expect(s.envLevel).toBe("warn");
    expect(s.settingLevel).toBe("debug");
    expect(s.levels).toEqual(["debug", "info", "warn", "error"]);
  });

  it("logLevelSnapshot：env 非法 → envLevel=null", () => {
    process.env.LOG_LEVEL = "bogus";
    mocks.getSetting.mockReturnValue("");
    const s = logLevelSnapshot();
    expect(s.envLevel).toBeNull();
    expect(s.settingLevel).toBeNull();
  });

  it("applyLogLevelFromSettings：有设置 → 注入 logger 并同步写 env", () => {
    mocks.getSetting.mockReturnValue("debug");
    mocks.getLogLevel.mockReturnValue("debug");
    delete process.env.LOG_LEVEL;
    const lv = applyLogLevelFromSettings();
    expect(mocks.setLogLevel).toHaveBeenCalledWith("debug");
    expect(process.env.LOG_LEVEL).toBe("debug");
    expect(lv).toBe("debug");
  });

  it("applyLogLevelFromSettings：无设置 → setLogLevel(null)、env 不动", () => {
    mocks.getSetting.mockReturnValue("");
    process.env.LOG_LEVEL = "info";
    applyLogLevelFromSettings();
    expect(mocks.setLogLevel).toHaveBeenCalledWith(null);
    expect(process.env.LOG_LEVEL).toBe("info"); // 保持原有 env
  });

  it("saveLogLevel：写库 + 注入 + env 同步 + 快照回读", () => {
    mocks.getSetting.mockReturnValue("error");
    mocks.getLogLevel.mockReturnValue("error");
    mocks.getLogLevelSource.mockReturnValue("setting");
    const s = saveLogLevel("error");
    expect(mocks.setSetting).toHaveBeenCalledWith(LOG_LEVEL_SETTING_KEY, "error");
    expect(mocks.setLogLevel).toHaveBeenCalledWith("error");
    expect(process.env.LOG_LEVEL).toBe("error");
    expect(s.level).toBe("error");
  });
});
