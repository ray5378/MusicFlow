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
import { discoverExternalPlugins } from "./discovery.js";
import { createLogger } from "../utils/logger.js";

const APP_VERSION = process.env.APP_VERSION || "dev";
let timer: NodeJS.Timeout | null = null;
let watcher: fs.FSWatcher | null = null;

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

/** Begin watching data/plugins for changes. Safe to call once at boot. */
const log = createLogger("PLUGIN-HOTRELOAD");
export function startPluginHotReload(): void {
  const root = path.join(getDataDir(), "plugins");
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  if (watcher) return; // idempotent
  try {
    // recursive: true is supported on Node >=16 (macOS/Windows) and Linux.
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
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
