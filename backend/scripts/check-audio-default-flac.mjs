#!/usr/bin/env node
// ==================== 默认输出编码「全局统一 FLAC(D1)」守卫 ====================
//
// 契约(2026-10-20 任务A,已拍板 **D1 = 全局统一**):
//   · `services/audio/pipeline.ts::resolveChannelCodec` 对**任何**源后缀 ——
//     无损(flac/wav/alac/aiff/ape) / mp3 / acc 系(m4a/aac) / ogg 系(ogg/oga/opus) /
//     **未知兜底** —— 默认输出**一律 FLAC**(容器 flac、mime audio/flac、无码率参数);
//   · DLNA 的 `resolveDlnaOutput` 收敛为与公共决策**完全一致**
//     (旧的「ogg 系一律回退 mp3 320」分支取消,否则 DIDL MIME 与 Content-Type 会不一致);
//   · 出流侧单曲管道默认仍取 `resolveChannelCodec(song?.suffix)`,未被写死格式。
//
// 为什么必须用「源码级」守卫:破坏是**静默**的 —— 把 resolveChannelCodec 改回按源族
// 分支(mp3→mp3 320 / m4a→aac 256 / ogg→opus 128 / 未知→mp3 320)后**不报错、不崩**,
// 只是四端(HTTP / DLNA / AirPlay 中间流)输出编码重新漂移,用户感知为「编码目标不统一」。
// 动态用例(runtime 短路)不必然覆盖:只有在真请求某后缀时才暴露。
//
// 本守卫做两件事:
//   · 正向:resolveChannelCodec 只有一条 `return { codec:"flac", container:"flac", mime:"audio/flac" }`;
//   · 负向:函数体内**不得**再出现按源族的旧编码字面量(`"mp3"` / `"aac"` / `"opus"` /
//     `bitrateKbps` / `.includes(`)与 ogg→mp3 回退 —— 改回旧值必红。
//   另有反向断言(见 R4):防「一刀切把有损转码路径也删了」。
//
// 运行时全量断言(五类后缀 + 未知 + 无损源 → FLAC)见
//   backend/tests/services/pipeline.test.ts 的 resolveChannelCodec / resolveDlnaOutput 组。
// 零依赖 node 脚本,挂 ci.yml 的守卫 job(与 check-* 系列同款)。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => stripComments(readFileSync(join(root, rel), "utf8"));

const PIPELINE = "backend/src/services/audio/pipeline.ts";
const REST = "backend/src/routes/rest/index.ts";
const TRANSCODE = "backend/src/services/transcode.ts";

const failures = [];
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}

/** 截取 `export function NAME(` 起、到下一处顶格 `}` 为止的函数体(含签名行)。 */
function fnBody(code, name) {
  const start = code.indexOf("export function " + name + "(");
  if (start < 0) return null;
  const end = code.indexOf("\n}", start);
  if (end < 0) return null;
  return code.slice(start, end + 2);
}

const pipe = read(PIPELINE);
const rest = read(REST);

console.log("===== R1 resolveChannelCodec:任何源后缀(mp3/m4a/aac/ogg/opus/未知)都 → FLAC =====");
const codec = fnBody(pipe, "resolveChannelCodec");
check("resolveChannelCodec 函数仍在", codec !== null, "未找到 `export function resolveChannelCodec(`");
if (codec) {
  check(
    "唯一返回体是 FLAC 编码(容器 flac / mime audio/flac)",
    /return\s*\{\s*codec:\s*"flac",\s*container:\s*"flac",\s*mime:\s*"audio\/flac"\s*\};/.test(codec),
    "未见 `return { codec: \"flac\", container: \"flac\", mime: \"audio/flac\" };`",
  );
  // 负向:函数体内不得再出现按源族的旧编码分支(改回旧值必红)。
  for (const bad of ['"mp3"', '"aac"', '"opus"', "bitrateKbps", ".includes("]) {
    check(
      `函数体内不得残留按源族的旧编码 \`${bad}\`(否则默认输出未统一 FLAC)`,
      !codec.includes(bad),
      `仍出现 ${bad}`,
    );
  }
}

console.log("===== R2 resolveDlnaOutput:与公共决策完全一致(ogg→mp3 320 回退取消) =====");
const dlna = fnBody(pipe, "resolveDlnaOutput");
check("resolveDlnaOutput 函数仍在", dlna !== null, "未找到 `export function resolveDlnaOutput(`");
if (dlna) {
  check(
    "恰好委托 `return resolveChannelCodec(suffix);`(DIDL MIME 与出流 MIME 同源)",
    (dlna.match(/return\s+resolveChannelCodec\(suffix\);/g) || []).length === 1,
    "未见唯一的委托返回",
  );
  check(
    "不得再出现 ogg/opus → mp3 320 的旧回退分支",
    !dlna.includes('"mp3"') && !dlna.includes("bitrateKbps") && !/["']ogg["']|["']oga["']|["']opus["']/.test(dlna),
    "仍残留按 ogg 系回退 mp3 的分支",
  );
}

console.log("===== R3 出流侧单曲管道默认接线未改(默认取 resolveChannelCodec) =====");
check(
  "servePipelinedSong 默认仍 `opts.codecOverride ?? resolveChannelCodec(song?.suffix)`",
  /opts\.codecOverride\s*\?\?\s*resolveChannelCodec\(song\?\.suffix\)/.test(rest),
  "默认编码决策接线被改(或写死格式)",
);

console.log("===== R4 反向断言:显式 format 的有损转码路径仍在(防一刀切删过头) =====");
check(
  "出流侧仍调用 decideTranscode(显式 format=mp3|aac 走转码)",
  rest.includes("decideTranscode("),
  "未见 decideTranscode( —— 显式转码路径被删",
);
check(
  "出流侧仍调用 serveTranscodedSong(有损转码出流仍在)",
  rest.includes("serveTranscodedSong("),
  "未见 serveTranscodedSong( —— 有损转码出流被删",
);
const trans = read(TRANSCODE);
check(
  "services/transcode.ts 的显式转码目标(mp3/aac)仍在(本任务不动它)",
  trans.includes('"mp3"') && trans.includes('"aac"'),
  "transcode.ts 的 mp3/aac 目标缺失(疑似越界改动)",
);
check(
  "decideTranscode 的「可复用原始直传」判定仍在(未删)",
  /function decideTranscode\(/.test(trans),
  "decideTranscode 不存在",
);

console.log("");
if (checks < 10) {
  console.error("✗ 守卫自身失效:只执行了 " + checks + " 条检查 —— 扫描逻辑或文件路径约定已变,请先修守卫本身");
  process.exit(1);
}
if (failures.length) {
  console.log(`✗ 默认输出编码统一 FLAC 守卫失败 ${failures.length} 项 / 共 ${checks} 条:`);
  for (const f of failures) console.log("   - " + f);
  process.exit(1);
}
console.log(`✓ 默认输出编码统一 FLAC 守卫全部通过(${checks} 条检查)`);
