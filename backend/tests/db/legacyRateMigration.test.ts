// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqlite, initDatabase } from "../../src/db/index.js";

// ==================== batch49 一次性数据搬迁的防回归守卫 ====================
//
// v4.2.4 的 `player_rate_configs`（只有采样率两列）在 v4.2.5 并入
// `player_output_configs`（多了位深列 `manual_bits`）。本仓**没有迁移框架**
// —— 全仓只有 `CREATE TABLE IF NOT EXISTS`，加列不会自动落到已有库上，
// 所以改名 + 加列都手写在 `db/index.ts` 的 `migrateLegacyRateConfigs()`，
// 由 `initDatabase()` 在 seedRegisteredPlugins() 之前调用。
//
// 为什么必须单独钉一条：**这条分支在全新库 / CI 测试库上永远走不到**。
//   · 删掉那行调用 → CI 全绿，线上老库 `manual_bits` 列永远不出现，
//     设置面板保存位深必然 500（`no such column: manual_bits`）；
//   · 把 INSERT OR IGNORE 写成 INSERT OR REPLACE → 已存在的行被老库数据
//     覆盖回 0，用户刚设的位深/采样率静默丢失；
//   · 丢掉 DROP TABLE → 每次启动重放搬迁，老表永久残留。
// 三种都不会让任何既有用例变红 —— 只有本文件的「老库」场景能拦住。
//
// 断言的是**不变量**（老表消失 / 数据无损 / 新值优先 / 幂等 / 不拦启动），
// 不是实现细节，故实现重构也不会误红。

const LEGACY = "player_rate_configs";
const NEW = "player_output_configs";

function hasTable(name: string): boolean {
  return !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function newCols(): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${NEW})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function newRow(peerId: string): Record<string, unknown> | undefined {
  return sqlite.prepare(`SELECT * FROM ${NEW} WHERE peer_id = ?`).get(peerId) as Record<string, unknown> | undefined;
}

function newCount(): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${NEW}`).get() as { n: number }).n;
}

function legacyCount(): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${LEGACY}`).get() as { n: number }).n;
}

/**
 * 造一张 v4.2.4 形态的老表（只有采样率两列）。
 * @param probedRate false = 故意缺失 probed_rate 列，模拟结构不兼容的老库。
 */
function createLegacy(opts: { probedRate?: boolean } = {}): void {
  const probed = opts.probedRate !== false;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${LEGACY} (
      peer_id TEXT PRIMARY KEY,
      manual_rate INTEGER NOT NULL DEFAULT 0,
      ${probed ? "probed_rate INTEGER NOT NULL DEFAULT 0," : "-- 这一列故意缺失：模拟结构不兼容的老库"}
      updated_at TEXT
    );
  `);
}

beforeEach(() => {
  sqlite.prepare(`DROP TABLE IF EXISTS ${LEGACY}`).run();
  sqlite.prepare(`DELETE FROM ${NEW}`).run();
});

afterEach(() => {
  sqlite.prepare(`DROP TABLE IF EXISTS ${LEGACY}`).run();
  sqlite.prepare(`DELETE FROM ${NEW}`).run();
});

describe("batch49 老表搬迁：player_rate_configs → player_output_configs", () => {
  it("新表带 manual_bits 列（位深上线的前提）", () => {
    expect(hasTable(NEW)).toBe(true);
    expect(newCols()).toEqual(["peer_id", "manual_rate", "probed_rate", "manual_bits", "updated_at"]);
    expect(newCols()).toContain("manual_bits");
  });

  it("老库：数据全量搬进新表、老表被删、新列落 0（= 自动 = 跟随源位深）", () => {
    createLegacy();
    sqlite.exec(`
      INSERT INTO ${LEGACY} (peer_id, manual_rate, probed_rate, updated_at) VALUES
        ('dlna:legacy-manual', 96000, 0, '2026-10-08T01:00:00.000Z'),
        ('sendspin:legacy-probed', 0, 48000, '2026-10-08T02:00:00.000Z');
    `);

    expect(() => initDatabase()).not.toThrow();

    expect(hasTable(LEGACY), "搬完必须删老表（否则每次启动重放 + 永久残留）").toBe(false);
    expect(newCount()).toBe(2);

    const a = newRow("dlna:legacy-manual")!;
    expect(a.manual_rate).toBe(96000);
    expect(a.probed_rate).toBe(0);
    expect(a.manual_bits, "老数据没有位深 ⇒ 落 0 = 自动").toBe(0);
    expect(a.updated_at).toBe("2026-10-08T01:00:00.000Z");

    const b = newRow("sendspin:legacy-probed")!;
    expect(b.manual_rate).toBe(0);
    expect(b.probed_rate, "自动探测到的采样率不能丢（否则设备要等下一轮 hello 才恢复）").toBe(48000);
    expect(b.manual_bits).toBe(0);
  });

  it("幂等：再跑两次搬迁不炸、不改数据（老库升级后反复启动）", () => {
    createLegacy();
    sqlite.prepare(`INSERT INTO ${LEGACY} (peer_id, manual_rate, probed_rate, updated_at) VALUES ('dlna:idem', 88200, 0, 't')`).run();
    initDatabase();
    const before = newRow("dlna:idem")!;

    expect(() => initDatabase()).not.toThrow();
    expect(() => initDatabase()).not.toThrow();

    expect(hasTable(LEGACY)).toBe(false);
    expect(newCount()).toBe(1);
    expect(newRow("dlna:idem")).toEqual(before);
  });

  it("全新库 / 已搬过的库：老表不在 → 整个跳过，不动现有数据", () => {
    sqlite.prepare(`INSERT INTO ${NEW} (peer_id, manual_rate, probed_rate, manual_bits, updated_at) VALUES ('dlna:fresh', 192000, 0, 24, 't')`).run();
    const before = newRow("dlna:fresh")!;

    expect(() => initDatabase()).not.toThrow();

    expect(hasTable(LEGACY)).toBe(false);
    expect(newCount()).toBe(1);
    expect(newRow("dlna:fresh"), "跳过搬迁必须不碰新表").toEqual(before);
  });

  it("老表存在但为空：照样搬（0 行）并删表", () => {
    createLegacy();
    expect(legacyCount()).toBe(0);
    expect(() => initDatabase()).not.toThrow();
    expect(hasTable(LEGACY)).toBe(false);
  });

  it("冲突行：INSERT OR IGNORE —— 新表已有该 peer 时**保留新值**，不被老库覆盖回退", () => {
    sqlite.prepare(`INSERT INTO ${NEW} (peer_id, manual_rate, probed_rate, manual_bits, updated_at) VALUES ('dlna:conflict', 48000, 0, 24, 'new')`).run();
    createLegacy();
    sqlite.prepare(`INSERT INTO ${LEGACY} (peer_id, manual_rate, probed_rate, updated_at) VALUES ('dlna:conflict', 192000, 0, 'old')`).run();

    expect(() => initDatabase()).not.toThrow();

    const row = newRow("dlna:conflict")!;
    expect(row.manual_rate, "已存在的行不能被老库数据覆盖（用户刚设的档位静默丢失）").toBe(48000);
    expect(row.manual_bits, "位深尤其不能被冲掉 —— 老库根本没有这一列").toBe(24);
    expect(hasTable(LEGACY)).toBe(false);
  });

  it("老表结构不兼容（缺 probed_rate 列）→ 搬迁失败也**不拦启动**，老表原样留着等下轮", () => {
    createLegacy({ probedRate: false });
    sqlite.prepare(`INSERT INTO ${LEGACY} (peer_id, manual_rate, updated_at) VALUES ('dlna:incompat', 96000, 't')`).run();

    // 关键：initDatabase() 是启动路径，抛错 = 服务起不来。搬迁失败只允许 warn。
    expect(() => initDatabase()).not.toThrow();

    expect(hasTable(LEGACY), "搬迁没成功就不该删老表（数据还在里面）").toBe(true);
    expect(legacyCount()).toBe(1);
    expect(newRow("dlna:incompat"), "失败的搬迁不该落半行脏数据").toBeUndefined();
    expect(newCount()).toBe(0);
  });
});
