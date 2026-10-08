// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, afterEach, vi } from "vitest";
import { db } from "../../src/db/index.js";
import { getGroupManager } from "../../src/services/group/index.js";
import {
  getPlayerRateConfig,
  listPlayerRateConfigs,
  recordProbedRate,
  resolveTargetBits,
  resolveTargetSampleRate,
  setPlayerRate,
} from "../../src/services/playerRate.js";

// ==================== 输出格式配置的「降级契约」守卫 ====================
//
// `services/playerRate.ts` 有**两条相反的失败纪律**，两者都只写在注释里：
//   · **读**在出流热路径上（`resolveRequestAf` 每首歌都要问一次目标率/位深）
//     ⇒ 任何失败都必须**吞掉**并回落缺省（48000 / null）。读失败若抛出去，
//       表现是「这首歌直接放不出来」——用户只是想听歌，不该被一次 DB 抖动拦住。
//   · **写**在设置面板保存路径上 ⇒ 失败必须**抛**，否则面板显示「保存成功」
//     而库里什么都没变（静默失效里最坏的一种：用户以为设好了）。
// 两条纪律的分界线只有一行 `try/catch` 之差，任何一次「顺手统一一下」都会把
// 其中一条改错；而既有用例全是「DB 正常」的正向路径，没人会红。
//
// `recordProbedRate` 是第三种：它**写库**但跑在 sendspin **握手**路径上 ——
// 探测记账失败绝不能把设备拒之门外（同「读」纪律的放宽版）。
//
// 另外一个纯粹的覆盖缺口：空 peerId 的短路分支 —— 它必须在**碰 DB 之前**返回，
// 否则 HTTP 老客户端（没自报 peerId）会凭空多出一次查询。

afterEach(() => {
  vi.restoreAllMocks();
});

describe("输出格式配置：DB / 组服务不可用时的降级与不降级", () => {
  it("读路径吞掉 DB 异常：单台回「都没设」、出流回缺省，绝不抛", () => {
    vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("db down");
    });

    expect(() => getPlayerRateConfig("dlna:degrade")).not.toThrow();
    expect(getPlayerRateConfig("dlna:degrade")).toEqual({ manualRate: null, probedRate: null, manualBits: null });
    expect(resolveTargetSampleRate("dlna:degrade")).toBe(48000);
    expect(resolveTargetBits("dlna:degrade")).toBeNull();
    expect(listPlayerRateConfigs()).toEqual({});
  });

  it("空 peerId 一律短路，连 DB 都不碰（HTTP 老客户端没自报 peerId 的场景）", () => {
    const spy = vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("db down");
    });
    expect(getPlayerRateConfig("")).toEqual({ manualRate: null, probedRate: null, manualBits: null });
    expect(resolveTargetSampleRate("")).toBe(48000);
    expect(resolveTargetBits("")).toBeNull();
    expect(setPlayerRate("", 96000)).toEqual({ manualRate: null, probedRate: null, manualBits: null });
    expect(spy, "空 peerId 不该发起任何查询").not.toHaveBeenCalled();
  });

  it("写路径**不吞**：设置面板保存失败必须能回 500（否则用户以为设好了）", () => {
    vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("db down");
    });
    vi.spyOn(db, "insert").mockImplementation(() => {
      throw new Error("db down");
    });
    expect(() => setPlayerRate("dlna:degrade", 96000)).toThrow(/db down/);
    expect(() => setPlayerRate("dlna:degrade", { bits: 24 })).toThrow(/db down/);
  });

  it("recordProbedRate 跑在握手路径上：失败只回 false，绝不把设备拒之门外", () => {
    vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("db down");
    });
    vi.spyOn(db, "insert").mockImplementation(() => {
      throw new Error("db down");
    });
    expect(() => recordProbedRate("sendspin:degrade", 96000)).not.toThrow();
    expect(recordProbedRate("sendspin:degrade", 96000)).toBe(false);
    // 非法值 / 空 peerId 同样是「不记账」而不是报错
    expect(recordProbedRate("sendspin:degrade", "abc")).toBe(false);
    expect(recordProbedRate("", 96000)).toBe(false);
  });

  it("组服务不可用：rateScope 回退成「按自己算」，不因为算不出组就放不出声", () => {
    const gm = getGroupManager();
    vi.spyOn(gm, "groupsOfDevice").mockImplementation(() => {
      throw new Error("group down");
    });
    vi.spyOn(gm, "get").mockImplementation(() => {
      throw new Error("group down");
    });

    expect(() => resolveTargetSampleRate("dlna:degrade")).not.toThrow();
    expect(resolveTargetSampleRate("dlna:degrade")).toBe(48000);
    expect(resolveTargetBits("dlna:degrade")).toBeNull();
    // 显式 group: 的 peerId 走同一条兜底
    expect(resolveTargetSampleRate("group:degrade")).toBe(48000);
    expect(resolveTargetBits("group:degrade")).toBeNull();
  });
});
