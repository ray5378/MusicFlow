// ==================== External (drop-in) plugin discovery ====================
//
// Phase 3: at boot, scan `<data>/plugins/<id>/index.js`, dynamically import each
// one, validate its manifest, check the app-version floor, and register it into
// the same runtime registry the built-ins use. From that point on the core treats
// an external plugin exactly like a built-in — no special-casing anywhere.
//
// Safety boundaries:
//   - path whitelist: only `<data>/plugins/<id>/index.js` is importable; a plugin
//     can NEVER escape that directory (path-traversal guard in safeResolve()).
//   - manifest validation: id / type / capabilities / configSchema must be well
//     formed or the plugin is skipped (never throws, never halts boot).
//   - minAppVersion: a plugin requiring a newer app is skipped with a warning.
//   - id collision: a built-in (or already-discovered) id wins; the duplicate is
//     skipped so an external file can't shadow a first-party plugin.

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { getDataDir } from "../utils/env.js";
import { registerPlugin, getPlugin } from "./registry.js";
import { seedPluginRows } from "./builtins.js";
import { validatePermissions } from "./host.js";
import type { PluginManifest, PluginType, PluginCapability } from "./types.js";

const VALID_TYPES: PluginType[] = [
  "source", "importer", "recommender", "sync",
  "lyrics", "cover", "renderer", "scrobbler",
];
const VALID_CAPS: PluginCapability[] = [
  "search", "recommend", "playlistSongs", "stream", "lyrics", "webRotation",
  "playlistImport", "playlistFile", "dailyPlaylist", "localPlaylist",
  "playlistSync", "autoMatch",
  "lyricProvider", "coverProvider", "renderer", "scrobbler",
];

/** Validate a plugin manifest. Returns an error string, or null when valid. Pure. */
export function validateManifest(manifest: any): string | null {
  if (!manifest || typeof manifest !== "object") return "manifest 必须是对象";
  if (typeof manifest.id !== "string" || !manifest.id) return "manifest.id 缺失";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(manifest.id)) {
    return "manifest.id 只能含字母/数字/连字符,且不以连字符开头";
  }
  if (typeof manifest.name !== "string" || !manifest.name) return "manifest.name 缺失";
  if (typeof manifest.version !== "string" || !manifest.version) return "manifest.version 缺失";
  if (!VALID_TYPES.includes(manifest.type)) return `manifest.type 非法: ${String(manifest.type)}`;
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    return "manifest.capabilities 必须是非空数组";
  }
  for (const c of manifest.capabilities) {
    if (!VALID_CAPS.includes(c)) return `manifest.capabilities 含非法能力: ${String(c)}`;
  }
  if (!Array.isArray(manifest.configSchema)) return "manifest.configSchema 必须是数组";
  const permErr = validatePermissions(manifest.permissions);
  if (permErr) return `manifest.permissions: ${permErr}`;
  return null;
}

/** Compare two semver-ish version strings.
 *  Returns <0 if a<b, 0 if equal, >0 if a>b. Missing/non-numeric segments = 0. */
export function compareVersion(a: string, b: string): number {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Is the plugin compatible with the running app version?
 *  `dev` builds accept any plugin (no version floor enforced). */
export function isAppVersionCompatible(manifest: PluginManifest, appVersion: string): boolean {
  if (!manifest.minAppVersion) return true;
  if (appVersion === "dev" || appVersion === "") return true;
  return compareVersion(appVersion, manifest.minAppVersion) >= 0;
}

/** Build the absolute path to a plugin's entry file, guaranteeing it stays
 *  inside `root`. Returns null on any escape attempt. Exported for testing. */
export function safeResolve(root: string, id: string): string | null {
  const full = path.resolve(root, id, "index.js");
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

/**
 * Scan `data/plugins` for drop-in plugins and register the valid ones.
 *
 * @param appVersion  running app version (from process.env.APP_VERSION)
 * @param rootDir     override the scan root (used by tests); when omitted the
 *                    real `data/plugins` directory is used and discovered plugins
 *                    are seeded into the DB immediately.
 * @returns number of plugins successfully loaded
 */
export async function discoverExternalPlugins(appVersion: string, rootDir?: string): Promise<number> {
  const root = rootDir ?? path.join(getDataDir(), "plugins");
  if (!rootDir && !fs.existsSync(root)) return 0; // real dir absent → nothing to do
  if (rootDir && !fs.existsSync(root)) return 0;

  let loaded = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const file = safeResolve(root, id);
    if (!file || !fs.existsSync(file)) {
      console.warn(`[PLUGIN] 跳过外置插件 ${id}: 缺少 index.js`);
      continue;
    }
    try {
      const mod = await import(pathToFileURL(file).href);
      const manifest: PluginManifest | undefined = mod.manifest ?? mod.default?.manifest;
      const impl: any = mod.impl ?? mod.default?.impl ?? mod.default;
      const reason = validateManifest(manifest);
      if (reason) { console.warn(`[PLUGIN] 跳过外置插件 ${id}: ${reason}`); continue; }
      if (!impl || typeof impl !== "object") {
        console.warn(`[PLUGIN] 跳过外置插件 ${id}: 未导出 impl 对象`);
        continue;
      }
      if (getPlugin(manifest!.id)) {
        console.warn(`[PLUGIN] 跳过外置插件 ${id}: 与已注册插件 id 冲突`);
        continue;
      }
      if (!isAppVersionCompatible(manifest!, appVersion)) {
        console.warn(`[PLUGIN] 跳过外置插件 ${id}: 需要 App >= ${manifest!.minAppVersion}, 当前 ${appVersion}`);
        continue;
      }
      registerPlugin(manifest!, impl);
      loaded++;
      console.log(`[PLUGIN] 已加载外置插件 ${id} (${manifest!.type}, ${manifest!.capabilities.join("/")})`);
    } catch (e: any) {
      console.warn(`[PLUGIN] 加载外置插件 ${id} 失败: ${e?.message || e}`);
    }
  }

  // Only auto-seed when scanning the real data/plugins dir (the boot path); the
  // DB is already ready by then, so a second seed creates rows for the new ids
  // without touching existing ones.
  if (!rootDir && loaded > 0) seedPluginRows();
  return loaded;
}
