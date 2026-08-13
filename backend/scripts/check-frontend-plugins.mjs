#!/usr/bin/env node
// scripts/check-frontend-plugins.mjs
//
// 架构守卫(前端侧):外部插件的「配置 / 详情」页面必须 100% 由插件自身声明驱动
// (configSchema / documentation / manifest 元数据)。核心代码不得:
//   (1) 写死某个具体插件 id 来给该插件定制 UI —— UI 只能经 manifest 驱动;
//   (2) 把核心级全局功能(如「媒体获取」歌词/封面 A/B/C)嵌进插件详情弹窗。
//
// 违反案例(已修复于 v1.7.5):媒体获取曾被按能力挂载进 go-music-dl 的弹窗——
// 实质是核心全局设置,正确位置是独立的「媒体获取」Tab,与任何单个插件解耦。
//
// 该脚本零依赖,直接用 `node` 运行,接入 ci.yml 的 frontend-plugin-isolation 作业。
// 与 backend/scripts/check-core.mts(后端:核心不直连内置插件实现)互为前后端对称守卫。

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", ".."); // backend/scripts -> repo root
// 默认校验仓库内插件管理页;可经首个 CLI 参数覆盖(用于本地负向冒烟测试)。
const argPath = process.argv[2];
const viewPath = argPath
  ? resolve(argPath)
  : resolve(
      repoRoot,
      "frontend",
      "src",
      "views",
      "admin",
      "Plugins",
      "index.vue",
    );

let failures = 0;
function fail(msg) {
  console.error("  \u2717 " + msg);
  failures++;
}
function crit(cond, msg) {
  if (cond) console.log("  \u2713 " + msg);
  else fail(msg);
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (!existsSync(viewPath)) {
  console.error(`\u2717 找不到插件管理页: ${viewPath}`);
  process.exit(1);
}
const src = readFileSync(viewPath, "utf8");

console.log("[前端插件隔离守卫] 校验:", viewPath);

// ---- 已知插件 id(内置 + 官方外置家族)。
//      UI 只能经 manifest 驱动,不得以字面量写死这些 id 来定制某插件的页面。 ----
const PLUGIN_IDS = [
  "go-music-dl",
  "go-music-dl-lyrics",
  "go-music-dl-cover",
  "qq-playlist-importer",
  "netease-playlist-importer",
  "musicflow-file-importer",
  "daily-recommend",
  "local-recommend",
  "playlist-sync",
  "dlna-renderer",
];

// 规则1:插件管理页不得写死具体插件 id。
//       仅匹配「带引号字面量」(如 'go-music-dl' / "go-music-dl"),
//       放行注释里的裸词(如 <!-- No field is hardcoded to go-music-dl. -->)。
let r1 = false;
for (const id of PLUGIN_IDS) {
  const re = new RegExp(`['"\`]\\s*${escapeRe(id)}\\s*['"\`]`);
  if (re.test(src)) {
    fail(`插件管理页写死了插件 id "${id}"——UI 必须只由 manifest 驱动,不得按具体插件定制页面。`);
    r1 = true;
  }
}
crit(!r1, "规则1:插件管理页无写死插件 id(UI 完全由 manifest 声明驱动)");

// ---- 规则2:核心全局功能不得嵌进插件详情弹窗 ----
const dlgStart = src.indexOf('<el-dialog v-model="showConfigDialog"');
if (dlgStart === -1) {
  fail('未找到插件详情弹窗(showConfigDialog)——无法校验弹窗内容隔离。');
} else {
  const dlgEnd = src.indexOf("</el-dialog>", dlgStart);
  if (dlgEnd === -1) {
    fail("插件详情弹窗缺少闭合 </el-dialog>,无法界定弹窗范围。");
  } else {
    const dlg = src.slice(dlgStart, dlgEnd);

    // 媒体获取等核心全局设置的标识,绝不允许出现在插件弹窗内。
    const MEDIA_IDS = [
      "lyricsSettings",
      "coversSettings",
      "lyricsBackfill",
      "coversBackfill",
      "lyricProviderPlugins",
      "coverProviderPlugins",
      "providerLabel",
      "saveMediaSettings",
      "startBackfill",
      "backfillText",
      "loadMediaSettings",
    ];
    let leak = false;
    for (const m of MEDIA_IDS) {
      const re = new RegExp(`\\b${escapeRe(m)}\\b`);
      if (re.test(dlg)) {
        fail(`插件详情弹窗内混入了核心功能 "${m}"——全局设置不得嵌进单个插件页面。`);
        leak = true;
      }
    }
    crit(!leak, "规则2:插件详情弹窗未嵌入核心全局功能(媒体获取等)");

    // 正向保障:弹窗确实渲染插件声明内容(configSchema / documentation)。
    const hasManifest = /\bconfigFields\b/.test(dlg) && /parseManifest/.test(dlg);
    crit(hasManifest, "规则2b:插件弹窗渲染 manifest 声明内容(configSchema / documentation)");
  }
}

// ---- 规则3:媒体获取作为独立、能力驱动的入口存在(而非回退进插件弹窗) ----
const hasMediaTab =
  /媒体获取/.test(src) || /name\s*===\s*["']media["']/.test(src);
crit(hasMediaTab, "规则3:存在独立的「媒体获取」入口(不在插件弹窗内)");

const capabilityDriven =
  /lyricProviderPlugins/.test(src) &&
  /coverProviderPlugins/.test(src) &&
  /capabilities/.test(src);
crit(capabilityDriven, "规则3b:媒体获取来源下拉由 capabilities 能力驱动(非写死插件)");

if (failures > 0) {
  console.error(`\n\u2717 前端插件隔离校验失败:${failures} 项违规`);
  process.exit(1);
}
console.log(
  "\n\u2713 前端插件隔离校验通过:插件页面仅渲染插件自身声明内容,核心功能未耦合进插件弹窗。",
);
