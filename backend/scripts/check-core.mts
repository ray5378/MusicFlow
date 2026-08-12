// ==================== 核心插件化合规检查（CI 用） ====================
//
// 用法：cd backend && npx tsx scripts/check-core.mts
//
// 校验「框架核心符合功能插件化规范、不越界」：
//   规则 A：核心代码(非 plugins/、非 services/plugin/)不得出现硬编码的平台/provider 标识
//          (gmdl / go-music-dl / kugou / kuwo / migu / netease / musicdl 等)——平台只应存在于插件里
//   规则 B：核心代码不得 import services/plugin/ 下的具体插件实现(importers/.../dailyRecommend/...)
//          ——应通过 plugins/registry 按能力遍历访问
//   规则 C：getConfiguredProvider("字面量") / getPluginImpl("字面量") 的实参必须是能力名(VALID_CAPS)
//          ——核心只能按能力分发，不得写死具体 provider id
//
// 存量耦合白名单(KNOWN_COUPLINGS)：已登记的核心↔内置插件直连点(带 TODO,Phase 2 收口)——
// 新增越界一律失败(零容忍);存量只减不增。

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
// 排除插件框架目录(插件注册/加载/沙箱)与内置插件实现目录——它们是插件体系的一部分,不受核心规则约束。
const EXCLUDED_DIRS = ["plugins", "services/plugin"];

// ---- 规则 A：平台/provider 标识黑名单(核心出现即越界;若核心确实需要通用词,走白名单注释) ----
const PLATFORM_TOKENS = [
  "gmdl", "go-music-dl", "musicdl", "kugou", "kuwo", "migu", "netease",
  "qqmusic", "qianqian", "fivesing", "jamendo", "joox",
];

// ---- 规则 C：能力名白名单(与 plugins/types.ts PluginCapability 保持一致) ----
const VALID_CAPS = [
  "search", "recommend", "playlistSongs", "stream", "lyrics", "webRotation",
  "playlistImport", "playlistFile", "dailyPlaylist", "localPlaylist",
  "playlistSync", "autoMatch",
  "lyricProvider", "coverProvider", "renderer", "scrobbler",
];

// ---- 存量耦合白名单(文件 + 导入内容片段)。带 TODO,只减不增。 ----
const KNOWN_COUPLINGS: Array<{ file: string; importFrom: string; todo: string }> = [
  {
    file: "routes/api/index.ts",
    importFrom: "../../services/plugin/playlistSync.js",
    todo: "TODO(Phase2): 歌单同步功能应经 plugins/registry 按 playlistSync 能力调用",
  },
  {
    file: "routes/api/index.ts",
    importFrom: "../../services/plugin/dailyRecommend.js",
    todo: "TODO(Phase2): 每日推荐触发/候选应经 plugins/registry 按 dailyPlaylist 能力调用",
  },
  {
    file: "routes/rest/index.ts",
    importFrom: "../../services/plugin/dailyRecommend.js",
    todo: "TODO(Phase2): OpenSubsonic 识别每日推荐歌单的 DAILY_TAG 应来自插件 manifest",
  },
];

// ---- 规则 A 的内容白名单(文件内允许出现的平台标识,带 TODO,只减不增) ----
const PLATFORM_TOKEN_ALLOW: Array<{ file: string; token: string; reason: string }> = [
  {
    file: "services/scraper/artist.ts",
    token: "netease",
    reason: "TODO: 歌手信息抓取源(网易云 API)应插件化;当前为核心默认抓取实现",
  },
  {
    file: "db/index.ts",
    token: "netease",
    reason: "TODO: 每日推荐默认候选榜单(平台榜单 URL 种子)应改由 source 插件 recommend 提供",
  },
];

// 去掉注释(块注释 + 行注释)后的有效代码
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

const errors: string[] = [];
let checkedFiles = 0;
const allowListHits: string[] = [];

function walk(dir: string, rel: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // 排除插件框架目录与内置插件实现目录(它们是插件体系的一部分)
      if (childRel === "plugins" || childRel.startsWith("services/plugin")) continue;
      out.push(...walk(path.join(dir, e.name), childRel));
    } else if (e.name.endsWith(".ts")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

for (const file of walk(ROOT, "")) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const code = fs.readFileSync(file, "utf8");
  const effective = stripComments(code);
  checkedFiles++;

  // 规则 A：平台/provider 标识(白名单内的存量允许,只减不增)
  for (const tok of PLATFORM_TOKENS) {
    const re = new RegExp(`\\b${tok.replace(/[-\/]/g, "\\$&")}\\b`, "i");
    if (!re.test(effective)) continue;
    const allow = PLATFORM_TOKEN_ALLOW.find((a) => a.file === rel && a.token === tok);
    if (allow) {
      allowListHits.push(`${rel}: "${tok}" — ${allow.reason}`);
      continue;
    }
    errors.push(`[规则A] ${rel}: 核心代码出现硬编码平台/provider 标识 "${tok}"(平台名只应存在于插件 manifest/实现)`);
  }

  // 规则 B：import 具体插件实现
  const importRe = /import\s+[\s\S]*?from\s+"([^"]*services\/plugin\/(?:importers|dailyRecommend|localRecommend|playlistSync|renderers)[^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code)) !== null) {
    const from = m[1];
    const known = KNOWN_COUPLINGS.find((k) => k.file === rel && from.includes(k.importFrom));
    if (!known) {
      errors.push(`[规则B] ${rel}: 核心代码直接 import 内置插件实现 "${from}"(应经 plugins/registry 按能力遍历)`);
    } else {
      console.log(`  ! ${rel}: 存量耦合(已登记,勿新增) ${from} — ${known.todo}`);
    }
  }

  // 规则 C：按能力分发,不写死 provider id
  const capRe = /(?:getConfiguredProvider|getPluginImpl)\(\s*"([^"]+)"/g;
  while ((m = capRe.exec(effective)) !== null) {
    if (!VALID_CAPS.includes(m[1])) {
      errors.push(`[规则C] ${rel}: 按字符串 "${m[1]}" 取 provider——核心只能按能力名(VALID_CAPS)分发,不得写死平台/provider id`);
    }
  }
}

console.log(`\n核心插件化合规检查: 扫描 ${checkedFiles} 个文件`);
if (allowListHits.length > 0) {
  console.log("存量白名单(已登记,勿新增):");
  for (const h of allowListHits) console.log("  ! " + h);
}
if (errors.length > 0) {
  console.error("\n违规(新增越界,零容忍):");
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log("✓ 核心代码符合功能插件化规范(平台名只存在于插件,核心按能力遍历,无未登记直连)");
