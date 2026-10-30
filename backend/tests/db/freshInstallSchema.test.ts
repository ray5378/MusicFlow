// MUST be the first import: redirects DATA_DIR to an isolated temp dir before
// the backend opens its SQLite DB at module-load time.
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { sqlite, initDatabase } from "../../src/db/index.js";

// ==================== 新装一致性(v4.9.2 起无迁移代码) ====================
//
// v4.9.2 删除了 src/db/index.ts 的全部迁移代码:CREATE TABLE 即最终形态,
// 既有库由运维手工补列(ALTER TABLE),启动不再自动迁移。本文件钉住
// 「新装容器从零建库 == 已迁移生产库」的**列级一致**(列名集合;不比顺序 ——
// 生产库的历史 ALTER 顺序本就与 CREATE 不同)。
//
// 下方 PROD_COLS 是 2026-10-28 从 240 生产库(/app/backend/data/musicflow.db,
// 只读副本 PRAGMA table_info)实录。**变更列结构时必须同步更新本表**,
// 否则新装库与生产库漂移时本测试不会红。
//
// 守卫 G19-e(ckech-group-invariants.mjs)同源钉了「db/index.ts 禁 ALTER TABLE /
// PRAGMA table_info」—— 迁移代码不许回来;本文件钉的是列集合本身。

initDatabase(); // 幂等:与全局 setup 的调用重复执行安全(纯 CREATE TABLE IF NOT EXISTS)

const PROD_COLS: Record<string, string[]> = {
  player_groups: [
    "id", "name", "member_ids", "created_at", "updated_at", "owner_user_id", "volume",
    "member_delays_json", "mixed_anchor_lead_ms",
  ],
  airplay_devices: [
    "id", "name", "alias", "first_seen", "last_seen", "available", "disabled",
    "updated_at", "hap_credentials",
  ],
  sendspin_device_state: [
    "client_id", "volume", "muted", "updated_at", "disabled", "esphome_psk",
    "esphome_port", "last_host", "hostname",
  ],
  tag_repair_done: [
    "fs_path", "size", "mtime_ms", "src", "at", "platform", "outcome",
  ],
};

function cols(table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe("新装一致性:CREATE TABLE 即最终形态(v4.9.2 无迁移代码)", () => {
  for (const [table, prod] of Object.entries(PROD_COLS)) {
    it(`${table}: 新建库列集合 == 240 生产库(2026-10-28 实录)`, () => {
      expect([...cols(table)].sort()).toEqual([...prod].sort());
    });
  }

  it("新建库无迁移时代遗留表(player_rate_configs / track_switch_lead_ms 列)", () => {
    const legacy = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='player_rate_configs'")
      .all();
    expect(legacy).toHaveLength(0);
    expect(cols("player_groups")).not.toContain("track_switch_lead_ms");
  });
});
