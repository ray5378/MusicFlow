// ==================== Core plugin: 导入命中门禁(core-import-gate) ====================
// 服务端内置行为插件(端侧零改动,可随时开关):
// - 开启:所有在线歌曲导入/匹配(搜索匹配、平台 id 直通、宿主补全、上游歌单导入)
//   必须通过「规范化标题 + 歌手(强制)+ 专辑一致 + 时长容差」门禁才落库;
// - 关闭:退回门禁前行为?——不。门禁的标题+歌手是强制底线,关闭本插件仅关闭
//   「专辑一致」与「时长核实」两个可调维度(与配置项一一对应);
// - 配置:albumRequired(专辑一致,默认开)/ durationTolerance(时长容差秒,默认 1)。
// 纯配置插件:无运行时 impl 行为,门禁逻辑在 services/source/online/importGate.ts。
import type { PluginManifest } from "../../../plugins/types.js";

export const IMPORT_GATE_PLUGIN_ID = "core-import-gate";

export const importGateManifest: PluginManifest = {
  id: IMPORT_GATE_PLUGIN_ID,
  name: "导入命中门禁",
  version: "1.1.0",
  type: "core",
  description:
    "所有在线歌曲导入/匹配的统一关卡:候选必须与期望曲目同时命中「规范化标题 + 规范化歌手(强制)+ 专辑一致(开关)+ 时长容差」才允许导入,从源头拦截元数据冒名的假源。",
  capabilities: ["importGate"],
  defaultEnabled: true,
  configSchema: [
    { key: "albumRequired", label: "专辑一致", type: "switch", default: true, help: "导入要求候选专辑与期望专辑一致(版本区分靠专辑)。关闭后仅按标题+歌手+时长匹配" },
    { key: "durationTolerance", label: "时长容差(秒)", type: "number", default: 1, help: "候选与期望的时长差上限(秒级;默认 1,防误导入不同版本)" },
    { key: "reverifyUserPicked", label: "亲选歌曲二次门禁", type: "switch", default: false, help: "开启后,歌曲搜索「加入库」的用户亲选歌曲在后台静默重验一次导入门禁;未命中的仍会入库(尊重亲选语义,不删除),但任务结果会标注未命中清单供人工甄别" },
  ],
  i18n: {
    en: {
      name: "Import Match Gate",
      description:
        "A unified gate for all online song imports/matches: a candidate must simultaneously hit normalized title + artist (mandatory), matching album (switchable) and duration within tolerance before it can be imported, blocking metadata-spoofed fake sources at the root.",
      fields: {
        albumRequired: {
          label: "Require matching album",
          help: "Import requires the candidate album to match the expected album (album distinguishes versions). When off, match by title + artist + duration only.",
        },
        durationTolerance: {
          label: "Duration tolerance (seconds)",
          help: "Maximum duration difference between candidate and expected track (second-level; default 1, to avoid importing different versions).",
        },
        reverifyUserPicked: {
          label: "Re-verify user-picked songs",
          help: "When on, songs the user explicitly adds from search results are silently re-checked against the import gate in the background; non-matching ones are still imported (user-pick semantics, never deleted), but the task result flags them for review.",
        },
      },
    },
  },
  documentation: `### 导入命中门禁(服务端内置)
所有在线歌曲导入/匹配入口(歌单 auto-match、单曲匹配、宿主补全 host.sources.complete、上游歌单导入/每日推荐)统一经过本门禁:候选必须同时命中「规范化标题 + 规范化歌手(强制,不可关)+ 专辑一致(可关,默认开)+ 时长差 ≤ 容差(可设,默认 1 秒)」才允许导入;任何一条不中,条目保持未匹配占位,绝不落库。

- 规范化口径与「同曲多源组」一致(normalizeGroupText),但配置独立;
- 期望侧缺字段(无专辑/无歌手/无时长)时对应维度跳过;候选侧缺字段视为无法核实,不命中;
- 平台 id 直通导入已废除:所有条目一律经在线搜索交叉比对后再导入。`,
};

export const importGatePlugin = {
  // 纯配置插件:行为由 importGate.ts 的 passesImportGate 实现,读取本插件配置。
  id: IMPORT_GATE_PLUGIN_ID,
};
