// ==================== Plugin Host context (`host.*`) ====================
//
// The controlled surface a plugin receives instead of reaching into backend
// internals. This mirrors songloft's `songloft.*` SDK: a plugin NEVER imports
// core modules — it only calls what the host hands it. In songloft the host is
// a separate VM boundary; here we are in-process, so `host.*` is a *contract*
// (not a runtime sandbox). The contract is still valuable: it documents exactly
// what a plugin may touch, lets us enforce a permission model at the call
// sites, and keeps plugins swappable. See docs/RESEARCH-songloft-plugin-inspiration.md.
//
//   host.log(...)            namespaced logging
//   host.config              the plugin's current stored config
//   host.version             running app version
//   host.storage             scoped JSON KV (PluginStorage)
//   host.http(input, init)   fetch, gated by the `net` permission
//   host.comm                inter-plugin messaging (gated by `inter-plugin`)

import type { PluginManifest } from "./types.js";
import { makeScopedStorage, type PluginStorage } from "./storage.js";
import { createComm, type CommTarget } from "./comm.js";

export interface PluginHost {
  pluginId: string;
  version: string;
  permissions: string[];
  config: Record<string, any>;
  log: (...args: any[]) => void;
  storage: PluginStorage;
  http: (input: any, init?: any) => Promise<any>;
  comm: CommTarget;
}

/** All permissions MusicFlow-V2 understands. A plugin declaring an unknown
 *  permission at manifest-validation time is rejected. Prefix wildcards
 *  (`songs.*`) are allowed and match any `<ns>.<sub>` permission. */
export const KNOWN_PERMISSIONS: string[] = [
  "log",
  "storage",
  "net",
  "command",
  "fs",
  "fs:music",
  "fs:external",
  "websocket",
  "jsenv",
  "songs:read",
  "songs:write",
  "playlists:read",
  "playlists:write",
  "inter-plugin",
];

/** Namespaces a plugin may wildcard with `<ns>.*` (e.g. `songs.*` grants both
 *  `songs:read` and `songs:write`). Derived from KNOWN_PERMISSIONS so the two
 *  never drift apart. */
const KNOWN_NAMESPACES = Array.from(
  new Set(KNOWN_PERMISSIONS.flatMap((p) => (p.includes(":") ? [p.split(":")[0]] : []))),
);

/** Validate a manifest's `permissions` array. Returns an error string, or null
 *  when valid. Pure. Missing/empty permissions is allowed (no capabilities
 *  that need gating). Accepts exact perms (`net`), namespace wildcards
 *  (`songs.*`) and the global grant (`*`). */
export function validatePermissions(perms: any): string | null {
  if (perms === undefined || perms === null) return null;
  if (!Array.isArray(perms)) return "permissions 必须是数组";
  for (const p of perms) {
    if (typeof p !== "string") return "permissions 含非字符串项";
    if (KNOWN_PERMISSIONS.includes(p)) continue;
    if (p === "*") continue; // global grant (trust decision — we are in-process)
    if (p.endsWith(".*") && KNOWN_NAMESPACES.includes(p.slice(0, -2))) continue;
    return `未知权限: ${p}`;
  }
  return null;
}

export function hasPermission(host: PluginHost, perm: string): boolean {
  if (host.permissions.includes(perm)) return true;
  const [ns] = perm.split(":");
  if (host.permissions.includes(`${ns}.*`)) return true;
  if (host.permissions.includes("*")) return true;
  return false;
}

export function requirePermission(host: PluginHost, perm: string): void {
  if (!hasPermission(host, perm)) {
    throw new Error(`插件 ${host.pluginId} 缺少权限: ${perm}`);
  }
}

/** Build a fresh host context for a plugin. Call this per-invocation (not
 *  cached) so `host.config` always reflects the latest stored config. */
export function createPluginHost(
  manifest: PluginManifest,
  config: Record<string, any>,
  appVersion: string,
): PluginHost {
  const permissions = manifest.permissions || [];
  const storage = makeScopedStorage(manifest.id);
  const host: PluginHost = {
    pluginId: manifest.id,
    version: appVersion,
    permissions,
    config: config || {},
    log: (...args: any[]) => console.log(`[plugin:${manifest.id}]`, ...args),
    storage,
    http: async (input: any, init?: any) => {
      requirePermission(host, "net");
      return fetch(input, init);
    },
    comm: createComm(manifest.id, permissions),
  };
  return host;
}
