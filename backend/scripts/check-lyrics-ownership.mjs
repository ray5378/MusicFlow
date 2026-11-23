#!/usr/bin/env node
// ==================== 歌词/标签 归属闸门与链路守卫 ====================
//
// 背景（2026-11-21/22 真机与全库实测）：正在播《狂信者》却显示《分开旅行》的整篇歌词。
// 根因不是时间轴，是**匹配错了歌**：历史误匹配落库（lyrics.persist）后，取词顺序
// ①落库缓存 优先 ⇒ provider 再也不会被问到；而本该救场的 ②sidecar 因 WebDAV 地址拼成
// `/dav/dav/...` 恒 404。全库 41,387 个 flac 里还有 1,534 个文件把错词写进了标签。
//
// 本守卫钉的是「不要再让错词进来」的四道口 + 一条链路修补，全部属**静默失效体质**：
// 改坏了不报错、不崩，只会让界面/文件里安静地显示别人的歌词。
//
//   L1 `lrcBelongsToSong` 存在且判据完整（标题分段 + 整行兜底 + 歌手同现否决）。
//   L2 ①落库缓存入口过闸（错词被忽略，继续往下找）。
//   L3 ②sidecar 入口过闸。
//   L4 ③在线入口**先判不符**再采纳（不是先采纳再补判）。
//   L5 落库(persist)只发生在校验通过的 else-if 分支里。
//   L6 WebDAV sidecar 地址必须与服务端其它处对齐：filePath 已含 base 路径段时只用 origin，
//      禁止回到 `base + lrcPath` 的裸拼（那会拼出 /dav/dav）。
//   L7 标签修复写文件前必须过闸（写进文件比界面错更难修）。
//   L8 下载分支 A（插件自带 search+streamUrl）必须按标题/歌手过滤命中。
//   L9 该过滤器不得把「无标题命中」当通过（无标题=无法证明是本曲）。
//   L10 两处「不符」告警文案仍在（排障时靠它区分「没取到」与「取到了但不是这首」）。
//
// 零依赖 node 脚本（与 check-playback-regression.mjs 同款），挂 ci.yml 守卫 job。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => stripComments(readFileSync(join(root, rel), "utf8"));

const LYRIC_MATCH = "backend/src/services/lyricsMatch.ts";
const LYRICS = "backend/src/services/lyrics.ts";
const PROVIDERS = "backend/src/plugins/providers.ts";
const TAG_PROVIDER = "backend/src/services/plugin/tagProvider.ts";
const LYRIC_STORE = "backend/src/services/lyricsStore.ts";
const TAG_REPAIR = "backend/src/services/fetch/tagRepair.ts";
const CANDIDATES = "backend/src/services/fetch/candidates.ts";

const failures = [];
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  if (ok) console.log("  ✓ " + name);
  else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}
const count = (s, needle) => s.split(needle).length - 1;

const lm = read(LYRIC_MATCH);
const ly = read(LYRICS);
const pv = read(PROVIDERS);
const tp = read(TAG_PROVIDER);
const tr = read(TAG_REPAIR);
const cd = read(CANDIDATES);

console.log("===== L1 归属判据本体 =====");
check(
  "lrcBelongsToSong 已导出（显示层 / 标签修复 / provider 调度共用同一把尺）",
  lm.includes("export function lrcBelongsToSong("),
  "改名/内联 ⇒ 三条链路各自的判据会漂移",
);
check(
  "判据在独立模块里（providers 反向 import 不形成循环）",
  LYRIC_MATCH.endsWith("lyricsMatch.ts") && !lm.includes("from \"./lyrics.js\""),
  "塞回 lyrics.ts 会让 providers.ts 循环依赖",
);
check(
  "判据含「顺序无关分段 + 整行兜底」",
  lm.includes("const wholeLine = norm(headerLine);") &&
    lm.includes("wholeLine.includes(wantTitle)") &&
    lm.includes("parts.some((p) => p.includes(wantTitle) || wantTitle.includes(p))"),
  "歌名自带连字符（A-B）时只分段会误杀",
);
check(
  "标题对不上但同行出现本曲歌手 ⇒ 否决（同歌手另一首的典型形态）",
  lm.includes("const artistHit =") && lm.includes("if (artistHit) return false;"),
  "缺这一层 ⇒ 狂信者/分开旅行 这类会被放行",
);
check(
  "歌手判据按分词逐个比（多歌手串只出现一个名字也能认出）",
  lm.includes("const artistTokens = String(song.artist ?? \"\")") &&
    lm.includes("artistTokens.some((t) =>"),
  "整串比较 ⇒ 「王麟,新街口组合」对不上标题行里的「新街口组合/大宝Bles.P」，别人的歌被放行（大宝剑实例）",
);
check(
  "内容可用性：内容量 < MIN_LYRIC_LINES(5) 视为占位文本",
  lm.includes("export const MIN_LYRIC_LINES = 5;") &&
    lm.includes("const contentUnits = Math.max(contentLines.length, timeStampCount);") &&
    lm.includes("if (contentUnits < MIN_LYRIC_LINES) return false;"),
  "缺这一层 ⇒ 「纯音乐请欣赏 / 作者简介」被当成歌词整首显示（该死的温柔 实例）",
);
check(
  "内容量取「文本行数」与「时间戳个数」的较大者（逐字歌词不被误杀）",
  lm.includes("const timeStampCount = (content.match("),
  "只按物理行数 ⇒ 一行到底的逐字/卡拉OK 歌词整片误杀（MELANCHOLY 实例）",
);

console.log("===== L2/L3/L4 三处入口全过闸 =====");
check(
  "①落库缓存过闸（错词忽略后继续往 ②③ 找）",
  ly.includes("const cached = resolveLyricContent(row.lyrics);") &&
    ly.includes("if (cached && lrcBelongsToSong(cached, song as any))"),
  "不过闸 ⇒ 历史错词永远优先，provider 再也不会被问到",
);
check(
  "②sidecar 过闸",
  ly.includes("if (side && lrcBelongsToSong(side, song as any)) content = side;"),
  "sidecar 是 NAS 上的文件，同样可能是别人那首的 .lrc",
);
check(
  "③在线：**先判不符**再采纳（if (!belongsTo) … else if (fromProviders)）",
  count(ly, "!lrcBelongsToSong(fromProviders, song as any)") === 1 &&
    ly.indexOf("!lrcBelongsToSong(fromProviders, song as any)") <
      ly.indexOf("} else if (fromProviders) {"),
  "顺序写反 ⇒ 错词照样落库，只是多打一条日志",
);

console.log("===== L4b 不可用 ⇒ 自动换源 / 换候选 =====");
check(
  "provider 层：拿到的歌词不可用 ⇒ 继续下一个源（不收口）",
  pv.includes("if (!lrcBelongsToSong(text, song)) {") && pv.includes("继续下一个源"),
  "首源返回占位文本就把整条链收口 ⇒ 永远取不到正确歌词",
);
check(
  "标签源层保持「只取词、不判内容」（判内容在 provider 调度层，避免候选轮换的语义漂移）",
  tp.includes("async function lyricFor(host: PluginHost, c: PlatformCandidate)") &&
    !tp.includes("lrcBelongsToSong"),
  "在 lyricFor 里判内容会改变 candidate 轮换与请求计数语义（tagProvider 用例族依赖），已回退",
);

console.log("===== L5 落库(persist)在校验通过的分支内 =====");
{
  const iElse = ly.indexOf("} else if (fromProviders) {");
  const iPersist = ly.indexOf("saveLyricFile(song.id, content)");
  check(
    "saveLyricFile 位于校验通过的 else-if 分支之后",
    iElse > 0 && iPersist > iElse,
    "落到分支外 ⇒ 未校验的文本也会被写进 online-lyrics 与 songs.lyrics",
  );
}

console.log("===== L6 WebDAV sidecar 地址不再重复 base 路径 =====");
check(
  "存在 origin 归一段（filePath 已含 base 路径段 ⇒ 只取 origin）",
  ly.includes("base = u.origin;") && ly.includes('lrcPath.startsWith(basePath + "/")'),
  "缺这段 ⇒ 拼出 http://host:5444/dav/dav/… 恒 404（同目录 .lrc 一次都用不上）",
);
check(
  "旧的裸拼写法没有回流（const base = config.url?.replace(...) + base + lrcPath）",
  !ly.includes("const base = config.url?.replace("),
  "回流即复发 404",
);

console.log("===== L7 标签修复：写文件前过闸 =====");
// 2026-11-23：调用点带上了 album 与 { strictArtist: true }，参数跨行书写；
// 判据改为「闸门调用必须在写入之前，且必须显式要求严格模式」——意图不变，只是不再钉死字面量。
check(
  "tagRepair 在 tags.lyric = text 之前调用 lrcBelongsToSong（且严格模式）",
  tr.indexOf("lrcBelongsToSong(") > 0 &&
    tr.indexOf("lrcBelongsToSong(") < tr.indexOf("tags.lyric = text;") &&
    tr.includes("strictArtist: true"),
  "写进文件后无法自动修复（本次全库实测 1,534 个文件被写坏）",
);
check(
  "不匹配时不写并留 warn（可排障）",
  tr.includes("歌词与曲目不符,不写入"),
  "静默丢弃会让「为什么这首没歌词」无从查起",
);

console.log("===== L8/L9 下载分支 A 的身份闸门 =====");
check(
  "viaSearch 用 hitMatchesTarget 过滤命中",
  cd.includes("const hits = songs.filter((x) => hitMatchesTarget(x, target));"),
  "不过滤 ⇒ 插件 search 返回什么就拿什么去下载",
);
check(
  "循环遍历的是过滤后的 hits",
  cd.includes("for (const s of hits) {"),
  "仍遍历 songs ⇒ 闸门只是装饰",
);
check(
  "命中无标题 ⇒ 不通过（无标题无法证明是本曲）",
  cd.includes("if (!t || !hn) return false;"),
  "放行无标题命中 = 把「不知道」当「是」",
);

console.log("===== L10 两处「不符」告警文案 =====");
check(
  "在线/缓存/sidecar 侧有「与曲目不符」告警",
  ly.includes("在线歌词与曲目不符") && ly.includes("落库歌词与曲目不符"),
  "排障需要区分「没取到」与「取到了但不是这首」",
);

console.log("");
if (failures.length > 0) {
  console.log(`[歌词/标签归属守卫] FAIL:${failures.length} 项(通过 ${checks - failures.length} 项)`);
  for (const f of failures) console.log("  · " + f);
  process.exit(1);
}
console.log(`[歌词/标签归属守卫] ${checks} 条断言全部通过`);
