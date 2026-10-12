// 自动续批会话标记：set/get/clear + 双流隔离 + 落库可查（重启后调度器可读）。
import "../plugins/_env.js";

import { beforeEach, describe, expect, it } from "vitest";
import { sqlite } from "../../src/db/index.js";
import { _resetSettingsCacheForTest } from "../../src/services/settings.js";
import { isAutoSessionActive, setAutoSession } from "../../src/services/fetch/autoSession.js";

describe("autoSession — 续批会话标记", () => {
  beforeEach(() => {
    _resetSettingsCacheForTest();
    sqlite.prepare("DELETE FROM settings WHERE key LIKE 'fetch.%.session'").run();
    _resetSettingsCacheForTest();
  });

  it("默认未激活（无标记行）", () => {
    expect(isAutoSessionActive("library")).toBe(false);
    expect(isAutoSessionActive("upgrade")).toBe(false);
  });

  it("set(true) → 激活；set(false) → 清除", () => {
    setAutoSession("library", true);
    expect(isAutoSessionActive("library")).toBe(true);
    setAutoSession("library", false);
    expect(isAutoSessionActive("library")).toBe(false);
  });

  it("双流隔离：library 激活不影响 upgrade，反之亦然", () => {
    setAutoSession("library", true);
    expect(isAutoSessionActive("upgrade")).toBe(false);
    setAutoSession("upgrade", true);
    expect(isAutoSessionActive("library")).toBe(true);
    expect(isAutoSessionActive("upgrade")).toBe(true);
  });

  it("标记落 settings 表（换进程/重启后仍可读，调度器据此恢复）", () => {
    setAutoSession("upgrade", true);
    const row = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'fetch.upgrade.auto.session'")
      .get() as { value: string };
    expect(row.value).toBe("1");
    setAutoSession("upgrade", false);
    const row2 = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'fetch.upgrade.auto.session'")
      .get() as { value: string };
    expect(row2.value).toBe("0");
  });
});
