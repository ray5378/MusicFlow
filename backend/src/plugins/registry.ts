// ==================== Plugin Registry (runtime) ====================
//
// Single source of truth for which plugins are loaded. The core queries this
// registry by *capability* / *type* — never by a concrete plugin name. Plugins
// are registered at boot (built-ins) and, in Phase 3, from data/plugins/*.

// NOTE: this module must NOT import ./builtins.js. The built-in catalog pulls in
// the actual plugin implementations, and those implementations import *this*
// registry (capability lookups) — importing builtins here would close the cycle
// `registry -> builtins -> impl -> registry` and leave half-initialised ESM
// bindings at load time. Registration + DB seeding therefore live in builtins.ts.

import { sqlite } from "../db/index.js";
import type { PluginManifest, PluginType, PluginCapability, LyricSongInput } from "./types.js";
import { withScheduleFields } from "../services/plugin/scheduleFields.js";

export interface RegisteredPlugin {
  manifest: PluginManifest;
  impl: any;
}

const registry = new Map<string, RegisteredPlugin>();

/** Register a plugin (built-in or discovered). Safe to call multiple times.
 *
 *  这里是内置与外置(沙箱)插件注册的**唯一漏斗**:凡声明了歌单调度相关能力
 *  (SCHEDULED_CAPS)的插件,在此统一注入「参与每日定时同步 / 容器启动补拉」两个
 *  开关到 configSchema(幂等)。这样任何新增/第三方插件只要声明了能力,配置页就自动
 *  出现定时开关,无需逐个插件手写。 */
export function registerPlugin(manifest: PluginManifest, impl: any) {
  registry.set(manifest.id, { manifest: withScheduleFields(manifest), impl });
}

/** Remove a plugin from the in-memory registry (used when uninstalling an
 *  external plugin). Callers must guard against removing built-ins. */
export function unregisterPlugin(id: string): void {
  registry.delete(id);
}

/** Compat shim: an OnlineProvider carries its manifest, so registering it is
 *  just registering (manifest, impl). */
export function registerOnlineProvider(p: { manifest: PluginManifest; [k: string]: any }) {
  registerPlugin(p.manifest, p);
}

export function getPlugin(id: string): RegisteredPlugin | undefined {
  return registry.get(id);
}
export function getPluginImpl(id: string): any | undefined {
  return registry.get(id)?.impl;
}
/** Back-compat: an "online provider" is just the registered impl. */
export function getOnlineProvider(id: string): any | undefined {
  return registry.get(id)?.impl;
}
export function listOnlineProviders(): any[] {
  return listRegistered().map((p) => p.impl);
}
export function getPluginManifest(id: string): PluginManifest | undefined {
  return registry.get(id)?.manifest;
}
export function listRegistered(): RegisteredPlugin[] {
  return [...registry.values()];
}

/** Whether a plugin declares a capability (without requiring it to be enabled). */
export function getCapabilities(id: string): PluginCapability[] {
  return registry.get(id)?.manifest.capabilities ?? [];
}

// getEnabledPlugins/getEnabledByCapability 是导入/匹配/选源的高频入口。原实现用
// drizzle `db.select().from(plugins)` 拉整表(含 manifest/config 大 JSON 列)。这里
// 只投影 name 列并在 DB 侧过滤 enabled=1,避免反复读出大字段却只用到一行 name。
// 不做 enabled 状态的内存缓存:启用/停用通过原 SQL 写入,TTL 缓存会读到陈旧快照
// (破坏"写后立即可见"契约),而精简投影已足够廉价。
const ENABLED_SQL = "SELECT name FROM plugins WHERE enabled = 1";

/** Plugins that are both registered in code AND enabled in the DB. */
export function getEnabledPlugins(type?: PluginType): RegisteredPlugin[] {
  const enabledIds = new Set(
    (sqlite.prepare(ENABLED_SQL).all() as { name: string }[]).map((r) => r.name),
  );
  return listRegistered().filter(
    (p) => (type ? p.manifest.type === type : true) && enabledIds.has(p.manifest.id),
  );
}

export function getEnabledSourcePlugins(): RegisteredPlugin[] {
  return getEnabledPlugins("source");
}

/** Enabled plugins declaring `cap`, in registration order.
 *
 *  This is THE lookup the core should use. Anything that used to hardcode a
 *  plugin id ("go-music-dl", the QQ/NetEase if-chain, ...) becomes "give me the
 *  enabled plugins that can do X". */
export function getEnabledByCapability(cap: PluginCapability): RegisteredPlugin[] {
  return getEnabledPlugins().filter((p) => p.manifest.capabilities.includes(cap));
}

/** First enabled plugin declaring `cap`, or undefined. */
export function firstEnabledByCapability(cap: PluginCapability): RegisteredPlugin | undefined {
  return getEnabledByCapability(cap)[0];
}

/** 是否有「已启用」插件声明该能力(核心行为开关,如 songGroup / playPreference)。
 *  高频调用点(序列化/流播)用它做常量级判断,不拉插件实例。 */
export function isCapabilityEnabled(cap: PluginCapability): boolean {
  return getEnabledByCapability(cap).length > 0;
}

/** Read the stored config JSON for a plugin id (from the DB `plugins` row).
 *  只投影 name/enabled/config,避开 manifest 大 JSON 列。不做内存缓存(同上,
 *  配置/启用经原 SQL 写入需立即可见)。 */
const CONFIG_SQL = "SELECT name, enabled, config FROM plugins WHERE name = ?";

export function getPluginConfig(id: string): Record<string, any> | null {
  const p = sqlite.prepare(CONFIG_SQL).get(id) as { enabled: number; config: string | null } | undefined;
  if (!p || !p.enabled) return null;
  try {
    return JSON.parse(p.config || "{}");
  } catch {
    return null;
  }
}
