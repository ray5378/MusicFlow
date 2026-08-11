// ==================== Plugin distribution registry + marketplace ====================
//
// songloft distributes plugins through a remote `registry.json` (an array of
// plugin.json URLs, with optional recursive `includes`). We mirror that:
//   - registry URLs are persisted in the `plugin_registries` table.
//   - listMarketplace() fetches + merges every enabled registry, dedupes by id,
//     and keeps the highest version (mirrors registry.go's FetchAndMerge).
//   - installPlugin(downloadUrl) downloads the archive, extracts it into
//     data/plugins/<id>/, and (re)discovers external plugins so it's live
//     immediately — no restart needed.
//
// In-process caveat (see docs/RESEARCH-...): we have no sandbox, so installing a
// third-party plugin is a trust decision. The UI surfaces a warning; the
// manifest is validated before it is registered.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { eq } from "drizzle-orm";
import { promisify } from "util";
import { getDataDir } from "../utils/env.js";
import { db } from "../db/index.js";
import { pluginRegistries } from "../db/schema.js";
import { discoverExternalPlugins } from "./discovery.js";
import { validateManifest } from "./discovery.js";
import type { PluginManifest } from "./types.js";

const execFileAsync = promisify(execFile);
const APP_VERSION = process.env.APP_VERSION || "dev";

// BSD `tar` (the one Windows bundles) mis-parses `C:\Users\...` paths: the
// `C:` looks like a remote host, and — worse — the backslash is treated as an
// escape character, so the path is silently mangled and extraction fails with
// "Cannot open: No such file or directory". Forcing local mode (`--force-local`)
// plus forward slashes makes extraction work on Windows dev machines and on
// Linux/macOS containers alike.
function toTarPath(p: string): string {
  return process.platform === "win32" ? p.replace(/\\/g, "/") : p;
}

interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  downloadUrl: string; // archive (zip / tgz) containing index.js + manifest
  minAppVersion?: string;
}

/** Persisted registry sources. */
export function listRegistries(): { id: string; url: string; enabled: number }[] {
  return db.select().from(pluginRegistries).all() as any[];
}

export function addRegistry(url: string): string {
  if (!/^https?:\/\//.test(url)) throw new Error("registry URL 必须是 http(s) 链接");
  // Date.now() alone collides when several registries are added in the same
  // millisecond (e.g. in a tight test loop), so mix in a random suffix.
  const id = `reg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  db.insert(pluginRegistries).values({ id, url, enabled: 1, createdAt: new Date().toISOString() }).run();
  return id;
}

export function removeRegistry(id: string): void {
  db.delete(pluginRegistries).where(eq(pluginRegistries.id, id)).run();
}

/** Fetch a single registry manifest. Supports either a bare array of plugin
 *  JSON URLs, or an object `{ plugins: [...], includes: [...] }`. */
async function fetchOneRegistry(url: string): Promise<{ plugins: string[]; includes: string[] }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`拉取注册表失败: HTTP ${res.status}`);
  const data: any = await res.json();
  if (Array.isArray(data)) return { plugins: data, includes: [] };
  if (data && Array.isArray(data.plugins)) return { plugins: data.plugins, includes: data.includes || [] };
  return { plugins: [], includes: [] };
}

/** Recursively fetch + merge all registry plugin URLs (dedupes, follows
 *  `includes`). Returns the resolved plugin.json URLs. */
export async function collectRegistryPluginUrls(): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const queue = listRegistries().filter((r) => r.enabled).map((r) => r.url);
  while (queue.length) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const { plugins, includes } = await fetchOneRegistry(url);
      for (const p of plugins) if (!seen.has(p)) out.push(p);
      for (const inc of includes) queue.push(inc);
    } catch (e: any) {
      console.warn(`[REGISTRY] 跳过无法访问的注册表 ${url}: ${e?.message || e}`);
    }
  }
  return out;
}

/** Build the marketplace listing (deduped by id, highest version wins). */
export async function listMarketplace(): Promise<RegistryEntry[]> {
  const urls = await collectRegistryPluginUrls();
  const byId = new Map<string, RegistryEntry>();
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const m: any = await res.json();
      if (validateManifest(m)) continue;
      const entry: RegistryEntry = {
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        author: m.author,
        homepage: m.homepage,
        downloadUrl: m.downloadUrl || (m as any).url || url,
        minAppVersion: m.minAppVersion,
      };
      const prev = byId.get(entry.id);
      if (!prev || compareVer(entry.version, prev.version) > 0) byId.set(entry.id, entry);
    } catch (e: any) {
      console.warn(`[REGISTRY] 无法读取插件清单 ${url}: ${e?.message || e}`);
    }
  }
  return [...byId.values()];
}

function compareVer(a: string, b: string): number {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0, dbv = pb[i] || 0;
    if (da !== dbv) return da - dbv;
  }
  return 0;
}

/** Download + extract a plugin archive into data/plugins/<id>/ and (re)discover
 *  it. Uses the OS `tar` (handles both .zip and .tgz on modern systems). */
export async function installPlugin(downloadUrl: string): Promise<{ id: string; name: string }> {
  const tmp = path.join(getDataDir(), "plugins", `.install-${Date.now().toString(36)}`);
  const archive = path.join(tmp, "plugin.archive");
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(archive, buf);

    // Extract into a staging dir, then read the manifest to learn the id.
    const stage = path.join(tmp, "stage");
    fs.mkdirSync(stage, { recursive: true });
    // BSD `tar` (the one Windows bundles) treats a `C:\...` path as a remote
    // host (`Cannot connect to C:`). `--force-local` disables that interpretation
    // so extraction works on Windows dev machines as well as Linux containers.
    const tarArgs = ["-xf", toTarPath(archive), "-C", toTarPath(stage)];
    if (process.platform === "win32") tarArgs.unshift("--force-local");
    await execFileAsync("tar", tarArgs, { windowsHide: true });

    const manifestPath = findFile(stage, "plugin.json") || findFile(stage, "manifest.json");
    if (!manifestPath) throw new Error("插件包缺少 manifest (plugin.json)");
    const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const reason = validateManifest(manifest);
    if (reason) throw new Error(`插件清单无效: ${reason}`);

    const dest = path.join(getDataDir(), "plugins", manifest.id);
    fs.rmSync(dest, { recursive: true, force: true });
    // The archive may nest everything under a single top folder.
    const src = findTopDir(stage) || stage;
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      fs.renameSync(path.join(src, f), path.join(dest, f));
    }

    // Register + seed immediately (no restart needed).
    await discoverExternalPlugins(APP_VERSION);
    return { id: manifest.id, name: manifest.name };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function findFile(root: string, name: string): string | null {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

/** If the extracted tree has exactly one top-level directory, use it. */
function findTopDir(root: string): string | null {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  return dirs.length === 1 ? path.join(root, dirs[0].name) : null;
}

/** Exported for unit testing the extraction traversal (no network / tar). */
export { findFile, findTopDir };
