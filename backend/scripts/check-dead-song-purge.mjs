#!/usr/bin/env node
// ==================== 死链清理守卫（永久失效的网络歌曲移出曲库） ====================
//
// 契约（产品定调 2026-10-11）：一首网络歌连续 N 次（默认 2）以「资源不存在类」原因
// 下载失败后，从曲库移除，并把引用它的歌单条目转成未匹配。
//
// 为什么必须静态钉死：这条链的破坏**全都是静默且不可逆的**——
//   · 白名单被塞进 BELOW_BAR / FAKE_LOSSLESS → 歌还在（能在线播）却被删掉；
//   · 「转未匹配」与「删 songs 行」顺序被调换 → external_* 快照丢失，歌单里只剩
//     「未知歌曲」，用户再也无法用「一键在线匹配」把它拉回来；
//   · 本地行保护被去掉 → 洗版失败的歌连同本地实体文件一起清掉；
//   · 源故障保护被去掉 → 插件停用/凭据过期一次，一轮任务清空整个曲库。
// 这些在运行期都不报错，只会在用户发现「歌没了、还找不回来」时才暴露，所以逐条钉死。
//
// 十一条规则：
//   R1 白名单：PERMANENT_FAILURE_CODES 恰为 5 个「资源不存在类」码，且**不得**含
//      任何可恢复/非失败码（质量不达标、网络抖动、环境/配置问题）。
//   R2 顺序铁律：转未匹配必须先于删 songs 行（快照回填依赖 songs 行还在）。
//   R3 安全边界：只处理 type='web' 的行（本地/WebDAV 有实体文件，绝不删）。
//   R4 快照回填：external_title/artist/album/duration 四列都用 COALESCE 回填。
//   R5 终态接线：orchestrator 在任务终态调用清理器并把结果透出；洗版必须早退。
//   R6 源故障保护：按「尝试数 ≥100（0/100 口径）+ A 类失败占比 + 本轮成功率严格为 0」判定并回滚计数，
//      触发时跳过本轮清理；两条告警都必须**落日志**（warnings 数组不落库也不落日志，只 push = 静默）。
//   R7 单轮上限：MAX_PURGE_PER_RUN 必须真的参与判断（防一次清空曲库）。
//   R8 配置三处同步：config 声明 + routes 钳制 + 前端 api/vue + i18n zh/en。
//   R9 告警可见性：批处理出口必须把 result.warnings 落日志（否则全部静默丢弃）。
//   R10 新错误码文案同步：DURATION_MISMATCH 必须在 jobFormat + zh/en 三处配齐。
//   R11 永久失效类不进冷却（2026-10-11 定调 B）：冷却入口必须是 shouldSkipByCooldown，
//       且它内部必须对 PERMANENT_FAILURE_CODES 放行。否则 fail_count 永远停在 1，
//       死链清理的阈值条件形同虚设（240 实测 fail_count>=2 恒为 0）。
//
// 零依赖 node 脚本（与 check-import-trigger.mjs 同款），挂 ci.yml 的守卫 job。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const ATTEMPTS = "backend/src/services/fetch/attempts.ts";
const PURGE = "backend/src/services/fetch/deadSongPurge.ts";
const ORCH = "backend/src/services/fetch/orchestrator.ts";
const INTEGRITY = "backend/src/services/fetch/integrity.ts";
const CONFIG = "backend/src/services/fetch/config.ts";
const ROUTES = "backend/src/routes/api/fetch.ts";
const BATCH = "backend/src/batch/jobs.ts";
const FE_API = "frontend/src/api/fetch.ts";
const VIEW = "frontend/src/views/admin/Fetch/index.vue";
const JOBFMT = "frontend/src/views/admin/Fetch/jobFormat.ts";
const ZH = "frontend/src/locales/zh-CN.json";
const EN = "frontend/src/locales/en-US.json";

const errors = [];

function textOf(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    errors.push(`缺少文件：${rel}`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

/** 只取**有效代码行**（剔除注释、去首尾空白、丢空行）—— 注释里提到函数名不算接线。 */
function liveLines(text) {
  return stripComments(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 断言：某个文件的有效代码行里**至少有一行**匹配 re。 */
function mustMatch(rel, re, why) {
  const text = textOf(rel);
  if (!text) return;
  if (!liveLines(text).some((l) => re.test(l))) errors.push(`${rel}: ${why}`);
}

/** 断言：某个文件的有效代码行里**没有任何一行**匹配 re。 */
function mustNotMatch(rel, re, why) {
  const text = textOf(rel);
  if (!text) return;
  const hit = liveLines(text).find((l) => re.test(l));
  if (hit) errors.push(`${rel}: ${why} —— 命中: ${hit}`);
}

// ---------- R1 白名单 ----------
mustMatch(
  ATTEMPTS,
  /export const PERMANENT_FAILURE_CODES: readonly FetchErrorCode\[\] = \[/,
  "必须导出 PERMANENT_FAILURE_CODES 白名单",
);
for (const code of ["NO_CANDIDATE", "HTTP_404", "HTTP_410", "HTTP_451", "INTEGRITY_FAILED"]) {
  mustMatch(ATTEMPTS, new RegExp(`"${code}"`), `白名单必须含 ${code}（资源不存在类）`);
}
// 这些码**绝不能**进白名单：要么歌还在（只是不满足下载质量门槛），要么纯属网络/环境
// 问题，重试就能成。误判会删掉「还能在线播放」的歌，且用户很难发现是被删了。
for (const code of [
  "BELOW_BAR",
  "FAKE_LOSSLESS",
  "TIMEOUT",
  "STALL",
  "HTTP_5XX",
  "HTTP_403",
  "HTTP_4XX",
  "FETCH_FAILED",
  "TOO_LARGE",
  "SSRF_BLOCKED",
  "DISK_FULL",
  "MOVE_FAILED",
  "TAG_FAILED",
  "TRANSCODE_FAILED",
  "SCAN_FAILED",
  "DURATION_MISMATCH",
]) {
  mustNotMatch(
    ATTEMPTS,
    new RegExp(`^\\s*"${code}",?\\s*$`),
    `${code} 不得进入永久失效白名单（可恢复/非失败）`,
  );
}
// 「时长对不上」= 拿到的是另一个版本，文件完整、歌也还能在线播放，绝不能被判死链。
// 必须独立成 DURATION_MISMATCH，不得沿用 INTEGRITY_FAILED（后者在白名单里）。
mustMatch(
  ORCH,
  /code: "DURATION_MISMATCH"/,
  "时长偏差超容差必须用 DURATION_MISMATCH（不能用 INTEGRITY_FAILED：后者在白名单里，会把「版本不同」的歌误删出曲库）",
);
mustMatch(
  ORCH,
  /偏差超容差 \$\{cfg\.quality\.durationToleranceSec\}s/,
  "时长偏差守卫必须保留（它挡住的是「下到别的版本」）",
);
mustMatch(
  INTEGRITY,
  /code: "DURATION_MISMATCH"/,
  "完整性探针层的时长偏差同样必须用 DURATION_MISMATCH（同一类误判，两处都要修）",
);

// ---------- R1b 台账计数口径 ----------
mustMatch(ATTEMPTS, /fail_count/, "台账必须有 fail_count 列（连续失败计数）");
mustMatch(
  ATTEMPTS,
  /WHEN excluded\.status = 'done' THEN 0/,
  "成功必须把 fail_count 归零（否则「连续」语义失效）",
);
mustMatch(ATTEMPTS, /error_code/, "台账必须记录 error_code（判定与观测依据）");

// ---------- R2 顺序铁律：先转未匹配，再删 songs 行 ----------
{
  const lines = liveLines(textOf(PURGE));
  const iMatch = lines.findIndex((l) => /\.prepare\(MATCH_REASON_SQL\)/.test(l));
  const iDel = lines.findIndex((l) => /delSong\.run\(/.test(l));
  if (iMatch < 0) {
    errors.push(`${PURGE}: 必须执行「歌单条目转未匹配」语句（MATCH_REASON_SQL）`);
  } else if (iDel < 0) {
    errors.push(`${PURGE}: 必须删除 songs 行（delSong.run）`);
  } else if (iMatch > iDel) {
    errors.push(
      `${PURGE}: 顺序反了 —— 必须先转未匹配再删 songs 行（否则 external_* 快照丢失，` +
        `歌单条目永远无法被「一键在线匹配」拉回）`,
    );
  }
}

// ---------- R3 安全边界：只删 web 行 ----------
mustMatch(
  PURGE,
  /row\.type !== "web"/,
  "必须保留「只处理 type='web'」的安全边界（本地/WebDAV 行有实体文件，绝不删）",
);

// ---------- R4 快照回填 ----------
for (const col of ["external_title", "external_artist", "external_album", "external_duration"]) {
  mustMatch(
    PURGE,
    new RegExp(`${col}\\s*=\\s*COALESCE\\(${col}`),
    `必须用 COALESCE 回填 ${col}（一键在线匹配的唯一依据，且不得覆盖条目原有值）`,
  );
}
mustMatch(PURGE, /unavailable_reason\s*=\s*\?/, "必须写明 unavailable_reason（用户能看出死因）");
mustMatch(PURGE, /song_id\s*=\s*NULL/, "转未匹配必须把 song_id 置 NULL（匹配器按此筛选）");
mustMatch(PURGE, /playable\s*=\s*0/, "转未匹配必须把 playable 置 0");

// ---------- R5 终态接线 ----------
mustMatch(ORCH, /function settleDeadSongs\(/, "orchestrator 必须有终态结算函数");
mustMatch(
  ORCH,
  /const purge = settleDeadSongs\(opts, items, warnings\)/,
  "任务终态必须调用结算并把结果透出到 FetchPipelineResult",
);
mustMatch(ORCH, /deps\.purgeDeadSongs\(cfg\)/, "结算必须真正调用清理器");
mustMatch(
  ORCH,
  /if \(ropts\.originalDisposal\) return undefined/,
  "洗版必须早退：它不是入库流程，本地文件还在，删歌是错的",
);
mustMatch(
  ORCH,
  /permanent: item\.status === "failed" && isPermanentFailureCode\(item\.errorCode\)/,
  "台账写入必须按白名单判定 permanent（否则可恢复失败会累计成死链）",
);

// ---------- R6 源故障保护 ----------
mustMatch(
  ORCH,
  /fatal\.length \/ failed\.length >= SOURCE_OUTAGE_RATIO/,
  "必须有源整体故障保护：按「A 类失败占比」判定（只看 NO_CANDIDATE 挡不住签名链路失效刷的 404）",
);
mustMatch(
  ORCH,
  /^const SOURCE_OUTAGE_MIN_TRIED = 100;$/,
  "源故障保护必须有「样本量门槛」且恰为 100（用户定调 2026-10-11「0/100 才判定」：小样本里偶发全灭不足以断定源挂了）",
);
mustMatch(ORCH, /^tried >= SOURCE_OUTAGE_MIN_TRIED &&$/, "样本量门槛必须真正参与判断");
mustMatch(
  ORCH,
  /^done === 0 &&$/,
  "源故障保护必须带「本轮成功率严格为 0」（done === 0）条件：只要有一首成功就说明源能用，不该判成源故障。240 生产实测收紧前的「成功率 < 20%」宽松版仍会误判（单轮 20 首里成功 0–3 首 → 每轮触发 → fail_count 到不了阈值 → 死链清理永远跑不起来）",
);
mustNotMatch(
  ORCH,
  /SOURCE_OUTAGE_MAX_SUCCESS_RATIO/,
  "不得再退回「成功率 < X%」的宽松阈值（2026-10-11 生产实测会在每轮误判，导致死链清理永不生效；必须严格 done === 0）",
);
mustNotMatch(
  ORCH,
  /SOURCE_OUTAGE_MIN_FAILURES/,
  "不得退回只看「失败数 ≥5」的旧门槛（已被「尝试数 ≥100」的样本量门槛取代）",
);
mustMatch(ORCH, /deps\.rollbackPermanentFailure\(/, "源故障保护必须回滚本轮误加的计数");
mustMatch(ORCH, /源整体故障/, "源故障保护必须留痕（警告文案，便于用户判断是不是源挂了）");
mustMatch(
  ORCH,
  /log\.warn\(note\)/,
  "源故障保护 / 清理失败必须落日志：只 push 进 warnings 数组等于静默（该数组既不落库也不落日志）",
);
mustMatch(ORCH, /log\.info\(note\)/, "死链清理结果必须落日志（否则用户不知道清了多少）");

// ---------- R11 永久失效类不进冷却（2026-10-11 定调 B） ----------
// 背景：`downloadCooldownDays` 默认 30 天 > 全库自动任务间隔默认 15 天 → 同一首 404 歌
// 永远只失败一次 → fail_count 停在 1 → 死链清理阈值（默认 2）永远达不到 → 清理形同关闭。
// 修法：冷却入口改 shouldSkipByCooldown —— 窗口内试过**且最近一次终态不是永久失效类**
// 才跳过；永久失效类每轮重试以便累积计数。
mustMatch(
  ATTEMPTS,
  /^export function shouldSkipByCooldown\(songKey: string, cooldownDays: number\): boolean \{$/,
  "attempts 必须提供 shouldSkipByCooldown（冷却判定入口，永久失效类放行）",
);
mustMatch(
  ATTEMPTS,
  /SELECT attempted_at, error_code FROM fetch_download_attempts WHERE song_key = \?/,
  "shouldSkipByCooldown 必须把 error_code 一并取出（判定依据；只取 attempted_at 无法区分永久失效）",
);
mustMatch(
  ATTEMPTS,
  /^if \(isPermanentFailureCode\(row\.error_code\)\) return false;$/,
  "shouldSkipByCooldown 必须真正对永久失效类放行（否则 fail_count 永远停在 1，死链清理永不生效）",
);
mustMatch(
  ORCH,
  /deps\.shouldSkipByCooldown\(akey, cooldownDays\)/,
  "orchestrator 的冷却分支必须走 shouldSkipByCooldown（无差别冷却会让永久失效类被秒跳）",
);
mustNotMatch(
  ORCH,
  /deps\.isRecentlyAttempted\(/,
  "不得退回无差别冷却（永久失效类必须每轮重试才能累积到清理阈值；2026-10-11 生产实测 fail_count>=2 恒 0）",
);

// ---------- R9 告警可见性（warnings 不得静默丢弃） ----------
mustMatch(
  BATCH,
  /for \(const w of result\.warnings\) log\.warn\(/,
  "批处理出口必须把流水线 warnings 落到日志，否则源故障保护/死链清理的告警全部静默丢弃",
);

// ---------- R10 新错误码的文案同步（DURATION_MISMATCH） ----------
mustMatch(
  JOBFMT,
  /DURATION_MISMATCH: "durationMismatch"/,
  "前端 jobFormat 必须为 DURATION_MISMATCH 配文案键（否则 UI 直接显示原始错误码）",
);
mustMatch(ZH, /"durationMismatch"/, "zh-CN 缺 admin.fetch.errorCode.durationMismatch 文案");
mustMatch(EN, /"durationMismatch"/, "en-US 缺 admin.fetch.errorCode.durationMismatch 文案");

// ---------- R7 单轮上限 ----------
mustMatch(PURGE, /export const MAX_PURGE_PER_RUN/, "必须有单轮移除上限常量");
mustMatch(PURGE, /result\.purged >= MAX_PURGE_PER_RUN/, "上限必须真正参与判断");

// ---------- R8 配置三处同步 ----------
mustMatch(CONFIG, /deadSongPurgeThreshold: number/, "config 接口必须声明 deadSongPurgeThreshold");
mustMatch(CONFIG, /deadSongPurgeThreshold: \d+,/, "config 必须给默认值");
mustMatch(
  ROUTES,
  /if \("deadSongPurgeThreshold" in override\)/,
  "配置 PUT 必须钳制 deadSongPurgeThreshold（否则前端可写入非法值）",
);
mustMatch(FE_API, /deadSongPurgeThreshold\?: number/, "前端 api 类型必须同步");
mustMatch(VIEW, /config\.deadSongPurgeThreshold/, "前端配置表单必须暴露该项");

for (const [rel, label] of [
  [ZH, "zh-CN"],
  [EN, "en-US"],
]) {
  const raw = textOf(rel);
  if (!raw) continue;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    errors.push(`${rel}: JSON 解析失败 —— ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const cfg = parsed?.admin?.fetch?.config;
  if (!cfg || typeof cfg.deadSongPurgeThreshold !== "string" || !cfg.deadSongPurgeThreshold.trim()) {
    errors.push(`${rel}: 缺少 admin.fetch.config.deadSongPurgeThreshold（${label}）`);
  }
}

// ---------- 结果 ----------
if (errors.length > 0) {
  console.error("\n死链清理守卫：发现问题（这些破坏全都是静默且不可逆的）:");
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log("✓ 死链清理链路完整（白名单 → 顺序 → web 边界 → 快照 → 终态接线 → 源故障保护 → 上限 → 配置）");
