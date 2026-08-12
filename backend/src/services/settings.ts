// 全局键值设置(settings 表)的读写,带短 TTL 内存缓存。
// 供 lyrics/covers 行为开关(lyrics.onDemand / cover.providerId 等)与
// admin 端点共用;写操作立即失效缓存,开关改动即时生效。
import { sqlite } from "../db/index.js";

const cache = new Map<string, { value: string; at: number }>();
const TTL = 5000; // 5s:读是热路径(getCoverArt),写后由 setSetting 主动失效

export function getSetting(key: string, def = ""): string {
  const c = cache.get(key);
  if (c && Date.now() - c.at < TTL) return c.value;
  let v = def;
  try {
    const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
    if (r?.value !== undefined && r?.value !== null) v = String(r.value);
  } catch { /* settings 表未就绪时按默认值 */ }
  cache.set(key, { value: v, at: Date.now() });
  return v;
}

export function getSettingBool(key: string, def: boolean): boolean {
  const v = getSetting(key, def ? "true" : "false");
  return v === "true" || v === "1";
}

export function setSetting(key: string, value: string): void {
  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(key, value, new Date().toISOString());
  cache.set(key, { value, at: Date.now() });
}
