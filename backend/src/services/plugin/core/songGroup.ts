// ==================== Core plugin: 同曲多源组(song-group) ====================
// 服务端内置行为插件(端侧零改动,可随时开关):
// - 开启:新歌导入并入组 + 序列化输出 groupId/sources(各端合并展示/播放优选
//   直接消费,无需端侧任何代码);
// - 关闭:不再分组,序列化不输出组字段(端侧自然回到平铺 + 按原源播放)。
// 匹配规则可配置:专辑一致(albumRequired)与时长容差(durationTolerance,秒)。
import type { PluginManifest } from "../../../plugins/types.js";
import type { PluginHost } from "../../../plugins/host.js";
import {
  buildGroupKey,
  assignSongGroups,
  findGroupForSong,
  normalizeGroupText,
  GroupableSong,
} from "../../../utils/songGroup.js";
import { getPluginConfig, isCapabilityEnabled } from "../../../plugins/registry.js";

export const SONG_GROUP_PLUGIN_ID = "core-song-group";

export const songGroupManifest: PluginManifest = {
  id: SONG_GROUP_PLUGIN_ID,
  name: "同曲多源组",
  version: "1.0.0",
  type: "core",
  description:
    "把本地/WebDAV 曲库与插件平台收录的同一首歌归为一组(规范化标题+歌手+专辑一致,时长差≤容差),组内 local>webdav>web 排序。开启后各端自动按组合并展示并按组优选播放,端侧零改动;关闭后恢复平铺与按原源播放。",
  capabilities: ["songGroup"],
  defaultEnabled: true,
  configSchema: [
    { key: "albumRequired", label: "专辑一致", type: "switch", default: true, help: "分组要求专辑也一致(版本区分靠专辑)。关闭后仅按标题+歌手+时长匹配" },
    { key: "durationTolerance", label: "时长容差(秒)", type: "number", default: 1, help: "组内成员时长差上限(秒级;默认 1,防误合并不同版本)" },
  ],
  // 插件侧 i18n 字典:默认文案即中文,故 zh 省略、只补 en。前端按当前界面语言取用。
  i18n: {
    en: {
      name: "Same-Track Multi-Source Group",
      description:
        "Group the same song from the local/WebDAV library and plugin-platform sources together (normalized title + artist + matching album, duration diff <= tolerance), sorted local > webdav > web within a group. When on, all clients auto-merge the group for display and play the preferred source with zero client changes; when off, fall back to a flat list and source playback.",
      fields: {
        albumRequired: {
          label: "Require matching album",
          help: "Grouping requires the album to match too (album distinguishes versions). When off, match by title + artist + duration only.",
        },
        durationTolerance: {
          label: "Duration tolerance (seconds)",
          help: "Maximum duration difference among group members (second-level; default 1, to avoid merging different versions).",
        },
      },
    },
  },
  documentation: `### 同曲多源组(服务端内置)
同一首歌可能同时存在于本地 / WebDAV 曲库与插件平台(QQ 音乐 / 网易云等)。本插件按「规范化标题 + 歌手 + 专辑一致 + 时长差 ≤ 容差」把它们归为同曲多源组,并写入 \`songs.group_id\` / \`group_key\`。

- **展示**:开启后服务端在歌曲列表 / 歌单 / 收藏序列化时输出 \`groupId\` / \`sources\`(组内成员含自身、local > webdav > web 排序),各端(Web / 客户端 / HA 卡片)自动按组合并展示主行,无需端侧任何代码;
- **播放**:配合「播放优选」插件(\`playPreference\`),所有播放入口自动落组内 local / WebDAV 主源,Local 不可用时自动回退平台源;
- **关闭**:不再分组、序列化不输出组字段,各端自动回到平铺展示与按原源播放;
- **存量数据**:关闭再开启不会自动重算历史分组,需触发全量重算(重算脚本见发布记录)。

匹配规则可调:\`专辑一致\` 关闭后按标题+歌手+时长匹配(会合并不同专辑的同名版本);\`时长容差\` 默认 1 秒。`,
};

/** 分组 key(按插件配置是否要求专辑一致)。 */
export function groupKeyFor(host: PluginHost, title: string, artist: string, album?: string | null): string {
  const cfg = host.config || {};
  return buildGroupKey(title, artist, album, cfg.albumRequired !== false);
}

/** 插件总开关:同曲多源组是否启用(端侧零改动,各端靠此门面读取)。 */
export function songGroupEnabled(): boolean {
  return isCapabilityEnabled("songGroup");
}

/** 无 host 快捷读取:分组 key(未启用/无配置时按默认规则)。 */
export function groupKeyForConfig(title: string, artist: string, album?: string | null): string {
  const cfg = getPluginConfig(SONG_GROUP_PLUGIN_ID);
  return buildGroupKey(title, artist, album, !cfg || cfg.albumRequired !== false);
}

/** 无 host 快捷读取:找可并入的组(容差按插件配置;未启用时按默认容差)。 */
export function findGroupForSongConfig(
  candidates: { id: string; groupId: string | null; duration: number | null }[],
  duration: number | null,
): string | null {
  const cfg = getPluginConfig(SONG_GROUP_PLUGIN_ID);
  const tolerance = cfg && Number(cfg.durationTolerance) > 0 ? Number(cfg.durationTolerance) : 1;
  return findGroupForSong(candidates, duration, tolerance);
}

/** 新歌导入时找可并入的组(容差按插件配置)。 */
export function findGroupForSongWithConfig(host: PluginHost, candidates: { id: string; groupId: string | null; duration: number | null }[], duration: number | null): string | null {
  const cfg = host.config || {};
  const tolerance = Number(cfg.durationTolerance) > 0 ? Number(cfg.durationTolerance) : 1;
  return findGroupForSong(candidates, duration, tolerance);
}

/** 存量/批量重算(供后台任务与运维脚本调用)。 */
export function assignAllGroups(host: PluginHost, rows: GroupableSong[]) {
  const cfg = host.config || {};
  const tolerance = Number(cfg.durationTolerance) > 0 ? Number(cfg.durationTolerance) : 1;
  return assignSongGroups(rows, {
    tolerance,
    albumRequired: cfg.albumRequired !== false,
  });
}

export const songGroupPlugin = {
  normalize: normalizeGroupText,
  groupKey: groupKeyFor,
  findGroup: findGroupForSongWithConfig,
  assignAll: assignAllGroups,
};
