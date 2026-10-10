// ==================== fetch 生效配置存取（settings 覆盖项 → FetchConfig） ====================
//
// routes/api/fetch.ts 与 upgradeScheduler 原本各持一份同口径的覆盖项解析（重复实现），
// jobRunner 也要读生效配置做写目录预检 → 统一下沉到本文件。
// config.ts 刻意保持零 IO，故 IO 层独立在这里。
import { getSetting, setSetting } from "../settings.js";
import { resolveFetchConfig, type FetchConfig } from "./config.js";

/** settings 表里的配置覆盖项键名（与历史值 "fetch.config" 保持一致）。 */
export const FETCH_CONFIG_KEY = "fetch.config";

/** 读取已存配置覆盖项（坏 JSON / 非对象一律视作无覆盖，不抛）。 */
export function readFetchConfigOverride(): Partial<FetchConfig> {
  const raw = getSetting(FETCH_CONFIG_KEY, "");
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Partial<FetchConfig>) : {};
  } catch {
    return {};
  }
}

/** 当前生效配置 = 默认值与已存覆盖项合并。 */
export function currentFetchConfig(): FetchConfig {
  return resolveFetchConfig(readFetchConfigOverride());
}

/** 保存配置覆盖项（整体替换 / 合并语义由调用方决定，这里只负责落 settings）。 */
export function saveFetchConfigOverride(override: Partial<FetchConfig>): void {
  setSetting(FETCH_CONFIG_KEY, JSON.stringify(override));
}
