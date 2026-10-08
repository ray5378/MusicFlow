#!/usr/bin/env node
// ==================== 音频输出格式(采样率 + 位深)链路守卫 ====================
//
// 本脚本锁的是 batch48/batch49 建立的**输出格式链路契约**。这些契约的共同点是
// **静默失效**:断了不会报错、不会让任何既有测试变红,只会让听感/体积悄悄变差
// 或让老库升级后功能永不生效。
//
// 为什么必须用「源码级」守卫(动态用例覆盖不到的部分):
//   · `resolveRequestAf` 只在**链里有 loudnorm** 时才插入 aresample 回落 ——
//     而「插入位置」是 `splice(lnIdx + 1, …)` 这种**数组下标**写法,改写成
//     `af.push(...)` 后功能看似还在(滤镜仍出现)、实测却错位(限制器被顶掉)。
//   · `db/index.ts` 的搬迁只在**老库**上跑;全新库/CI 测试库永远走不到那条分支。
//     一旦有人删掉那行调用,CI 全绿,线上老库的 `player_output_configs.manual_bits`
//     列永远不出现 → 设置面板保存位深必然 500。
//   · 表名从 `player_rate_configs` 改名成 `player_output_configs` 后,任何一处
//     漏改的旧 drizzle 标识符都会在运行期才炸(no such table)。
//   · 前端入口(`播放器`页的「输出配置」按钮)是**用户实际报过的缺陷**:
//     batch48 把控件做在了「音频」页,用户在「播放器」页找不到。这类「控件搬家」
//     没有任何测试能发现,只能钉住入口符号。
//
// ⚠️ 判定**只认非注释行**(见 liveLines)。2026-10-08 的双向变异验证实测到:
//   纯子串计数会被「把调用注释掉」骗过 —— `// migrateLegacyRateConfigs();`
//   里那个符号仍在,计数照样够,守卫假绿。所以代码级断言一律走 mustLive。
//
// 动态契约(真的跑 ffmpeg 命令 / 真读文件头 / 真跑搬迁)见:
//   · backend/tests/services/playerOutputBits.test.ts
//   · backend/tests/services/flowEncodeBits.test.ts
//   · backend/tests/services/playerRateDegrade.test.ts
//   · backend/tests/services/audioInfoCacheBound.test.ts
//   · backend/tests/db/legacyRateMigration.test.ts
// 本脚本补的是「这些动态用例的**前提**还在不在」(函数签名、插入位置、调用点、表名)。
//
// 零依赖 node 脚本(与 check-dlna-realtime.mjs / check-seek-granularity.mjs 同款),
// 挂 ci.yml 的守卫 job。判定原则:**回归必红**,宁少勿假 —— 每条断言都做过双向变异验证
// (13 项动态 + 9 项静态 + 1 项反向探针,改坏一律转红;验证脚本见
//  .workbuddy/b49/mutate_b49.py,2026-10-08 跑全绿)。
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const REST_INDEX = "backend/src/routes/rest/index.ts";
const AUDIO_INFO = "backend/src/services/source/audioInfo.ts";
const PLAYER_RATE = "backend/src/services/playerRate.ts";
const DB_INDEX = "backend/src/db/index.ts";
const DB_SCHEMA = "backend/src/db/schema.ts";
const FLOW = "backend/src/services/audio/flow.ts";
const DIALOG = "frontend/src/components/OutputConfigDialog.vue";
const GROUPS_PAGE = "frontend/src/views/Groups/index.vue";
const ZH = "frontend/src/locales/zh-CN.json";
const EN = "frontend/src/locales/en-US.json";
const SRC_DIR = "backend/src";

const failures = [];
let checks = 0;

function read(rel) {
  if (!existsSync(join(root, rel))) {
    failures.push("文件不存在: " + rel);
    return "";
  }
  return readFileSync(join(root, rel), "utf8");
}

/** 逐行剔掉「整行注释」与「行内注释之前的部分」。 */
function liveLines(rel, needle) {
  return read(rel)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
      const at = line.indexOf(needle);
      if (at < 0) return false;
      const c = line.indexOf("//");
      return c < 0 || c > at;
    });
}

/** 正向(只认非注释行):needle 必须出现在 ≥ n 条**活**行里。 */
function mustLive(rel, needle, n, why) {
  checks += 1;
  const hit = liveLines(rel, needle).length;
  if (hit < n) {
    failures.push(rel + " 缺少 `" + needle + "`(活行 " + hit + " < " + n + ") —— " + why);
  }
}

/** 负向(只认非注释行):needle 不得出现在任何**活**行里。 */
function mustNotLive(rel, needle, why) {
  checks += 1;
  const hits = liveLines(rel, needle);
  if (hits.length > 0) {
    failures.push(rel + " 不得出现 `" + needle + "` —— " + why + "(" + hits[0].trim().slice(0, 90) + ")");
  }
}

/** 原样子串(用于 JSON 文案这类没有注释概念的文件)。 */
function must(rel, needle, n, why) {
  checks += 1;
  const hit = read(rel).split(needle).length - 1;
  if (hit < n) {
    failures.push(rel + " 缺少 `" + needle + "`(命中 " + hit + " < " + n + ") —— " + why);
  }
}

function walk(rel, ext) {
  const out = [];
  const abs = join(root, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return out;
  for (const name of readdirSync(abs).sort()) {
    const child = rel + "/" + name;
    const childAbs = join(root, child);
    if (statSync(childAbs).isDirectory()) out.push(...walk(child, ext));
    else if (name.endsWith(ext)) out.push(child);
  }
  return out;
}

// ---------------- 1) HTTP/DLNA 出流链:osf 接线在位且**位置正确** ----------------
// 位深必须换算成 osf 才会真正落到编码器上(链里有 loudnorm 走浮点 ⇒ 不给 osf 时
// FLAC 恒落 24bit)。降位深必须带 dither(triangular_hp),直接截断会有相关失真。
mustLive(REST_INDEX, "osf=s16:dither_method=triangular_hp", 1, "16bit 目标必须挂 osf=s16 + 三角高频抖动(否则 f32→s16 直接截断引入相关失真)");
mustLive(REST_INDEX, "osf=s32", 1, "24bit 目标必须挂 osf=s32(FLAC 的 24bit 对应 ffmpeg 的 s32 容器)");
// 位置契约:必须 splice 到 loudnorm **之后**,不能改成 push。
mustLive(REST_INDEX, "splice(lnIdx + 1, 0,", 1, "aresample 回落必须紧随 loudnorm(splice(lnIdx + 1, …));改成 push 会把限制器顶出链尾");
mustLive(REST_INDEX, 'findIndex((f) => f.includes("loudnorm"))', 1, "回落的位置由 loudnorm 的下标决定,不能改成无条件插入");
// 三来源接线:目标率 + 目标位深都必须从 playerRate 读,不能写死。
mustLive(REST_INDEX, "resolveTargetSampleRate(", 1, "目标采样率必须经 resolveTargetSampleRate 裁决(手动 > 探测 > 缺省 48000)");
mustLive(REST_INDEX, "resolveTargetBits(", 1, "目标位深必须经 resolveTargetBits 裁决(手动 > 跟随源)");
mustLive(REST_INDEX, "probeSourceBits(", 1, "位深「自动」档＝跟随源位深,必须调 probeSourceBits 读文件头;缺了则自动档恒不优化");

// ---------------- 2) 源位深探测:真的读文件头,且只读头 ----------------
mustLive(AUDIO_INFO, "export async function probeSourceBits(", 1, "probeSourceBits 是「自动＝跟随源位深」的唯一数据来源");
mustLive(AUDIO_INFO, "skipCovers: true", 1, "必须跳解析内嵌封面(大封面是这类解析最贵的部分)");
mustLive(AUDIO_INFO, "duration: false", 1, "必须跳过时长估算(只读头)");
mustLive(AUDIO_INFO, "classifySourceBits(", 1, "源位深必须归档到 16/24(20 位以上算 24)");
mustLive(AUDIO_INFO, "catch {", 1, "probeSourceBits 跑在出流热路径上,**必须**整体兜底永不抛(探不到位深最多不优化,不能让歌放不出来)");
mustLive(AUDIO_INFO, "cache.size >= CACHE_MAX", 1, "缓存必须有界(长跑服务按文件路径记,无界 = 内存泄漏;上限处必须整表清空)—— 注意不能只查 `cache.clear()`:测试清理函数里也有一次");

// ---------------- 3) 位深档位白名单 ----------------
mustLive(PLAYER_RATE, "export const BITS_OPTIONS", 1, "手动位深白名单必须仍是单一真源(前端下拉与 API 校验同源)");

// ---------------- 4) 表改名 + 老库搬迁(静默失效重灾区) ----------------
mustLive(DB_SCHEMA, 'sqliteTable("player_output_configs"', 1, "表名必须是 player_output_configs(batch49 由 player_rate_configs 改名)");
mustLive(DB_SCHEMA, 'manualBits: integer("manual_bits")', 1, "schema 必须声明 manual_bits 列");
mustLive(DB_INDEX, "manual_bits INTEGER NOT NULL DEFAULT 0", 1, "建表语句必须带 manual_bits 列(本仓无迁移框架,新列只能靠这里)");
mustLive(DB_INDEX, "function migrateLegacyRateConfigs(", 1, "搬迁函数必须在位");
// 调用点单独钉:只留定义 = 老库永不搬迁,而 CI 测试库是全新的、根本走不到这条分支。
mustLive(DB_INDEX, "migrateLegacyRateConfigs();", 1, "搬迁必须被 initDatabase() **真的调用**(只留定义 = 老库升级后新列永不出现,保存位深必然 500)");
mustLive(DB_INDEX, "INSERT OR IGNORE INTO player_output_configs", 1, "搬迁必须 INSERT OR IGNORE(新表已存在的行不能被老库数据覆盖)");
mustLive(DB_INDEX, "DROP TABLE player_rate_configs;", 1, "搬迁完必须删老表(否则每次启动都重放,且老表永久残留)");

// ---------------- 5) 旧标识符不得复活 ----------------
// 改名后任何漏改的旧 drizzle 标识符都只在运行期炸(no such table)。
for (const f of walk(SRC_DIR, ".ts")) {
  checks += 1;
  const text = read(f);
  if (text.split("playerRateConfigs").length - 1 > 0) {
    failures.push(f + " 仍在用旧标识符 `playerRateConfigs` —— batch49 已改名 playerOutputConfigs(表 player_output_configs),漏改只在运行期炸 no such table");
  }
  if (text.includes('sqliteTable("player_rate_configs"')) {
    failures.push(f + " 又重新声明了老表 player_rate_configs —— 老表已由 db/index.ts 的搬迁删除,复活会让新库缺列");
  }
}

// ---------------- 6) flow 链的位深贯通 ----------------
// flow 是连续混合流、没有「源」可跟随 ⇒ 调用方必须给具体值,且不能写死。
mustLive(FLOW, "targetBits: req.targetBits", 1, "flowEncodeArgs 必须把调用方给的 targetBits 透传给 outputFilters(写死 16 会让「整组一键设置 24bit」静默失效)");
mustNotLive(FLOW, "targetBits: 16,", "flow 不得把目标位深写死成 16(必须来自 FlowEncodeRequest)");
mustLive(REST_INDEX, "resolveTargetBits(flowRateKey) === 24 ? 24 : 16", 1, "flow 会话位深必须由配置裁决(flow 无源可跟随 ⇒ 自动档落 16)");

// ---------------- 7) 前端入口:必须在「播放器」页 ----------------
// 这是用户实际报过的缺陷:batch48 把控件做在「音频」页,用户在「播放器」页找不到。
// 「控件搬家」没有任何测试能发现 —— 只能钉住入口符号。
mustLive(DIALOG, "player-prefs/rate", 1, "输出配置弹窗必须走 /rest/api/v1/player-prefs/rate 读写");
mustLive(DIALOG, "bits", 1, "弹窗必须有位深控件(与采样率同一个弹窗,用户 2026-10-08 拍板)");
mustLive(GROUPS_PAGE, "OutputConfigDialog", 2, "「播放器」页(Groups)必须 import 并使用 OutputConfigDialog(用户报的正是「播放器页看不到入口」)");
mustLive(GROUPS_PAGE, "openOutputConfig(", 4, "入口必须挂在三处:DLNA 行 + Sendspin 行 + 群组卡片(定义 1 + 调用 3)");
must(ZH, '"outputConfig"', 1, "中文文案 groups.outputConfig 必须存在");
must(EN, '"outputConfig"', 1, "英文文案 groups.outputConfig 必须存在");

// ---------------- 自检:守卫必须真的扫到了东西 ----------------
// 目录改名 / 文件搬家会让上面全部读空字符串并「通过」——这是守卫自身失效的典型形态。
if (checks < 25) {
  console.error("✗ 守卫自身失效:只执行了 " + checks + " 条检查 —— 扫描逻辑或文件路径约定已变,请先修守卫本身");
  process.exit(1);
}

if (failures.length) {
  console.error("✗ 音频输出格式链路守卫失败(" + failures.length + " 处 / 共 " + checks + " 条检查):");
  for (const x of failures) console.error("  ✗ " + x);
  process.exit(1);
}

console.log("✅ 音频输出格式链路守卫通过:" + checks + " 条检查(只认非注释行) —— osf 接线与插入位置 / 源位深探测与缓存边界 / 表改名与老库搬迁 / flow 贯通 / 播放器页入口 全部在位");
