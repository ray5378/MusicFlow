// ==================== 【QA 对抗性用例】Phase 6a AP2 凭据契约 ====================
//
// 在工程师 ap2HapCredentials.qa.test.ts(16 用例)之外的独立对抗面:
// ① 同 deviceId 交叉写两套凭据 → 读回恒为最后一次,行数恒 1;
// ② parse 接受全大写/混合大小写 192 hex(归一化入口);
// ③ build 大写/混合大小写合法 hex → 存库后原始串全小写,get→parse 往返一致;
// ④ N=1 极端配置:首次 verify fail 即清凭据;
// ⑤ 设备行被删除后 get→null,clear 幂等不报错;
// ⑥ 连败计数在 ok 后**重新累计**到可再触发 cleared(非一次性锁死);
// ⑦ 列被外部写坏(191/193 位、非 hex)→ get 三路 null 防御,不抛错;
// ⑧ no-credentials 分支真无副作用:连败 5 次计数仍为 0;
// ⑨ 双设备计数隔离:A 达阈值清除不影响 B;
// ⑩ pairVerifyMaxFailures env 全谱系:1 合法 / 1.5 / -2 / 空串 / +3 全回落;
// ⑪ upsert 补建行完整性:补建的行凭据可读、后续 clear 生效;
// ⑫ recordPairSetupSuccess 成功即复位既有连败计数(先败再 setup 成功 → 0)。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterEach } from "vitest";

import { initDatabase, sqlite } from "../../src/db/index.js";
import {
  parseHapCredentials,
  buildHapCredentials,
  getHapCredentials,
  saveHapCredentials,
  clearHapCredentials,
} from "../../src/services/airplay/ap2/hapCredentials.js";
import {
  recordPairSetupSuccess,
  recordPairVerifyResult,
  getPairVerifyFailureCount,
  resetPairVerifyFailures,
  pairVerifyMaxFailures,
  PAIR_VERIFY_MAX_FAILURES_ENV,
} from "../../src/services/airplay/ap2/pairingContract.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterEach(() => {
  resetPairVerifyFailures("qa6a-dev-a");
  resetPairVerifyFailures("qa6a-dev-b");
  delete process.env[PAIR_VERIFY_MAX_FAILURES_ENV];
});

let n = 0;
function did(prefix: string): string {
  n++;
  return `${prefix}-${Date.now()}-${n}`;
}

function mkHex(c: string, len: number): string {
  return Array.from({ length: len }, (_, i) => {
    const k = (c.charCodeAt(i % c.length) + i * 11) % 16;
    return "0123456789abcdef"[k];
  }).join("");
}
function mkCreds(seed: string): { accessoryLTPK: string; controllerLTSK: string } {
  return { accessoryLTPK: mkHex(seed, 64), controllerLTSK: mkHex(seed + "s", 128) };
}

describe("QA① 交叉写两套凭据:读回恒为最后一次 + 行数恒 1", () => {
  it("A→B→A 交叉覆盖后读回 A,且行数始终为 1", () => {
    const id = did("qa6a-x");
    const a = mkCreds("cross-a");
    const b = mkCreds("cross-b");
    saveHapCredentials(id, a);
    saveHapCredentials(id, b);
    expect(getHapCredentials(id)).toEqual(b);
    saveHapCredentials(id, a); // 交叉回写
    expect(getHapCredentials(id)).toEqual(a); // ★ 恒为最后一次
    const cnt = (sqlite.prepare("SELECT COUNT(*) AS n FROM airplay_devices WHERE id = ?").get(id) as any).n;
    expect(cnt).toBe(1); // ★ 一设备一行恒成立
  });
});

describe("QA② parse 归一化:全大写/混合大小写 192 hex 接受", () => {
  it("全大写 → null 拒绝之外的一切合法 hex 均切片成功", () => {
    const raw = mkHex("case", 192);
    const upper = parseHapCredentials(raw.toUpperCase());
    expect(upper).toEqual({
      accessoryLTPK: raw.slice(0, 64).toUpperCase(),
      controllerLTSK: raw.slice(64).toUpperCase(),
    });
    // 混合大小写
    const mixed = raw
      .slice(0, 64)
      .toUpperCase()
      .split("")
      .map((c, i) => (i % 2 ? c : c.toLowerCase()))
      .join("") + raw.slice(64).toUpperCase();
    expect(parseHapCredentials(mixed)).not.toBeNull();
  });
});

describe("QA③ build 大写入库 → 存储统一小写 → get→parse 往返一致", () => {
  it("混合大小写合法 hex:build 抛错之外,存库原始串全小写且往返等于原值", () => {
    const id = did("qa6a-norm");
    const c = mkCreds("normalize");
    const raw = buildHapCredentials({
      accessoryLTPK: c.accessoryLTPK.toUpperCase(),
      controllerLTSK: c.controllerLTSK.toUpperCase().split("").map((ch, i) => (i % 3 ? ch : ch.toLowerCase())).join(""),
    });
    expect(raw).toHaveLength(192);
    expect(raw).toBe(raw.toLowerCase()); // ★ 存储串统一小写
    saveHapCredentials(id, { accessoryLTPK: c.accessoryLTPK.toUpperCase(), controllerLTSK: c.controllerLTSK });
    const stored = (sqlite.prepare("SELECT hap_credentials FROM airplay_devices WHERE id = ?").get(id) as any)
      .hap_credentials as string;
    expect(stored).toBe(stored.toLowerCase()); // ★ 库内原始串全小写
    expect(getHapCredentials(id)).toEqual(c); // ★ get→parse 往返与原值一致(忽略大小写)
  });
});

describe("QA④ N=1 极端配置:首次 verify fail 即清", () => {
  it("env=1 → 第一次失败就 cleared 凭据清空", () => {
    process.env[PAIR_VERIFY_MAX_FAILURES_ENV] = "1";
    expect(pairVerifyMaxFailures()).toBe(1);
    const id = did("qa6a-n1");
    saveHapCredentials(id, mkCreds("n1"));
    expect(recordPairVerifyResult(id, false)).toBe("cleared"); // ★ 首 fail 即清
    expect(getHapCredentials(id)).toBeNull();
    expect(getPairVerifyFailureCount(id)).toBe(0);
  });
});

describe("QA⑤ 设备行删除后:get→null 且 clear 幂等不报错", () => {
  it("删行后再 clear/clear 不抛错,get 保持 null", () => {
    const id = did("qa6a-del");
    saveHapCredentials(id, mkCreds("del"));
    expect(getHapCredentials(id)).not.toBeNull();
    sqlite.prepare("DELETE FROM airplay_devices WHERE id = ?").run(id); // 模拟 deleteAirPlayDeviceRecord
    expect(getHapCredentials(id)).toBeNull();
    expect(() => clearHapCredentials(id)).not.toThrow(); // ★ 删行后 clear 幂等
    expect(() => clearHapCredentials(id)).not.toThrow();
    expect(getHapCredentials(id)).toBeNull();
  });
});

describe("QA⑥ ok 复位后连败重新累计到 cleared(非一次性锁死)", () => {
  it("fail,fail,ok 后再 fail×3(默认 N)→ 恰在第 3 次 cleared", () => {
    delete process.env[PAIR_VERIFY_MAX_FAILURES_ENV];
    const id = "qa6a-dev-a";
    saveHapCredentials(id, mkCreds("recycle"));
    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(recordPairVerifyResult(id, true)).toBe("retained"); // 复位
    expect(getPairVerifyFailureCount(id)).toBe(0);
    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(getHapCredentials(id)).not.toBeNull(); // 重新累计未达阈值
    expect(recordPairVerifyResult(id, false)).toBe("cleared"); // ★ 重新累计可达阈值
    expect(getHapCredentials(id)).toBeNull();
  });
});

describe("QA⑦ 列被外部写坏:get 三路 null 防御,不抛错", () => {
  it("191/193 位、非 hex 脏数据 → get 全部 null 且不影响后续正常写读", () => {
    const id = did("qa6a-corrupt");
    sqlite
      .prepare("INSERT INTO airplay_devices (id, name, alias, first_seen, last_seen, available, disabled) VALUES (?, '', '', ?, ?, 0, 0)")
      .run(id, new Date().toISOString(), new Date().toISOString());
    const setCol = sqlite.prepare("UPDATE airplay_devices SET hap_credentials = ? WHERE id = ?");
    for (const bad of ["a".repeat(191), "a".repeat(193), "z".repeat(192), ""]) {
      setCol.run(bad, id);
      expect(() => getHapCredentials(id)).not.toThrow();
      expect(getHapCredentials(id)).toBeNull(); // ★ 脏数据一律回配对窗
    }
    // 坏数据不粘滞:正常写读立即恢复
    const c = mkCreds("recover");
    saveHapCredentials(id, c);
    expect(getHapCredentials(id)).toEqual(c);
  });
});

describe("QA⑧ no-credentials 分支真无副作用", () => {
  it("无凭据连败 5 次:计数恒 0、不建行、不写任何东西", () => {
    const id = did("qa6a-noc");
    for (let i = 0; i < 5; i++) {
      expect(recordPairVerifyResult(id, false)).toBe("no-credentials");
    }
    expect(getPairVerifyFailureCount(id)).toBe(0); // ★ 计数不累计
    const row = sqlite.prepare("SELECT id FROM airplay_devices WHERE id = ?").get(id);
    expect(row).toBeUndefined(); // ★ 不偷偷建行
  });
});

describe("QA⑨ 双设备计数隔离", () => {
  it("A 达阈值清凭据不影响 B 的计数与凭据", () => {
    delete process.env[PAIR_VERIFY_MAX_FAILURES_ENV];
    const a = "qa6a-dev-a";
    const b = "qa6a-dev-b";
    const ca = mkCreds("iso-a");
    const cb = mkCreds("iso-b");
    saveHapCredentials(a, ca);
    saveHapCredentials(b, cb);
    expect(recordPairVerifyResult(a, false)).toBe("retained");
    expect(recordPairVerifyResult(a, false)).toBe("retained");
    expect(getPairVerifyFailureCount(b)).toBe(0); // ★ B 计数不受 A 影响
    expect(recordPairVerifyResult(a, false)).toBe("cleared");
    expect(getHapCredentials(b)).toEqual(cb); // ★ B 凭据完好
    expect(getPairVerifyFailureCount(b)).toBe(0);
  });
});

describe("QA⑩ pairVerifyMaxFailures env 全谱系", () => {
  it("1 合法生效;1.5 / -2 / 空串 / '+3' / '2abc' 全回落 3", () => {
    for (const [v, want] of [
      ["1", 1],
      ["1.5", 3],
      ["-2", 3],
      ["", 3],
      ["+3", 3],
      ["2abc", 3],
      [" 3", 3],
    ] as const) {
      process.env[PAIR_VERIFY_MAX_FAILURES_ENV] = v;
      expect(pairVerifyMaxFailures()).toBe(want);
    }
    delete process.env[PAIR_VERIFY_MAX_FAILURES_ENV];
    expect(pairVerifyMaxFailures()).toBe(3); // 未设置 → 缺省
  });
});

describe("QA⑪ upsert 补建行完整性", () => {
  it("无行设备 save → 补建行凭据可读、available=0、后续 clear 生效", () => {
    const id = did("qa6a-upsert");
    const c = mkCreds("upsert-full");
    saveHapCredentials(id, c);
    const row = sqlite
      .prepare("SELECT hap_credentials, available, disabled FROM airplay_devices WHERE id = ?")
      .get(id) as any;
    expect(row.available).toBe(0);
    expect(row.disabled).toBe(0);
    expect(getHapCredentials(id)).toEqual(c);
    clearHapCredentials(id);
    expect(getHapCredentials(id)).toBeNull();
    const rowAfter = sqlite.prepare("SELECT id FROM airplay_devices WHERE id = ?").get(id);
    expect(rowAfter).toBeDefined(); // ★ clear 不删行(设备可重新配对回来)
  });
});

describe("QA⑫ setup 成功即复位既有连败计数", () => {
  it("先败 2 次再 recordPairSetupSuccess → 计数归 0,后续 fail 从 1 起算", () => {
    delete process.env[PAIR_VERIFY_MAX_FAILURES_ENV];
    const id = did("qa6a-reset-setup");
    saveHapCredentials(id, mkCreds("pre-fail"));
    recordPairVerifyResult(id, false);
    recordPairVerifyResult(id, false);
    expect(getPairVerifyFailureCount(id)).toBe(2);
    const c = mkCreds("fresh-setup");
    expect(recordPairSetupSuccess(id, c.accessoryLTPK, c.controllerLTSK)).toBe(true);
    expect(getPairVerifyFailureCount(id)).toBe(0); // ★ setup 成功复位
    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(getPairVerifyFailureCount(id)).toBe(1); // ★ 从 1 重新起算
  });
});
