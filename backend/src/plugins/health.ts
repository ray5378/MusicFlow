// ==================== Plugin health tracking ====================
//
// Songsloft tracks a per-plugin success rate and flags green/yellow/red with
// automatic recovery. We have no VM to "recover", but the same observability
// is valuable: a misconfigured lyric/cover provider that throws on every call
// shouldn't spam errors forever, and the admin UI should show a status.
//
// Consecutive failures drive the status: 0 = green, 1–2 = yellow, >=3 = red.
// A red plugin is still tried (the user may fix its config), but the status
// surfaces in the admin Plugins page and the /v1/plugins/health endpoint.

import { sqlite } from "../db/index.js";

export type HealthStatus = "green" | "yellow" | "red" | "down" | "unknown";

interface HealthRecord {
  status: HealthStatus;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastCheck: string;
}

let ensured = false;
function ensureTable(): void {
  if (ensured) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS plugin_health (
      plugin_id         TEXT PRIMARY KEY,
      status            TEXT NOT NULL DEFAULT 'unknown',
      successes         INTEGER NOT NULL DEFAULT 0,
      failures          INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error        TEXT,
      last_check        TEXT,
      updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  ensured = true;
}

const cache = new Map<string, HealthRecord>();

function load(id: string): HealthRecord {
  ensureTable();
  let rec = cache.get(id);
  if (rec) return rec;
  const row = sqlite.prepare("SELECT * FROM plugin_health WHERE plugin_id = ?").get(id) as any;
  rec = row
    ? {
        status: row.status,
        successes: row.successes,
        failures: row.failures,
        consecutiveFailures: row.consecutive_failures,
        lastError: row.last_error,
        lastCheck: row.last_check,
      }
    : { status: "unknown", successes: 0, failures: 0, consecutiveFailures: 0, lastError: null, lastCheck: "" };
  cache.set(id, rec);
  return rec;
}

function persist(id: string, rec: HealthRecord): void {
  sqlite.prepare(`
    INSERT INTO plugin_health (plugin_id, status, successes, failures, consecutive_failures, last_error, last_check, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plugin_id) DO UPDATE SET
      status = excluded.status, successes = excluded.successes, failures = excluded.failures,
      consecutive_failures = excluded.consecutive_failures, last_error = excluded.last_error,
      last_check = excluded.last_check, updated_at = excluded.updated_at
  `).run(id, rec.status, rec.successes, rec.failures, rec.consecutiveFailures, rec.lastError, rec.lastCheck, new Date().toISOString());
}

function statusFor(consecutiveFailures: number): HealthStatus {
  if (consecutiveFailures === 0) return "green";
  if (consecutiveFailures <= 2) return "yellow";
  return "red";
}

/** Record a successful invocation. Resets the consecutive-failure counter. */
export function recordSuccess(id: string): void {
  const rec = load(id);
  rec.successes += 1;
  rec.consecutiveFailures = 0;
  rec.status = "green";
  rec.lastCheck = new Date().toISOString();
  persist(id, rec);
}

/** Record a failed invocation. */
export function recordFailure(id: string, error: string): void {
  const rec = load(id);
  rec.failures += 1;
  rec.consecutiveFailures += 1;
  rec.status = statusFor(rec.consecutiveFailures);
  rec.lastError = error.slice(0, 500);
  rec.lastCheck = new Date().toISOString();
  persist(id, rec);
}

/** Get the current health record for a plugin (never throws). */
export function getHealth(id: string): HealthRecord {
  return load(id);
}

/** Get health for every tracked plugin. */
export function allHealth(): { pluginId: string; status: HealthStatus; successes: number; failures: number; lastError: string | null }[] {
  ensureTable();
  const rows = sqlite.prepare("SELECT plugin_id, status, successes, failures, last_error FROM plugin_health").all() as any[];
  return rows.map((r) => ({
    pluginId: r.plugin_id,
    status: r.status,
    successes: r.successes,
    failures: r.failures,
    lastError: r.last_error,
  }));
}

/** Optional self-check hook: a plugin may implement `health()` returning
 *  "ok" | "degraded" | "down" with a message. Returns null if not implemented. */
export async function pingPlugin(impl: any): Promise<{ status: HealthStatus; message?: string } | null> {
  if (typeof impl?.health !== "function") return null;
  try {
    const r = await impl.health();
    if (!r || typeof r.status !== "string") return null;
    return { status: r.status as HealthStatus, message: r.message };
  } catch (e: any) {
    return { status: "down", message: e?.message || String(e) };
  }
}
