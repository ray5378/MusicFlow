// ==================== AP2 HAP 凭据契约（Phase 6a）机械验证 ====================
//
// 对应权威文档 Phase 6a 五条：
//   1) 写入时机：pair-setup 成功才写（recordPairSetupSuccess 唯一入口）；
//      失败（recordPairingFailure）不写。
//   2) 存储形态：192 hex = accessoryLTPK(64) + controllerLTSK(128)；
//      一设备一行（id 主键唯一）；切分唯一出处 hapCredentials.ts。
//   3) 重启免 PIN（可机械验证）：写入 → **新 Database 实例**重读该行 →
//      parse 出的 LTPK/LTSK 与写入时逐字节一致。
//   4) 失效清理：verify 连续失败 N 次（默认 3，env 可配）⇒ 清行回到配对窗；
//      设备删除 ⇒ 凭据随行消失。
//   5) 迁移兼容：hap_credentials 幂等加列，重复 initDatabase 不炸、列不重复。
//
// MUST be the first import: 在 backend 模块加载前把 DATA_DIR 指到隔离临时目录。
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { initDatabase, sqlite } from "../../src/db/index.js";
import {
  parseHapCredentials,
  buildHapCredentials,
  getHapCredentials,
  saveHapCredentials,
  clearHapCredentials,
  HAP_CREDENTIALS_HEX_LEN,
  ACCESSORY_LTPK_HEX_LEN,
  CONTROLLER_LTSK_HEX_LEN,
} from "../../src/services/airplay/ap2/hapCredentials.js";
import {
  recordPairSetupSuccess,
  recordPairingFailure,
  recordPairVerifyResult,
  getPairVerifyFailureCount,
  resetPairVerifyFailures,
  pairVerifyMaxFailures,
  DEFAULT_PAIR_VERIFY_MAX_FAILURES,
  PAIR_VERIFY_MAX_FAILURES_ENV,
} from "../../src/services/airplay/ap2/pairingContract.js";

beforeAll(() => {
  if (!process.env.APP_VERSION) process.env.APP_VERSION = "1.0.0";
  initDatabase();
});

afterEach(() => {
  // 连败计数是模块级 Map，用例间必须复位，否则用例顺序耦合。
  resetPairVerifyFailures("ap2c-dev");
  delete process.env[PAIR_VERIFY_MAX_FAILURES_ENV];
});

let n = 0;
function did(prefix: string): string {
  n++;
  return `${prefix}-${Date.now()}-${n}`;
}

/** 确定性合法凭据（可由 seed 生成不同值；避免随机导致断言难复现）。 */
function mkCreds(seed: string): { accessoryLTPK: string; controllerLTSK: string } {
  const hex = (c: string, len: number) =>
    Array.from({ length: len }, (_, i) => {
      const k = (c.charCodeAt(i % c.length) + i * 7) % 16;
      return "0123456789abcdef"[k];
    }).join("");
  return { accessoryLTPK: hex(seed, 64), controllerLTSK: hex(seed + "s", 128) };
}

describe("Phase 6a-2 存储形态：192 hex 切分（唯一出处）", () => {
  it("build → parse 往返一致，长度常量自洽（64+128=192）", () => {
    expect(ACCESSORY_LTPK_HEX_LEN).toBe(64);
    expect(CONTROLLER_LTSK_HEX_LEN).toBe(128);
    expect(HAP_CREDENTIALS_HEX_LEN).toBe(192);
    const c = mkCreds("roundtrip");
    const raw = buildHapCredentials(c);
    expect(raw).toHaveLength(192);
    expect(parseHapCredentials(raw)).toEqual(c);
    // 大写 hex 也合法，解析出的是原文切片（存储层统一小写由 build 负责）。
    expect(parseHapCredentials(raw.toUpperCase())?.accessoryLTPK).toBe(c.accessoryLTPK.toUpperCase());
  });

  it("parse 拒绝：空串 / 长度不符 / 非 hex / null / undefined", () => {
    expect(parseHapCredentials("")).toBeNull();
    expect(parseHapCredentials("a".repeat(191))).toBeNull();
    expect(parseHapCredentials("a".repeat(193))).toBeNull();
    expect(parseHapCredentials("z".repeat(192))).toBeNull();
    expect(parseHapCredentials("a".repeat(96) + "G".repeat(96))).toBeNull(); // 192 位但含非 hex 字符
    expect(parseHapCredentials(null)).toBeNull();
    expect(parseHapCredentials(undefined)).toBeNull();
  });

  it("build 拒绝非法输入（坏凭据绝不允许入库）", () => {
    expect(() => buildHapCredentials({ accessoryLTPK: "a".repeat(63), controllerLTSK: "b".repeat(128) })).toThrow();
    expect(() => buildHapCredentials({ accessoryLTPK: "a".repeat(65), controllerLTSK: "b".repeat(128) })).toThrow();
    expect(() => buildHapCredentials({ accessoryLTPK: "a".repeat(64), controllerLTSK: "b".repeat(127) })).toThrow();
    expect(() => buildHapCredentials({ accessoryLTPK: "g".repeat(64), controllerLTSK: "b".repeat(128) })).toThrow();
  });
});

describe("Phase 6a-2 存储形态：一设备一行、按 deviceId 唯一", () => {
  it("save 在无设备行时补建行，get 回读一致；覆盖写替换旧凭据", () => {
    const id = did("upsert");
    expect(getHapCredentials(id)).toBeNull();
    const c1 = mkCreds("first");
    saveHapCredentials(id, c1);
    expect(getHapCredentials(id)).toEqual(c1);
    const c2 = mkCreds("second");
    saveHapCredentials(id, c2);
    expect(getHapCredentials(id)).toEqual(c2);
    // id 是 PRIMARY KEY：同设备永远只有一行。
    const cnt = (sqlite.prepare("SELECT COUNT(*) AS n FROM airplay_devices WHERE id = ?").get(id) as any).n;
    expect(cnt).toBe(1);
  });

  it("Phase 6a-3 重启免 PIN（机械验证）：写入 → 新 Database 实例重读 → 逐字节一致", () => {
    const id = did("restart");
    const c = mkCreds("restart-free-pin");
    saveHapCredentials(id, c);
    // 模拟「新进程实例」：不经模块级 sqlite 单例，直接另开一个 Database 连接读同一文件。
    const dbFile = path.join(process.env.DATA_DIR || "", "musicflow.db");
    const fresh = new Database(dbFile, { readonly: true });
    try {
      const row = fresh.prepare("SELECT hap_credentials FROM airplay_devices WHERE id = ?").get(id) as any;
      expect(typeof row?.hap_credentials).toBe("string");
      const rebuilt = parseHapCredentials(row.hap_credentials);
      expect(rebuilt).toEqual(c); // 6b 的 pair-verify 就用这份重建免 PIN 会话
    } finally {
      fresh.close();
    }
  });
});

describe("Phase 6a-1 写入时机：pair-setup 成功才写，失败不写", () => {
  it("recordPairSetupSuccess 是唯一写入口：成功入库且返回 true", () => {
    const id = did("setup-ok");
    const c = mkCreds("setup-success");
    expect(recordPairSetupSuccess(id, c.accessoryLTPK, c.controllerLTSK)).toBe(true);
    expect(getHapCredentials(id)).toEqual(c);
    expect(getPairVerifyFailureCount(id)).toBe(0);
  });

  it("recordPairSetupSuccess 传入非法 hex → false 且库里无凭据（不半写）", () => {
    const id = did("setup-bad");
    expect(recordPairSetupSuccess(id, "zz".repeat(32), "ab".repeat(64))).toBe(false);
    expect(getHapCredentials(id)).toBeNull();
  });

  it("pairing 失败（setup/verify）绝不写凭据（契约定案：失败不写）", () => {
    const id = did("fail-nowrite");
    recordPairingFailure(id, "pair-setup");
    recordPairingFailure(id, "pair-verify");
    expect(getHapCredentials(id)).toBeNull();
  });
});

describe("Phase 6a-4 失效清理：verify 连续失败 N 次（默认 3，可配）", () => {
  it("默认 N=3：前 2 次 retained 凭据仍在；第 3 次 cleared 凭据清空且计数复位", () => {
    delete process.env[PAIR_VERIFY_MAX_FAILURES_ENV];
    expect(pairVerifyMaxFailures()).toBe(DEFAULT_PAIR_VERIFY_MAX_FAILURES);
    expect(DEFAULT_PAIR_VERIFY_MAX_FAILURES).toBe(3);
    const id = "ap2c-dev";
    const c = mkCreds("cleanup");
    saveHapCredentials(id, c);

    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(getHapCredentials(id)).toEqual(c); // 未达阈值不清
    expect(getPairVerifyFailureCount(id)).toBe(2);

    expect(recordPairVerifyResult(id, false)).toBe("cleared");
    expect(getHapCredentials(id)).toBeNull(); // 回到配对窗
    expect(getPairVerifyFailureCount(id)).toBe(0); // 清完复位
  });

  it("verify 成功复位连败计数：fail,fail,ok,fail,fail 永不清", () => {
    delete process.env[PAIR_VERIFY_MAX_FAILURES_ENV];
    const id = did("reset-ok");
    saveHapCredentials(id, mkCreds("reset-ok"));
    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(recordPairVerifyResult(id, true)).toBe("retained");
    expect(getPairVerifyFailureCount(id)).toBe(0);
    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(getHapCredentials(id)).not.toBeNull();
  });

  it("N 可配：env 置 2 → 第 2 次失败即清（回到配对窗）", () => {
    process.env[PAIR_VERIFY_MAX_FAILURES_ENV] = "2";
    expect(pairVerifyMaxFailures()).toBe(2);
    const id = did("env-n2");
    saveHapCredentials(id, mkCreds("env-n2"));
    expect(recordPairVerifyResult(id, false)).toBe("retained");
    expect(recordPairVerifyResult(id, false)).toBe("cleared");
    expect(getHapCredentials(id)).toBeNull();
  });

  it("env 非法（0 / 非数字）回落默认 3", () => {
    process.env[PAIR_VERIFY_MAX_FAILURES_ENV] = "0";
    expect(pairVerifyMaxFailures()).toBe(3);
    process.env[PAIR_VERIFY_MAX_FAILURES_ENV] = "abc";
    expect(pairVerifyMaxFailures()).toBe(3);
  });

  it("无凭据设备 verify 失败 → no-credentials，无副作用", () => {
    const id = did("no-cred");
    expect(getHapCredentials(id)).toBeNull();
    expect(recordPairVerifyResult(id, false)).toBe("no-credentials");
    expect(getPairVerifyFailureCount(id)).toBe(0);
  });

  it("clearHapCredentials 幂等：重复清 / 清不存在的设备都无害", () => {
    clearHapCredentials(did("never-exists"));
    const id = did("clear-twice");
    saveHapCredentials(id, mkCreds("clear-twice"));
    clearHapCredentials(id);
    clearHapCredentials(id);
    expect(getHapCredentials(id)).toBeNull();
  });
});

describe("Phase 6a-4 失效清理：设备被删除 → 凭据随行消失", () => {
  it("deleteAirPlayDeviceRecord 删设备行后 getHapCredentials 为 null", async () => {
    const { deleteAirPlayDeviceRecord } = await import(
      "../../src/services/airplay/control.js"
    );
    const id = did("del-cred");
    saveHapCredentials(id, mkCreds("del-cred"));
    expect(getHapCredentials(id)).not.toBeNull();
    deleteAirPlayDeviceRecord(id);
    expect(getHapCredentials(id)).toBeNull(); // 契约：删除即「清行回到配对窗」
  });
});

describe("Phase 6a-5 迁移兼容：幂等加列，无需二次迁移", () => {
  it("重复 initDatabase 不炸；hap_credentials 列恰好一个、缺省 ''", () => {
    expect(() => initDatabase()).not.toThrow();
    const cols = (sqlite.prepare("PRAGMA table_info(airplay_devices)").all() as any[])
      .map((c) => String(c.name));
    expect(cols.filter((c) => c === "hap_credentials")).toHaveLength(1);
    const id = did("migr");
    saveHapCredentials(id, mkCreds("migr"));
    // 重读默认值语义：清空后新插入行（补建路径除外）凭据列为 ''。
    const raw = (sqlite.prepare("SELECT hap_credentials FROM airplay_devices WHERE id = ?").get(id) as any)
      .hap_credentials;
    expect(typeof raw).toBe("string");
    expect(raw).toHaveLength(192);
  });
});
