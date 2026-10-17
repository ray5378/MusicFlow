#!/usr/bin/env node
// ==================== 标签写入 + 标签修复链路守卫 ====================
//
// 本脚本锁的是「下载期写标签」与「标签修复」两条写入链路的**静默失效契约**。
// 这些契约的共同点是：断了不报错、不会让任何既有动态用例变红，只会悄悄产出脏数据、
// 丢数据或让候选池永不收敛 —— 只有在用户发现「封面没了 / 碟号是垃圾值 / 待修复永远不降」
// 时才暴露。故逐条用源码级断言钉死。
//
// 十条规则：
//   R1 碟号纪律：成品文件**不写也不留** DISCNUMBER/DISCTOTAL。tagWriter 必须显式
//       清空继承来的碟号（`-metadata disc=`），且**不得**写入任何碟号值。
//   R2 保留内嵌封面：标签修复路径 keepSourceCover **恒为 true**；下载路径按 embedCover 判定。
//       否则「只补 genre/track」的重写会把源文件已有封面静默丢掉（2026-10-17 240 实测）。
//   R3 中文字形统一：provider 文本字段的简繁转换必须收敛到 tagWriter.applyTagsVariant
//       唯一实现，且下载期与修复期两条路径都真的调用它（默认简体）。
//   R4 终态不可得：真缺标签但各来源都拿不到的歌必须落 outcome='unobtainable' 标记（带 30 天
//       TTL 自愈），否则候选池永不收敛（实测 96% 未命中、池子无限膨胀）。
//   R5 待修口径：pending 必须 = DB 预筛「缺歌词/封面/专辑」集合 − 已落完成标记集合，
//       与扫描阶段 isTagRepairMarked 的跳过口径一致，否则界面「待修复」长期停在原位。
//   R6 写入安全：容器白名单 + 原子写（tagtmp → rename，绝不原地覆盖）+ mp3 写 ID3v2.3。
//   R7 QQ 搜索端点：必须用 search_for_qq_cp（client_search_cp 在 240 生产恒 500、体 0 字节）。
//   R8 QQ 限流：基础间隔 1.2s + 300~800ms 随机抖动（防同出口 IP 高频被封）。
//   R9 风格来源：genre 必须取自 info.genre.content[].value（可读名），不得取 track_info.genre（数字码）。
//   R10 时长单位：统一为**秒**；网易云给毫秒必须 /1000 换算，否则时长闸门恒失败、拿不到封面/元数据。
//
// 零依赖 node 脚本（与 check-dead-song-purge.mjs 同款，共用 strip-comments），挂 ci.yml 守卫 job。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const TAGWRITER = "backend/src/services/fetch/tagWriter.ts";
const TAGREPAIR = "backend/src/services/fetch/tagRepair.ts";
const MARKER = "backend/src/services/fetch/tagRepairMarker.ts";
const ORCH = "backend/src/services/fetch/orchestrator.ts";
const CONFIG = "backend/src/services/fetch/config.ts";
const ROUTES = "backend/src/routes/api/fetch.ts";
const TAGPROVIDER = "backend/src/services/plugin/tagProvider.ts";
const ARTISTINFO = "backend/src/services/plugin/artistInfo.ts";
const ZH = "frontend/src/locales/zh-CN.json";
const EN = "frontend/src/locales/en-US.json";

const errors = [];
let checks = 0;

function textOf(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    errors.push(`缺少文件：${rel}`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

/** 只取**有效代码行**（剔除注释、去首尾空白、丢空行）—— 注释里提到符号不算接线。 */
function liveLines(text) {
  return stripComments(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 断言：某个文件的有效代码行里**至少有一行**匹配 re。 */
function mustMatch(rel, re, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  if (!liveLines(text).some((l) => re.test(l))) errors.push(`${rel}: ${why}`);
}

/** 断言：某个文件的有效代码行里**没有任何一行**匹配 re。 */
function mustNotMatch(rel, re, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const hit = liveLines(text).find((l) => re.test(l));
  if (hit) errors.push(`${rel}: ${why} —— 命中: ${hit.slice(0, 120)}`);
}

/** 原样子串（用于 JSON 文案这类没有注释概念的文件）。 */
function mustHave(rel, needle, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  if (!text.includes(needle)) errors.push(`${rel}: ${why}`);
}

// ---------- R1 碟号纪律 ----------
mustMatch(
  TAGWRITER,
  /args\.push\("-metadata", "disc="\);/,
  "必须显式清空继承来的碟号（-metadata disc=），否则成品会带回源文件的垃圾碟号（如实测 240 的 DISCNUMBER=18439392929）",
);
mustNotMatch(
  TAGWRITER,
  /disc=\$\{/,
  "不得写入任何碟号值（碟号纪律：成品不写也不留 DISCNUMBER/DISCTOTAL）",
);
mustMatch(
  TAGWRITER,
  /export const TAGGABLE_CONTAINERS = new Set\(\["mp3", "flac", "m4a", "mp4", "ogg", "opus"\]\);/,
  "容器白名单必须仍是 mp3/flac/m4a/mp4/ogg/opus（改动会静默放弃/误写标签）",
);

// ---------- R2 保留内嵌封面 ----------
mustMatch(
  TAGWRITER,
  /keepSourceCover\?: boolean/,
  "buildTagArgs 必须保留 keepSourceCover 开关（源封面保留的开关键）",
);
mustMatch(
  TAGWRITER,
  /"-map", "0:v\?"/,
  "不给新封面但保留源封面时，必须带可选映射 `-map 0:v?`（否则只映射 0:a 会静默丢弃已有内嵌封面）",
);
mustMatch(
  TAGREPAIR,
  /writeTags\(fsPath, tags, \{ keepSourceCover: true \}\)/,
  "标签修复写入必须恒 keepSourceCover=true（补 genre/track 等缺失标签的重写绝不能丢封面，2026-10-17 实测）",
);
mustMatch(
  ORCH,
  /deps\.writeTags\(cachePath, tags, \{ keepSourceCover: cfg\.embedCover !== false \}\)/,
  "下载期写入必须在「不换封面」时按 embedCover 保留源封面",
);

// ---------- R3 中文字形统一（两条写入路径） ----------
mustMatch(
  TAGWRITER,
  /export function applyTagsVariant\(tags: SongTags, variant: ChineseVariant \| undefined\): void \{/,
  "简繁字形转换必须收敛到 applyTagsVariant 唯一实现（下载期/修复期共用，避免两边漂移）",
);
mustMatch(
  TAGREPAIR,
  /applyTagsVariant\(tags, currentFetchConfig\(\)\.chineseVariant\)/,
  "标签修复写盘前必须调用 applyTagsVariant（否则修复写入的文本可能透出繁体）",
);
mustMatch(
  ORCH,
  /applyTagsVariant\(tags, cfg\.chineseVariant\)/,
  "下载期写盘前必须调用 applyTagsVariant（两条写入路径口径必须一致）",
);
mustMatch(CONFIG, /chineseVariant: "simplified",/, "默认字形必须是简体（simplified）");
mustMatch(
  ROUTES,
  /chineseVariant !== "traditional"/,
  "配置 PUT 必须钳制 chineseVariant 只能取 simplified/traditional",
);

// ---------- R4 终态不可得 ----------
mustMatch(
  TAGREPAIR,
  /markTagRepairDone\(fsPath, srcId \?\? "tag-repair", platformId, "unobtainable"\)/,
  "真缺但各来源都拿不到的歌必须落 outcome='unobtainable' 标记（否则候选池永不收敛、无限重扫）",
);
mustMatch(
  TAGREPAIR,
  /markTagRepairDone\(fsPath, srcId \?\? "tag-repair", platformId\);/,
  "真正写入修复后必须落完成标记（否则修过的歌下轮仍被当候选重扫）",
);
mustMatch(
  MARKER,
  /const UNOBTAINABLE_TTL_MS = 30 \* 24 \* 3_600_000;/,
  "终态不可得标记必须带 30 天 TTL（防断网/平台抽风把整库永久标记且可自愈）",
);
mustMatch(
  MARKER,
  /Date\.now\(\) - at > UNOBTAINABLE_TTL_MS/,
  "unobtainable 标记命中判定必须真的应用 TTL（超期放行重探）",
);
mustMatch(
  MARKER,
  /export function getTagRepairUnobtainableCount\(\): number \{/,
  "必须提供终态不可得计数（供管理端展示）",
);
mustMatch(
  ORCH,
  /if \(builtinTagSrc\) markTagRepairDone\(fr\.finalPath, builtinTagSrc\);/,
  "下载期由内置来源插件打标签后必须落完成标记（否则修复期重复跑一遍相同的取值）",
);

// ---------- R5 待修口径（预筛 − 已标记） ----------
mustMatch(
  MARKER,
  /export function getTagRepairMarkedPaths\(\): string\[\] \{/,
  "必须提供「全部已落标记 fs_path」读取（pending 口径的唯一数据源，纯 DB 不 stat）",
);
mustMatch(
  TAGREPAIR,
  /const markedPaths = new Set\(getTagRepairMarkedPaths\(\)\);/,
  "pending 计算必须取已标记路径集合（与扫描跳过口径一致）",
);
mustMatch(
  TAGREPAIR,
  /!markedPaths\.has\(fsPath\)/,
  "pending 必须真正剔除已标记的歌（否则界面「待修复」长期停在原位、与已修复数字对不上）",
);

// ---------- R6 写入安全 ----------
mustMatch(TAGWRITER, /renameSync\(tmp, target\);/, "标签写入必须原子替换（tagtmp → rename，绝不原地覆盖）");
mustMatch(TAGWRITER, /tmpPathFor\(target, "tagtmp"\)/, "必须写临时文件再替换，失败时原文件字节/mtime 不动");
mustMatch(TAGWRITER, /"-id3v2_version", "3"/, "mp3 必须写 ID3v2.3（缺省 ID3v2.4 部分车机/DLNA 读不出）");

// ---------- R7 QQ 搜索端点 ----------
mustMatch(
  TAGPROVIDER,
  /c\.y\.qq\.com\/soso\/fcgi-bin\/search_for_qq_cp/,
  "QQ 搜索必须用真搜索端点 search_for_qq_cp",
);
mustNotMatch(
  TAGPROVIDER,
  /client_search_cp/,
  "不得退回 client_search_cp（240 生产实测恒 HTTP 500、响应体 0 字节，导致 QQ 侧 0 候选、未获取率虚高）",
);
mustNotMatch(
  ARTISTINFO,
  /client_search_cp/,
  "歌手信息链路同样不得使用 client_search_cp（同族 search_for_qq_cp 才 200）",
);

// ---------- R8 QQ 限流 ----------
mustMatch(
  TAGPROVIDER,
  /MF_QQ_MIN_GAP_MS \?\? 1200/,
  "QQ 侧全局最小间隔必须默认 1.2s（防同出口 IP 高频被风控封禁）",
);
mustMatch(
  TAGPROVIDER,
  /300 \+ Math\.random\(\) \* 500/,
  "QQ 限流必须叠加 300~800ms 随机抖动（固定间隔仍可能触发风控）",
);

// ---------- R9 风格来源 ----------
mustMatch(
  TAGPROVIDER,
  /info\?\.genre\?\.content/,
  "genre 必须取自与 track_info 同级的 info.genre.content[].value（可读风格名）",
);
mustMatch(
  TAGPROVIDER,
  /const genre = pickGenre\(detail\?\.info\);/,
  "QQ 详情必须经 pickGenre(info) 取值（不得改用 track_info.genre 的数字码）",
);

// ---------- R10 时长单位（统一秒） ----------
mustMatch(
  TAGPROVIDER,
  /Math\.round\(\(Number\(s\?\.duration\) \|\| 0\) \/ 1000\)/,
  "网易云给的是毫秒，必须 /1000 换算成秒（否则时长闸门恒失败 → 拿不到封面/元数据）",
);
mustMatch(
  TAGPROVIDER,
  /function durationOk\(songDurationSec: number \| null \| undefined, intervalSec: any\): boolean \{/,
  "时长一致性判定必须以「秒」为入参（旧实现误当毫秒 /1000，差两个数量级）",
);
mustMatch(
  TAGPROVIDER,
  /platforms: \["qq", "netease"\]/,
  "平台优先级必须 QQ 在前、网易云兜底",
);

// ---------- 自检：守卫必须真的扫到了东西 ----------
if (checks < 25) {
  console.error(`✗ 守卫自身失效：只执行了 ${checks} 条检查 —— 扫描逻辑或文件路径约定已变，请先修守卫本身`);
  process.exit(1);
}

if (errors.length > 0) {
  console.error(`\n标签写入/修复链路守卫：发现问题（这些破坏全都静默且不可逆）（${errors.length} 处 / 共 ${checks} 条检查）:`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log(`✅ 标签写入/修复链路守卫通过：${checks} 条检查（只认非注释行）—— 碟号纪律 / 保留内嵌封面 / 简繁统一 / 终态不可得 / 待修口径 / 原子写 / QQ 端点与限流 / 风格与时长单位 全部在位`);
