// ==================== 播放来源优先级(Stream source priority) ====================
//
// 「插件管理 → 媒体获取」页可调顺序的来源优先级列表,用于控制**播放平台歌曲**时
// 按什么顺序去各源**插件**找可播的流(排在前的先试,试不通再试下一个)。
//
// 单级粒度(仅「插件级」):
//   - 列表条目就是一个 `pluginId`;
//   - 该插件内部用哪个平台(网易/酷我/酷狗/QQ/咪咕)、按什么顺序取源,是插件自己的事,
//     宿主不暴露、不干预 —— 因此**没有** `pluginId:platform` 这种平台级条目。
//
// 与「音乐下载」配置页的 `fetch.sourcePriority` **完全独立**:
//   - 存储键不同:此处用 `stream.sourcePriority`,下载链路用 fetch 配置里的字段;
//   - 消费链路不同:仅换源兜底(services/source/online/streamFallback.ts)读取本键,
//     不影响也不受下载链路影响。
//
// 语义(产品已确认):
//   - 列表非空 → findFallbackStream 严格按列表顺序逐项尝试;歌曲「本尊插件」不再享有
//     特权。列表内全部失败即判定无源(不再回退到默认顺序);
//   - 列表为空 → 保持原行为(本尊优先 → 按启用顺序取首个齐备源插件),向后兼容。

import { getSetting, setSetting } from "../../settings.js";
import { getEnabledSourcePlugins } from "../../../plugins/registry.js";

/** settings 表键。刻意与下载链路的 fetch.sourcePriority 区分(独立存储)。 */
export const STREAM_SOURCE_PRIORITY_KEY = "stream.sourcePriority";

/** 优先级列表长度上限(防御性;正常 UI 远达不到)。 */
export const MAX_STREAM_SOURCE_PRIORITY = 50;

/**
 * 规范化优先级列表:仅接受字符串条目,统一收敛为**插件级**(plugin id)。
 *   - 非字符串项、trim 后为空的项 → 丢弃;
 *   - 取**首个 `:` 之前**的部分作为 pluginId(历史遗留的 `plugin:platform` 一律收敛为
 *     其插件级,作为升级容错);`:` 前为空(如 `:kuwo`)→ 丢弃该条;
 *   - 按 pluginId 去重(保留首次出现顺序);
 *   - 按 MAX_STREAM_SOURCE_PRIORITY 截断。
 * 非数组输入 → []。
 */
export function normalizeStreamSourcePriority(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s) continue;
    const idx = s.indexOf(":");
    const pluginId = (idx < 0 ? s : s.slice(0, idx)).trim();
    if (!pluginId) continue;
    if (seen.has(pluginId)) continue;
    seen.add(pluginId);
    out.push(pluginId);
    if (out.length >= MAX_STREAM_SOURCE_PRIORITY) break;
  }
  return out;
}

/** 读取播放来源优先级(settings,默认 [])。缺失/非法 JSON → []。 */
export function getStreamSourcePriority(): string[] {
  const raw = getSetting(STREAM_SOURCE_PRIORITY_KEY, "");
  if (!raw) return [];
  try {
    return normalizeStreamSourcePriority(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * 保存播放来源优先级:校验+规范化后落库(写前已 setSetting 失效读缓存,即时生效)。
 * 空列表会显式写入 "[]" 以覆盖旧值(区分「未配置」与「配置为空」)。
 * 返回实际落库的规范化结果,供调用方回读。
 */
export function setStreamSourcePriority(list: unknown): string[] {
  const normalized = normalizeStreamSourcePriority(list);
  setSetting(STREAM_SOURCE_PRIORITY_KEY, JSON.stringify(normalized));
  return normalized;
}

/** 可选来源项(仅插件级)。value 即写入优先级列表的 plugin id。 */
export interface AvailableStreamSource {
  value: string;
  label: string;
}

/**
 * 枚举「可加入优先级列表」的来源(供前端下拉),**仅插件级**:
 * 所有**已启用**的源插件,只要 capabilities 含 `stream` 或 `search`
 * (具备出流或检索能力的源插件都算候选),每个插件恰好一条
 * `{ value: manifest.id, label: manifest.name || manifest.id }`。
 * 不写死任何插件名 —— 新装源插件自动出现,零代码改动。
 */
export function listAvailableStreamSources(): AvailableStreamSource[] {
  const out: AvailableStreamSource[] = [];
  for (const { manifest } of getEnabledSourcePlugins()) {
    const caps = manifest.capabilities ?? [];
    if (!caps.includes("stream") && !caps.includes("search")) continue;
    out.push({ value: manifest.id, label: manifest.name || manifest.id });
  }
  return out;
}
