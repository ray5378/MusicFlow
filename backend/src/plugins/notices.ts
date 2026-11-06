// ==================== Plugin notices(插件提醒) ====================
//
// 与 host.storage 的边界:storage 是插件私有 KV,核心不解读;notices 是
// 「需要让用户看到」的提醒(如账号 cookie 过期),由插件显式经 host.notify
// 写入(权限 notify),核心决定展示时机与形态。表按 (plugin_id, key) 唯一,
// 同一 key 重复 upsert 即更新同一条提醒;问题修复后插件调用
// host.notify.clear(key) 删除,提醒在解决前每次进程启动后都会提醒一次。

import { sqlite } from "../db/index.js";

const MAX_KEY = 128;
const MAX_TITLE = 200;
const MAX_MESSAGE = 1000;

export type PluginNoticeLevel = "info" | "warning" | "error";

export interface PluginNoticeInput {
  key: string;
  level?: PluginNoticeLevel | string;
  title?: string;
  message: string;
}

export interface PluginNotice {
  pluginId: string;
  key: string;
  level: PluginNoticeLevel;
  title: string;
  message: string;
  at: string;
}

let ensured = false;
function ensureTable(): void {
  if (ensured) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS plugin_notices (
      plugin_id  TEXT NOT NULL,
      key        TEXT NOT NULL,
      level      TEXT NOT NULL DEFAULT 'warning',
      title      TEXT NOT NULL DEFAULT '',
      message    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (plugin_id, key)
    )
  `);
  ensured = true;
}

function normalizeLevel(level: any): PluginNoticeLevel {
  return level === "error" || level === "info" ? level : "warning";
}

/** 写入/更新一条提醒。供 host.notify.upsert 使用。 */
export function upsertPluginNotice(pluginId: string, input: PluginNoticeInput): void {
  ensureTable();
  const key = String(input?.key || "").trim().slice(0, MAX_KEY);
  const message = String(input?.message || "").trim().slice(0, MAX_MESSAGE);
  if (!key) throw new Error("host.notify.upsert 需要非空 key");
  if (!message) throw new Error("host.notify.upsert 需要非空 message");
  const title = String(input?.title || "").trim().slice(0, MAX_TITLE);
  const level = normalizeLevel(input?.level);
  const now = new Date().toISOString();
  sqlite.prepare(
    "INSERT INTO plugin_notices (plugin_id, key, level, title, message, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(plugin_id, key) DO UPDATE SET level = excluded.level, title = excluded.title, " +
    "message = excluded.message, updated_at = excluded.updated_at",
  ).run(pluginId, key, level, title, message, now, now);
}

/** 删除一条提醒(问题已修复)。供 host.notify.clear 使用。 */
export function clearPluginNotice(pluginId: string, key: string): void {
  ensureTable();
  sqlite.prepare("DELETE FROM plugin_notices WHERE plugin_id = ? AND key = ?").run(pluginId, String(key || ""));
}

/** 插件卸载/禁用时清空其全部提醒。 */
export function clearPluginNotices(pluginId: string): void {
  ensureTable();
  sqlite.prepare("DELETE FROM plugin_notices WHERE plugin_id = ?").run(pluginId);
}

/** 列出所有启用插件的提醒(供启动后一次性下发使用)。 */
export function listPluginNotices(): PluginNotice[] {
  ensureTable();
  const rows = sqlite.prepare(
    `SELECT n.plugin_id AS pluginId, n.key AS key, n.level AS level, n.title AS title,
            n.message AS message, n.updated_at AS updatedAt
       FROM plugin_notices n
       JOIN plugins p ON p.id = n.plugin_id
      WHERE p.enabled = 1
      ORDER BY n.updated_at ASC`,
  ).all() as Array<{ pluginId: string; key: string; level: string; title: string; message: string; updatedAt: string }>;
  return rows.map((r) => ({
    pluginId: r.pluginId,
    key: r.key,
    level: normalizeLevel(r.level),
    title: r.title || "",
    message: r.message,
    at: r.updatedAt,
  }));
}
