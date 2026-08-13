// ==================== Plugin distribution registry + marketplace ====================
//
// songloft distributes plugins through a remote `registry.json` (an array of
// plugin.json URLs, with optional recursive `includes`). We mirror that:
//   - registry URLs are persisted in the `plugin_registries` table.
//   - listMarketplace() fetches + merges every enabled registry. 同一插件来自
//     不同注册表/plugin.json 地址的来源互不合并——每个来源保留为独立条目并带
//     sourceUrl,由前端让用户手动选择安装哪个源头(平台也作为区分维度展示)。
//   - installPlugin(downloadUrl) downloads the archive, extracts it into
//     data/plugins/<id>/, and (re)discovers external plugins so it's live
//     immediately — no restart needed.
//
// 不做任何 GitHub→Gitee 镜像回退(2026-08-12 按用户要求取消):插件包走 raw 仓库
// 文件分发,网络不可达时直接报错,由运维侧自行解决网络,避免镜像 404 掩盖真相。
//
// Security caveat (see docs/RESEARCH-...): external plugins run in the QuickJS
// sandbox (v1.3.0+), so they have no Node process powers; still, the services a
// plugin reaches (e.g. its baseUrl) are configured by the admin, so installing a
// third-party plugin remains a trust decision. The UI surfaces a warning; the
// manifest is validated before it is registered.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { eq } from "drizzle-orm";
import { promisify } from "util";
import { getDataDir } from "../utils/env.js";
import { db } from "../db/index.js";
import { pluginRegistries, settings, plugins } from "../db/schema.js";
import { discoverExternalPlugins } from "./discovery.js";
import { validateManifest } from "./discovery.js";
import type { PluginManifest } from "./types.js";
import { proxyFetch } from "../services/proxy.js";

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
  sourceUrl: string;   // 该条目来自哪个 plugin.json 地址(同一插件不同来源据此区分)
  registryUrl: string; // 该条目归属于哪个注册表(前端按注册表分组展示)
  minAppVersion?: string;
  type?: string;              // 插件类型标签(source/importer/recommender/sync/...)
  capabilities?: string[];    // 能力清单(便于市场页展示"能干什么")
  platforms?: string[];       // source/importer 支持的平台 slug
  manifest?: string;          // 完整 manifest(JSON 字符串),前端配置表单/能力渲染复用
  builtin?: boolean;          // 官方内置插件(随服务端发行,无需安装)
  installed?: boolean;        // 本地已安装(plugins 表有行)
  installedVersion?: string;  // 本地已安装版本(前端据此显示"更新"按钮)
  enabled?: number;           // 当前启用状态(0/1,与 plugins 表一致)
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

// ==================== Official registry bootstrap ====================
//
// With no registry configured the marketplace page is simply empty, so every
// fresh install would need an admin to hand-paste the official URL before they
// could install anything. We seed it once on first boot instead.
//
// Seeding is guarded by a *settings flag*, not by "is this URL already there?".
// That distinction matters: an admin who deliberately removes the official
// registry must not have it silently re-added on the next restart.
//
// 官方源默认走 Gitee raw(2026-08-12 起):插件分发全链路(registry.json /
// plugin.json / 安装包 tar.gz)的地址均指向 gitee.com,与 GitHub 完全解耦——
// GitHub 是否可达不影响插件市场与安装;源码仍同步在 GitHub 仓库。可用
// MUSICFLOW_OFFICIAL_REGISTRY 覆盖:
//   MUSICFLOW_OFFICIAL_REGISTRY=https://example.com/registry.json   (自建/镜像)
//   MUSICFLOW_OFFICIAL_REGISTRY=                                    (空 = 完全关闭)
const OFFICIAL_REGISTRY_URL =
  process.env.MUSICFLOW_OFFICIAL_REGISTRY ??
  "https://gitee.com/ray5378/music-flow-plugins/raw/master/registry.json";

// ==================== 拉取(直连,无镜像回退;可走系统代理) ====================
// 2026-08-12 起取消 GitHub→Gitee 镜像回退:插件包已改 raw 仓库文件分发,
// 直连失败直接抛错,不再猜测镜像地址(避免镜像 404 掩盖真实问题)。
// 2026-08-13 起支持系统设置里的「网络代理」:启用后 registry/plugin.json/安装包
// 全部经 proxyFetch 走代理(undici dispatcher,仅本链路,不影响其它后端网络)。
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const res = await proxyFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const OFFICIAL_REGISTRY_SEEDED_KEY = "official_registry_seeded";

/** Add the official plugin registry on first boot so the marketplace works out
 *  of the box. Idempotent, and never re-adds a registry the admin removed.
 *
 *  MUST run after `initDatabase()` (needs the schema). Returns true only when a
 *  row was actually inserted, so callers/tests can assert on the first run. */
export function seedDefaultRegistry(): boolean {
  const url = OFFICIAL_REGISTRY_URL.trim();
  if (!url) return false; // explicitly opted out (air-gapped deployments)
  try {
    const flag = db
      .select()
      .from(settings)
      .where(eq(settings.key, OFFICIAL_REGISTRY_SEEDED_KEY))
      .get() as any;
    if (flag?.value === "1") return false; // already seeded once — respect removals

    const already = (db.select().from(pluginRegistries).all() as any[]).some((r) => r.url === url);
    if (!already) {
      addRegistry(url);
      console.log(`[REGISTRY] 已添加官方插件注册表: ${url}`);
    }

    const now = new Date().toISOString();
    db.insert(settings)
      .values({ key: OFFICIAL_REGISTRY_SEEDED_KEY, value: "1", updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: "1", updatedAt: now } })
      .run();
    return !already;
  } catch (e: any) {
    // A failed seed must never block boot — the admin can still add the URL by hand.
    console.warn(`[REGISTRY] 官方注册表种子写入失败: ${e?.message || e}`);
    return false;
  }
}

/** The official registry URL in effect (empty string when seeding is opted out).
 *  Exported for diagnostics + tests. */
export function officialRegistryUrl(): string {
  return OFFICIAL_REGISTRY_URL.trim();
}

/** 仓库主页 / blob 浏览页 → 自动补全 registry.json 候选地址(用户可只填网页地址)。
 *  Gitee:  gitee.com/{owner}/{repo}[/blob/{branch}/{path}] → gitee.com/{owner}/{repo}/raw/{branch}/{path}
 *  GitHub: github.com/{owner}/{repo}[/blob/{branch}/{path}] → raw.githubusercontent.com/{owner}/{repo}/{branch}/{path} */
export function registryUrlCandidates(url: string): string[] {
  const u = String(url).trim();
  // blob 浏览页 → raw(如 .../blob/master/registry.json → .../raw/master/registry.json)
  let m = u.match(/^https?:\/\/(?:www\.)?gitee\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (m) return [`https://gitee.com/${m[1]}/${m[2]}/raw/${m[3]}/${m[4]}`];
  m = u.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (m) return [`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`];
  // 仓库主页 → registry.json
  m = u.match(/^https?:\/\/(?:www\.)?gitee\.com\/([^/]+)\/([^/]+)\/?$/);
  if (m) return [`https://gitee.com/${m[1]}/${m[2]}/raw/master/registry.json`];
  m = u.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (m) return [`https://raw.githubusercontent.com/${m[1]}/${m[2]}/master/registry.json`];
  return [];
}

/** Fetch a single registry manifest. Supports either a bare array of plugin
 *  JSON URLs, or an object `{ plugins: [...], includes: [...] }`.
 *  若给定地址不是有效 registry JSON(如填了仓库主页),依次尝试自动补全候选。 */
async function fetchOneRegistry(url: string): Promise<{ plugins: string[]; includes: string[] }> {
  const attempts = [url, ...registryUrlCandidates(url)];
  let lastErr: unknown = null;
  for (const u of attempts) {
    try {
      const res = await fetchWithTimeout(u, 15000);
      const data: any = await res.json();
      if (Array.isArray(data)) return { plugins: data, includes: [] };
      if (data && Array.isArray(data.plugins)) return { plugins: data.plugins, includes: data.includes || [] };
      lastErr = new Error(`${u} 不是有效的注册表 JSON`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`拉取注册表失败: ${url}`);
}

/** 一个注册表分组的聚合结果:用户添加的每一个启用注册表对应一个分组。
 *  - `pluginUrls`:本注册表自身 + 其 `includes` 展开后的全部 plugin.json 地址(组内去重)。
 *  - 跨注册表不去重:同一插件若多个注册表都有,在各组分别出现,由前端按注册表分组展示、用户手动选装。
 *  - `error` 非空表示该注册表(顶层 URL)拉取失败,前端据此显式提示"加载失败",而不是静默消失。 */
export interface RegistryGroup {
  registryUrl: string;
  pluginUrls: string[];
  error?: string;
}

/** 按注册表分组聚合插件引用。
 *
 *  每个启用的注册表独立成组——组内去重、跨组不去重(满足"同一插件可来自多个注册表、
 *  各组独立显示"的需求);且把拉取失败(网络不可达 / 404 / 超时等)的注册表也保留下来
 *  (带 `error`),让前端能显式提示,而不是像以前那样整组静默跳过。 */
export async function collectRegistryGroups(): Promise<RegistryGroup[]> {
  const regRows = listRegistries().filter((r) => r.enabled);
  const groups: RegistryGroup[] = [];
  for (const reg of regRows) {
    const registryUrl = reg.url;
    const seenInGroup = new Set<string>();
    const pluginUrls: string[] = [];
    const seenUrls = new Set<string>(); // 防 includes 成环
    let error: string | undefined;
    const queue = [reg.url];
    while (queue.length) {
      const url = queue.shift()!;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      try {
        const { plugins, includes } = await fetchOneRegistry(url);
        for (const p of plugins) {
          if (seenInGroup.has(p)) continue;
          seenInGroup.add(p);
          pluginUrls.push(p);
        }
        for (const inc of includes) {
          if (!seenUrls.has(inc)) queue.push(inc);
        }
      } catch (e: any) {
        // 顶层注册表 URL 拉取失败 → 整组失败;includes 失败仅跳过该分支。
        if (url === reg.url) error = e?.message || String(e);
      }
    }
    groups.push({ registryUrl, pluginUrls, error });
  }
  return groups;
}

/** Build the marketplace listing.
 *
 *  同一插件的不同来源(不同注册表 / 不同 plugin.json 地址)不按 id 合并——每个
 *  来源保留为独立条目并带 sourceUrl + registryUrl,前端按注册表分组展示、用户
 *  手动选择安装哪个源头;同一 (id, sourceUrl) 组合去重(注册表递归 includes
 *  可能重复列出同一地址)。 */
export async function listMarketplace(): Promise<RegistryEntry[]> {
  const groups = await collectRegistryGroups();
  const seen = new Set<string>();
  const out: RegistryEntry[] = [];
  for (const g of groups) {
    for (const url of g.pluginUrls) {
      try {
        const res = await fetchWithTimeout(url, 15000);
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
          sourceUrl: url,
          registryUrl: g.registryUrl,
          minAppVersion: m.minAppVersion,
          type: m.type,
          capabilities: Array.isArray(m.capabilities) ? m.capabilities : undefined,
          platforms: Array.isArray(m.platforms) ? m.platforms : undefined,
          manifest: JSON.stringify(m),
        };
        // key 含 registryUrl:同一插件来自不同注册表时各自保留为独立条目,
        // 前端按 registryUrl 分组即可分别展示、独立安装。
        const key = `${m.id}::${url}::${g.registryUrl}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      } catch (e: any) {
        console.warn(`[REGISTRY] 无法读取插件清单 ${url}: ${e?.message || e}`);
      }
    }
  }
  return out;
}

/** 安装/升级外置插件后同步 DB 行：已存在（升级）则刷新 manifest/version/
 *  description（保留用户 enabled/config）。修复"升级提示成功但插件页版本不变"。
 *  注意：**不改 name 列**——plugins.name 语义 = 插件 id（seed 播种时
 *  name=manifest.id），getPluginConfig/getSourcePluginConfig 等均按 name=id 查询，
 *  误改会导致升级后插件配置/启用状态全部失效。Exported for unit testing. */
export function syncPluginRowAfterInstall(manifest: PluginManifest): void {
  const existing = db.select().from(plugins).where(eq(plugins.name, manifest.id)).get() as any;
  if (!existing) return;
  db.update(plugins)
    .set({
      manifest: JSON.stringify(manifest),
      version: manifest.version,
      description: manifest.description || existing.description,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(plugins.name, manifest.id))
    .run();
}

/** Download + extract a plugin archive into data/plugins/<id>/ and (re)discover
 *  it. Uses the OS `tar` (handles both .zip and .tgz on modern systems). */
export async function installPlugin(downloadUrl: string): Promise<{ id: string; name: string }> {
  const tmp = path.join(getDataDir(), "plugins", `.install-${Date.now().toString(36)}`);
  const archive = path.join(tmp, "plugin.archive");
  fs.mkdirSync(tmp, { recursive: true });
  try {
    // 直连下载(无镜像回退),失败抛错由上层转成可读错误。
    const res = await fetchWithTimeout(downloadUrl, 25000);
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
    // 升级（同 id 重装）必须 reload：dispose 旧沙箱、覆盖注册，并同步 DB 行版本，
    // 否则内存/DB 都停留在旧版本（此前"升级成功但插件页仍显示旧版本"的根因）。
    syncPluginRowAfterInstall(manifest);
    await discoverExternalPlugins(APP_VERSION, undefined, { reload: true });
    return { id: manifest.id, name: manifest.name };
  } catch (e) {
    // 把真实失败原因打进服务端日志(响应体只有 error message,容器日志此前看不到原因)。
    console.error(`[PLUGIN] 安装失败(downloadUrl=${downloadUrl}):`, e);
    throw e;
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
