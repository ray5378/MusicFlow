// 在线(web)歌曲的来源解析:songs.source_data.source(平台 id)+ plugin_entry(插件 id)。
// 所有歌曲序列化点统一经此函数暴露来源字段,供前端渲染「来源」列(平台徽标 + 插件名)。
// 本地歌曲不是 web 类型,一律返回空来源(前端不显示徽标)。
export interface SongSourceInfo {
  isWeb: boolean;
  /** 平台 id,如 netease / qq / kugou;未知平台为空串 */
  sourcePlatform: string;
  /** 来源插件 id,如 go-music-dl;非插件来源为空串 */
  sourcePluginId: string;
}

export function songSourceInfo(song: {
  type?: string | null;
  pluginEntry?: string | null;
  sourceData?: string | null;
  path?: string | null;
}): SongSourceInfo {
  if (song.type !== "web") return { isWeb: false, sourcePlatform: "", sourcePluginId: "" };
  const pluginId = song.pluginEntry || "";
  let source = "";
  try {
    const sd = JSON.parse(song.sourceData || "{}");
    if (sd && typeof sd.source === "string") source = sd.source;
  } catch {
    // source_data 损坏则忽略,走 path 兜底
  }
  if (!source && song.path) {
    // path 约定 "web:<plugin>:<source>";早期版本可能缺 source(退化为 "web:<plugin>")。
    const rest = (song.path || "").replace(/^web:/, "");
    const idx = rest.lastIndexOf(":");
    if (idx > 0) {
      const plugin = rest.slice(0, idx);
      const cand = rest.slice(idx + 1);
      if (cand && cand !== plugin) source = cand;
    }
  }
  return { isWeb: true, sourcePlatform: source, sourcePluginId: pluginId };
}
