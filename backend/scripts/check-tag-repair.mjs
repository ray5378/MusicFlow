#!/usr/bin/env node
// ==================== 标签写入 + 标签修复链路守卫 ====================
//
// 本脚本锁的是「下载期写标签」与「标签修复」两条写入链路的**静默失效契约**。
// 这些契约的共同点是：断了不报错、不会让任何既有动态用例变红，只会悄悄产出脏数据、
// 丢数据或让候选池永不收敛 —— 只有在用户发现「封面没了 / 碟号是垃圾值 / 待修复永远不降」
// 时才暴露。故逐条用源码级断言钉死。
//
// 十二条规则：
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
//   R11 断点续跑：一轮全量扫可跑数小时，快照必须落 settings（ACTIVE_RUN_KEY）——含 pendingIds/
//       candidateIds/stopped/phase/currentFsPath；进程被杀/主动停止后从快照接着跑（不重头扫），
//       正常跑完清快照；sweep 的 scan/repair 两个循环头都要有停止检查，且**不得**把待处理清单整段清空。
//   R12 立刻停止：stopTagRepair 只置 stopRequested 标志、把快照 stopped 落盘、清半成品 tagtmp、
//       顺延 LAST_RUN_KEY（D2），**不等**本轮真正结束（不得 async/await 整轮）；另暴露 isTagRepairStopping。
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

// ---------- R11 断点续跑（快照落盘 + 停止/被杀后接着跑） ----------
// 一轮全量扫动辄数千首、可跑数小时：若只靠内存态，进程被杀/用户点停止就丢全部进度，
// 候选池只能重头再扫一遍。故快照必须持久化到 settings（ACTIVE_RUN_KEY），正常跑完再清掉。
mustMatch(
  TAGREPAIR,
  /export const ACTIVE_RUN_KEY = "fetch\.tagrepair\.activeRun";/,
  "必须有进行中一轮的快照 key ACTIVE_RUN_KEY=fetch.tagrepair.activeRun（进程重启不丢进度）",
);
mustMatch(
  TAGREPAIR,
  /export const TAG_REPAIR_RESUME_DELAY_MS = 60_000;/,
  "必须有 boot 恢复续跑的延迟常量 TAG_REPAIR_RESUME_DELAY_MS（避开启动瞬间 CPU/IO 抢跑）",
);
mustMatch(
  TAGREPAIR,
  /export interface TagRepairRunSnapshot \{/,
  "必须有快照结构 TagRepairRunSnapshot（断点续跑的数据载体）",
);
mustMatch(
  TAGREPAIR,
  /phase: "scan" \| "repair";/,
  "快照必须记录 phase（scan/repair），续跑才知道从哪一阶段接着跑",
);
mustMatch(
  TAGREPAIR,
  /pendingIds: string\[\];/,
  "快照必须记录 pendingIds（当前阶段待处理清单，缺了就没法续跑）",
);
mustMatch(
  TAGREPAIR,
  /candidateIds: string\[\];/,
  "快照必须记录 candidateIds（scan 命中候选，scan 结束才整体转入 pendingIds）",
);
mustMatch(
  TAGREPAIR,
  /currentFsPath: string \| null;/,
  "快照必须记录 currentFsPath（停止/启动时据此清理遗留的半成品 tagtmp）",
);
mustMatch(
  TAGREPAIR,
  /stopped: boolean;/,
  "快照必须记录 stopped（区分「主动停止」不自动复活 / 进程被杀可续跑）",
);
mustMatch(
  TAGREPAIR,
  /function loadActiveRun\(\): TagRepairRunSnapshot \| null \{/,
  "必须有快照读取 loadActiveRun（boot 恢复与查询空闲时从 settings 回读）",
);
mustMatch(
  TAGREPAIR,
  /function saveActiveRun\(snap: TagRepairRunSnapshot\): void \{/,
  "必须有快照落盘 saveActiveRun（checkpoint 的唯一写入口）",
);
mustMatch(
  TAGREPAIR,
  /function clearActiveRun\(\): void \{/,
  "必须有快照清除 clearActiveRun（正常跑完/主动停止复活判定后清）",
);
mustMatch(
  TAGREPAIR,
  /function checkpoint\(force = false\): void \{/,
  "必须有 checkpoint（每 N 首/每 30s 节流落盘，force 立即落），否则进度只在内存、被杀即丢",
);
mustMatch(
  TAGREPAIR,
  /export function resumeInterruptedTagRepair\(\): \{ resumed: boolean; mode\?: TagRepairMode \} \{/,
  "必须有 boot 续跑入口 resumeInterruptedTagRepair（进程重启后从快照接着跑，不重头扫）",
);
mustMatch(
  TAGREPAIR,
  /export function getTagRepairActiveRun\(\): TagRepairRunSnapshot \| null \{/,
  "必须暴露进行中快照 getTagRepairActiveRun（供 API/UI 展示中途进度）",
);
mustMatch(
  TAGREPAIR,
  /export function hasResumableActiveRun\(\): boolean \{/,
  "必须暴露 hasResumableActiveRun（调度 tick 防抢跑：有可续跑快照就跳过定时兜底、避免重复劳动）",
);
mustMatch(
  TAGREPAIR,
  /clearActiveRun\(\);/,
  "正常跑完必须清快照（clearActiveRun()），否则下次 boot/查询会误判为「有一轮可续跑」并重复起跑",
);
mustMatch(
  TAGREPAIR,
  /stopRequested = false;/,
  "runTagRepairOnce 的 finally 必须复位 stopRequested，否则一轮结束后 UI 的「停止中…」永久挂着",
);
// 停止检查必须覆盖 scan/repair 两个循环头（至少两处 `if (stopRequested) break;`）。
// mustMatch 只能断言「至少一处」，此处显式计数：漏掉任一循环 → 点停止后仍要把整段扫/修跑完。
{
  checks += 1;
  const text = textOf(TAGREPAIR);
  if (text) {
    const hits = liveLines(text).filter((l) => /if \(stopRequested\) break;/.test(l)).length;
    if (hits < 2) {
      errors.push(
        `${TAGREPAIR}: sweep 的 scan/repair 两个循环头都要有停止检查 \`if (stopRequested) break;\`（至少 2 处），实测 ${hits} 处`,
      );
    }
  }
}
mustNotMatch(
  TAGREPAIR,
  /\.pendingIds = \[\];/,
  "不得把待处理清单整段清空（如停止/sweep 返回前 `pendingIds = []`）—— 那会丢弃未处理候选、让续跑变成重头再扫",
);
mustMatch(
  TAGREPAIR,
  /progress\.total = preserve \? progress\.checked \+ total : total;/,
  "续跑（preserve=true）时进度分母必须是「本段已处理 + 本阶段剩余」（progress.total = checked + total）——直接覆盖会让分母小于已处理数，进度提前冲到 100%、界面「待修复」（= total - checked）提前归零，而实际仍有候选在跑",
);

// ---------- R12 立刻停止（仅置标志，不等整轮结束） ----------
mustMatch(
  TAGREPAIR,
  /export function stopTagRepair\(\): \{ requested: boolean; running: boolean \} \{/,
  "必须有立刻停止入口 stopTagRepair（返回 { requested, running }）",
);
mustMatch(
  TAGREPAIR,
  /if \(!repairing\) return \{ requested: false, running: false \};/,
  "stopTagRepair 未在跑时必须直接返回 { requested:false, running:false }（无事可停）",
);
mustMatch(
  TAGREPAIR,
  /stopRequested = true;/,
  "stopTagRepair 必须置 stopRequested=true（sweep 的循环头据此立刻退出）",
);
mustMatch(
  TAGREPAIR,
  /activeSnapshot\.stopped = true;/,
  "stopTagRepair 必须把快照 stopped 置真（供 boot 识别为「主动停止」不复活）",
);
mustMatch(
  TAGREPAIR,
  /saveActiveRun\(activeSnapshot\);/,
  "stopTagRepair 必须立刻落盘快照（不等 checkpoint 节流），否则停止态可能没落盘",
);
mustMatch(
  TAGREPAIR,
  /setSetting\(LAST_RUN_KEY, String\(Date\.now\(\)\)\);/,
  "stopTagRepair 必须推进 LAST_RUN_KEY（D2：顺延定时兜底扫，避免刚停又被定时拉起重扫同一轮）",
);
mustMatch(
  TAGREPAIR,
  /cleanupTagTmp\(activeSnapshot\?\.currentFsPath/,
  "stopTagRepair 必须清理在写的半成品 tagtmp（cleanupTagTmp），否则留下坏文件",
);
mustMatch(
  TAGREPAIR,
  /export function isTagRepairStopping\(\): boolean \{/,
  "必须暴露 isTagRepairStopping（UI 据此显示「停止中…」）",
);
// 反向断言：stopTagRepair 是「仅置标志、不等本轮结束」的同步函数 —— 故不得被改成 async。
// （不能直接反断言 `await runTagRepairOnce`：调度器 tick 里合法地 await 了它。）
mustNotMatch(
  TAGREPAIR,
  /export async function stopTagRepair/,
  "stopTagRepair 必须同步返回（仅置标志、不等整轮结束）；改成 async 去 await 本轮跑完会让「停止」按钮卡到整轮结束",
);

// ---------- 自检：守卫必须真的扫到了东西 ----------
if (checks < 62) {
  console.error(`✗ 守卫自身失效：只执行了 ${checks} 条检查 —— 扫描逻辑或文件路径约定已变，请先修守卫本身`);
  process.exit(1);
}

if (errors.length > 0) {
  console.error(`\n标签写入/修复链路守卫：发现问题（这些破坏全都静默且不可逆）（${errors.length} 处 / 共 ${checks} 条检查）:`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log(`✅ 标签写入/修复链路守卫通过：${checks} 条检查（只认非注释行）—— 碟号纪律 / 保留内嵌封面 / 简繁统一 / 终态不可得 / 待修口径 / 原子写 / QQ 端点与限流 / 风格与时长单位 / 断点续跑 / 立刻停止 全部在位`);
