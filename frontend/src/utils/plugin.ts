// 插件 manifest / config 解析工具。
//
// /v1/plugins 返回的 manifest 与 config 是 **JSON 字符串**(后端从 DB 快照读出,
// 仅对注册插件把 manifest 覆盖为 JSON.stringify 后的值),前端各页面消费前必须
// 解析;解析失败/缺失一律回落空对象,避免「取属性恒 undefined」类 bug(见
// 歌单详情页在线源探测的历史问题)。

/** 解析一个可能是 JSON 字符串的值,失败/缺失回落 fallback。 */
export function parsePluginJson<T = any>(v: any, fallback: T = {} as T): T {
  if (typeof v !== "string") return (v ?? fallback) as T;
  try {
    return JSON.parse(v || "{}") as T;
  } catch {
    return fallback;
  }
}

/** 解析插件行的 manifest。 */
export function parseManifest(plugin: any): any {
  return parsePluginJson(plugin?.manifest);
}

/** 解析插件行的 config。 */
export function parseConfig(plugin: any): any {
  return parsePluginJson(plugin?.config);
}
