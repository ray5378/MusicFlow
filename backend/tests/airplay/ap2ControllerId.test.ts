// AP2 controller pairing id(getAirPlayControllerId)钉定用例。
//
// 为什么值得单独钉:HAP 长期凭据是 (**controller pairing id**, accessory) 绑定的 ——
// pairing id 一变,库里所有 hap_credentials 立刻失效(用户要被逼着逐台重新输入 PIN)。
// 所以这里钉三件事:
//   1. 首次生成 16 位大写 hex 并**写库**(重启后必须拿到同一个值);
//   2. 库里已有合法值 ⇒ 直接用,绝不重新生成;
//   3. 读/写 settings 抛异常 ⇒ **绝不向上抛**(设备列表/配对按钮不能因此 500)。
//
// MUST be the first import: 把 DATA_DIR 指到隔离临时目录(control.ts 链路会碰 DB)。
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, vi } from "vitest";

// settings 替身:一个内存键值表 + 可注入的抛错开关(真实实现在 services/settings.ts,
// 但这里要能精确制造「读/写抛异常」这条路径)。
const S = vi.hoisted(() => {
  let store: Record<string, string> = {};
  let throwOnRead = false;
  let throwOnWrite = false;
  return {
    get store() {
      return store;
    },
    reset() {
      store = {};
      throwOnRead = false;
      throwOnWrite = false;
    },
    setThrowOnRead(v: boolean) {
      throwOnRead = v;
    },
    setThrowOnWrite(v: boolean) {
      throwOnWrite = v;
    },
    getSetting: vi.fn((key: string, def = "") => {
      if (throwOnRead) throw new Error("settings 读失败(注入)");
      return store[key] ?? def;
    }),
    setSetting: vi.fn((key: string, value: string) => {
      if (throwOnWrite) throw new Error("settings 写失败(注入)");
      store[key] = value;
    }),
  };
});

vi.mock("../../src/services/settings.js", () => ({
  getSetting: S.getSetting,
  setSetting: S.setSetting,
  getSettingBool: (key: string, def: boolean) => (S.store[key] ?? String(def)) === "true",
  _resetSettingsCacheForTest: () => undefined,
}));

import {
  AP2_CONTROLLER_ID_SETTING_KEY,
  _resetAirPlayControllerIdCacheForTest,
  getAirPlayControllerId,
} from "../../src/services/airplay/control.js";

const HEX16_UPPER = /^[0-9A-F]{16}$/;

beforeEach(() => {
  S.reset();
  S.getSetting.mockClear();
  S.setSetting.mockClear();
  _resetAirPlayControllerIdCacheForTest();
});

describe("getAirPlayControllerId", () => {
  it("首次调用:生成 16 位大写 hex 并写库", () => {
    const id = getAirPlayControllerId();
    expect(id).toMatch(HEX16_UPPER);
    expect(S.setSetting).toHaveBeenCalledWith(AP2_CONTROLLER_ID_SETTING_KEY, id);
    // 真·落到设置表(不是只在内存里生成一个值)
    expect(S.store[AP2_CONTROLLER_ID_SETTING_KEY]).toBe(id);
  });

  it("同一进程内重复调用:返回同一个 id,不重新生成(否则凭据全失效)", () => {
    const first = getAirPlayControllerId();
    S.setSetting.mockClear();
    const second = getAirPlayControllerId();
    const third = getAirPlayControllerId();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(S.setSetting).not.toHaveBeenCalled();
  });

  it("库里已有合法值:直接复用,不写库(跨重启稳定)", () => {
    S.store[AP2_CONTROLLER_ID_SETTING_KEY] = "0123456789ABCDEF";
    expect(getAirPlayControllerId()).toBe("0123456789ABCDEF");
    expect(S.setSetting).not.toHaveBeenCalled();
  });

  it("库里值格式非法(长度不足/非 hex):重新生成合法 id 并覆盖写库", () => {
    S.store[AP2_CONTROLLER_ID_SETTING_KEY] = "ZZZ";
    const id = getAirPlayControllerId();
    expect(id).toMatch(HEX16_UPPER);
    expect(id).not.toBe("ZZZ");
    expect(S.store[AP2_CONTROLLER_ID_SETTING_KEY]).toBe(id);
  });

  it("库里是小写合法 hex:归一成大写后复用(不重新生成)", () => {
    S.store[AP2_CONTROLLER_ID_SETTING_KEY] = "0123456789abcdef";
    expect(getAirPlayControllerId()).toBe("0123456789ABCDEF");
    expect(S.setSetting).not.toHaveBeenCalled();
  });

  it("读 settings 抛异常:不向上抛,返回合法 id(本轮用进程内临时值)", () => {
    S.setThrowOnRead(true);
    let id = "";
    expect(() => {
      id = getAirPlayControllerId();
    }).not.toThrow();
    expect(id).toMatch(HEX16_UPPER);
  });

  it("写 settings 抛异常:仍返回生成值,不向上抛(配对可用,只是重启后要重来)", () => {
    S.setThrowOnWrite(true);
    const id = getAirPlayControllerId();
    expect(id).toMatch(HEX16_UPPER);
    expect(S.setSetting).toHaveBeenCalled();
    expect(S.store[AP2_CONTROLLER_ID_SETTING_KEY]).toBeUndefined();
  });
});
