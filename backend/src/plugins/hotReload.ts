// ==================== External plugin hot-reload ====================
//
// songloft reloads a plugin the moment its file is re-uploaded — no restart.
// We can't safely unload an ES module, but we CAN re-run discovery: it
// re-imports each data/plugins/<id>/index.js (fresh module graph), re-registers
// the manifest, and reseeds the DB row. So editing a plugin file + saving is
// picked up within a second. A debounce coalesces editor save storms.

import fs from "fs";
import path from "path";
import { getDataDir } from "../utils/env.js";
import { discoverExternalPlugins, PLUGIN_FILES_DIR } from "./discovery.js";
import { createLogger } from "../utils/logger.js";

const APP_VERSION = process.env.APP_VERSION || "dev";
let timer: NodeJS.Timeout | null = null;
let watcher: fs.FSWatcher | null = null;

/**
 * 某个 fs.watch 事件是否落在**插件私有数据目录** `<插件目录>/files/` 内。
 *
 * 这条过滤为什么必须存在:`<pluginDir>/files` 是 host.fs 的可写根(discovery.ts
 * makeFsApi),也就是插件的**运行期写入区**(洛雪音源脚本缓存、会话态、下载的临时文件…)——
 * 它不是代码也不是配置。若不过滤,链路会是:
 *
 *   插件写自己的缓存 files/x.js
 *     → 递归 watch 命中 → 全量热重载
 *     → dispose 所有外置插件沙箱(含 jsenv 子环境)
 *     → 取链 pipeline 无退避重试,重建后再次踩 teardown
 *
 * 一次磁盘缓存写就被放大成一轮沙箱 teardown 风暴(见 discovery.ts safeDisposeEntry 的复盘)。
 *
 * 判定精度(要求:只吞 files/,绝不能吞代码/配置):
 *   - 相对路径(linux 递归 watch 的常见形态)"lx-source/files/a.js"       → true
 *   - 更深层      "lx-source/files/sub/deep.js"                          → true
 *   - 绝对路径    "/data/plugins/lx-source/files/a.js"                   → true
 *   - 反斜杠形态  "lx-source\\files\\a.js"                               → true
 *   - 插件根代码  "lx-source/index.js" / "lx-source/plugin.json"         → false(照常重载)
 *   - 同名的普通文件 "lx-source/files.json"                              → false(不是目录)
 *   - 插件 id 恰好叫 files 时的根目录文件 "files/index.js"               → false
 *
 * @param root 被监听的插件根目录(getDataDir()/plugins)
 * @param filename fs.watch 回调给出的路径(相对或绝对)
 */
export function isPluginPrivateWrite(root: string, filename: string): boolean {
  const raw = String(filename || "");
  if (!raw) return false;
  // 绝对路径先规约成相对插件根的形式;不在根下的一律不管(不是插件目录的事)。
  let rel = raw;
  if (path.isAbsolute(raw)) {
    rel = path.relative(root, raw);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  }
  // 分隔符兼容:容器是 "/",Windows 是 "\\",path.relative 产出也可能混着来 —— 一律切成段。
  const segs = rel.split(/[\\/]/).filter(Boolean);
  // 必须形如 <id>/<files>/... :第二段才是私有目录,第一段是插件 id(code + 配置都在第一段下)。
  return segs.length >= 2 && segs[1] === PLUGIN_FILES_DIR;
}

function scheduleReload(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    try {
      // reload 模式:同 id 外置插件先 dispose 旧 QuickJS VM 再覆盖注册,文件改动即时生效。
      const loaded = await discoverExternalPlugins(APP_VERSION, undefined, { reload: true });
      if (loaded > 0) log.info(`[PLUGIN-HOTRELOAD] 重新发现 ${loaded} 个外置插件`);
    } catch (e: any) {
      log.error("重载失败", { err: e?.message || e });
    }
  }, 800);
}

/** Begin watching data/plugins for changes. Safe to call once at boot.
 *  @param rootOverride 仅测试用:把监听根指到临时目录(生产不传,语义不变)。 */
const log = createLogger("PLUGIN-HOTRELOAD");
export function startPluginHotReload(rootOverride?: string): void {
  const root = rootOverride ?? path.join(getDataDir(), "plugins");
  if (!rootOverride && !fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  if (watcher) return; // idempotent
  try {
    // recursive: true is supported on Node >=16 (macOS/Windows) and Linux.
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      // 仅 regression 测试用:临时短路 files/ 过滤,证明该守卫确有判别力
      // (生产恒为 false,见 tests/plugins/pluginHotReloadFiles.test.ts)。
      const filterDisabled = process.env.MF_HOTRELOAD_NO_FILES_FILTER === "1";
      if (!filterDisabled && isPluginPrivateWrite(root, String(filename))) {
        log.debug(`[PLUGIN-HOTRELOAD] 忽略插件运行期写入(非代码变更): ${String(filename)}`);
        return;
      }
      scheduleReload();
    });
    watcher.on("error", (e: any) => console.warn("[PLUGIN-HOTRELOAD] watch error:", e?.message || e));
    log.info("[PLUGIN-HOTRELOAD] 已监听 data/plugins 变更");
  } catch (e: any) {
    console.warn("[PLUGIN-HOTRELOAD] 无法启动监听(将需重启后端以加载新插件):", e?.message || e);
  }
}

/** Stop watching (used on shutdown / tests). */
export function stopPluginHotReload(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (watcher) { watcher.close(); watcher = null; }
}
