// ==================== Plugin-scoped key/value storage ====================
//
// A general-purpose JSON KV for plugins, distinct from `config` (which is the
// user-editable settings form). Use it for caches, OAuth tokens, rate-limit
// state, etc. Mirrors songloft's `songloft.storage` namespace.
//
// Backed by a `plugin_storage` table. Each plugin is isolated by `plugin_id`,
// so plugin A can never read plugin B's keys. This is the in-process analog of
// songloft's per-plugin storage (we have no VM boundary, but the scoping gives
// the same logical isolation).

import { sqlite } from "../db/index.js";

let ensured = false;
function ensureTable(): void {
  if (ensured) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS plugin_storage (
      key        TEXT    NOT NULL,
      plugin_id  TEXT    NOT NULL,
      value      TEXT    NOT NULL,
      updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (plugin_id, key)
    )
  `);
  ensured = true;
}

export interface PluginStorage {
  get(key: string): Promise<any | null>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

function scopedStorage(pluginId: string): PluginStorage {
  ensureTable();
  const get = sqlite.prepare("SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?");
  const set = sqlite.prepare(
    "INSERT INTO plugin_storage (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  const del = sqlite.prepare("DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?");
  const keysStmt = sqlite.prepare("SELECT key FROM plugin_storage WHERE plugin_id = ? ORDER BY key");

  return {
    async get(key: string) {
      ensureTable();
      const row = get.get(pluginId, key) as { value: string } | undefined;
      if (!row) return null;
      try { return JSON.parse(row.value); } catch { return row.value; }
    },
    async set(key: string, value: any) {
      ensureTable();
      set.run(pluginId, key, JSON.stringify(value), new Date().toISOString());
    },
    async delete(key: string) {
      ensureTable();
      del.run(pluginId, key);
    },
    async keys() {
      ensureTable();
      return (keysStmt.all(pluginId) as { key: string }[]).map((r) => r.key);
    },
  };
}

/** Build a storage instance bound to a single plugin id. */
export function makeScopedStorage(pluginId: string): PluginStorage {
  return scopedStorage(pluginId);
}

/** Global helpers (used by tests / maintenance). */
export const pluginStorage = {
  forPlugin(pluginId: string): PluginStorage {
    return scopedStorage(pluginId);
  },
  /** Delete every key belonging to a plugin (e.g. on uninstall). */
  async clearPlugin(pluginId: string): Promise<void> {
    ensureTable();
    sqlite.prepare("DELETE FROM plugin_storage WHERE plugin_id = ?").run(pluginId);
  },
};
