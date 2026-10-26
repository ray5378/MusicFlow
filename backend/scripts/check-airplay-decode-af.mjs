#!/usr/bin/env node
// ==================== AirPlay 解码 af 守卫(响度归一唯一发生地) ====================
//
// 契约:同一段音频**只归一一次**,且归一发生在**音源源头那一遍** —— 即出流侧公共链路
// (`routes/rest/index.ts::resolveRequestAf`,由 cast 通道判定给出 `channel="airplay"`);
// AirPlay **解码侧**(`services/airplay/decoder.ts`)只做 RAOP 协议硬性输出段
// (44100Hz / 16bit / stereo),**不得**再做任何响度归一。
//
// 为什么要在 CI 钉死(2026-10-20 实测复盘):
//   此前解码侧 `buildAirplayAf()` 又调了一遍 `resolveLoudnessAf()` 并挂限制器,于是
//     · 同一段音频被归一**两遍**(动态被二次压缩,静默失真);
//     · 出流侧 DSP 落在归一之后、解码侧归一又落在 DSP 之后 ——
//       与 `pipeline.ts` 注释里「响度 → DSP → 限幅」的顺序契约**相反**。
//   两个方向都是静默故障:不报错、不崩溃,只是听感变差,手测极易漏判。
//
// 本守卫同时防两个方向:
//   · 方向一(本次修掉的):解码侧不得把 loudnorm/limiter/volume 段加回来(R1–R3);
//   · 方向二(防「两处都删」):出流侧公共链路的归一与音色 DSP **必须还在**(R4)——
//     否则修掉重复的同时把唯一的一遍也删没了,那是更严重的静默故障。
//
// 零依赖 node 脚本,挂 ci.yml 的守卫 job(与 check-* 系列同款)。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const DECODER = "backend/src/services/airplay/decoder.ts";
const REST = "backend/src/routes/rest/index.ts";

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}

const decCode = stripComments(read(DECODER));
const restCode = stripComments(read(REST));
const count = (hay, needle) => hay.split(needle).length - 1;

console.log("===== R1 解码侧不得引用响度归一(也不得再依赖 pipeline.airplay 开关) =====");
check(
  "decoder.ts 不再引用 resolveLoudnessAf(归一改由出流侧公共链路承担)",
  count(decCode, "resolveLoudnessAf") === 0,
  `仍出现 ${count(decCode, "resolveLoudnessAf")} 处`,
);
check(
  "decoder.ts 不再依赖 pipelineSwitches(解码侧与开关脱钩,开关只在出流侧生效)",
  count(decCode, "pipelineSwitches") === 0 && count(decCode, "isChannelEnabled") === 0,
  "解码侧仍引用渠道开关",
);
check(
  "decoder.ts 从 pipeline 只取 decodeArgs / outputFilters / isLoopbackUrl",
  /import\s*\{[^}]*decodeArgs[^}]*outputFilters[^}]*isLoopbackUrl[^}]*\}\s*from\s*"\.\.\/audio\/pipeline\.js"/.test(decCode),
  "pipeline 的 import 清单已变,请复核是否又引回了响度相关符号",
);

console.log("===== R2 输出段必须仍在,且 44.1k/16bit/stereo 参数锁定(RAOP 硬性要求) =====");
check("buildAirplayAf 仍走 outputFilters()", /outputFilters\(\{/.test(decCode), "未见 outputFilters({ 调用");
check("采样率恒 pin SAMPLE_RATE(targetRate)", /targetRate:\s*SAMPLE_RATE/.test(decCode), "未见 targetRate: SAMPLE_RATE");
check("位深恒 pin 16bit(targetBits)", /targetBits:\s*16/.test(decCode), "未见 targetBits: 16");
check("过渡期强采样率 forceRate 仍在", /forceRate:\s*SAMPLE_RATE/.test(decCode), "未见 forceRate: SAMPLE_RATE");
check('声道恒 pin stereo(forceChannels)', /forceChannels:\s*"stereo"/.test(decCode), "未见 forceChannels: \"stereo\"");
check("hasLoudnorm 恒 false(链中确无响度段)", /hasLoudnorm:\s*false/.test(decCode), "hasLoudnorm 不是常量 false");

console.log("===== R3 常量断言:解码侧不得再出现旧链三件套(loudnorm / alimiter / volume=) =====");
check("剥注释后全文无 loudnorm", count(decCode, "loudnorm") === 0, `残留 ${count(decCode, "loudnorm")} 处`);
check("剥注释后全文无 alimiter", count(decCode, "alimiter") === 0, `残留 ${count(decCode, "alimiter")} 处`);
check("剥注释后全文无 volume= 增益段", count(decCode, "volume=") === 0, `残留 ${count(decCode, "volume=")} 处`);
check("buildAirplayAf 仍被 spawnDecoder 使用(不是留了个没人调的死函数)", count(decCode, "buildAirplayAf()") >= 2, "未见调用点");

console.log("===== R4 反向断言:归一与音色 DSP 必须仍在出流侧公共链路做一遍 =====");
check("resolveRequestAf 仍调 resolveLoudnessAf(唯一的一遍归一)", count(restCode, "resolveLoudnessAf({") >= 1, "出流侧未见 resolveLoudnessAf({");
check("resolveRequestAf 仍调 playerDspFilters(音色链未丢)", count(restCode, "playerDspFilters(") >= 1, "出流侧未见 playerDspFilters(");
check(
  'cast 通道判定仍把 AirPlay 映射到 channel="airplay"(开关生效点仍在)',
  /isChannelEnabled\("airplay"\)\s*\?\s*"airplay"\s*:\s*null/.test(restCode),
  '未见 `isChannelEnabled("airplay") ? "airplay" : null`',
);

console.log("===== R5 单一实现:buildAirplayAf 不得在别处被复制一份 =====");
check(
  "buildAirplayAf 的函数声明只出现在 decoder.ts",
  count(read(DECODER), "export function buildAirplayAf") === 1
    && count(read(REST), "function buildAirplayAf") === 0,
  "疑似出现第二份实现",
);
check(
  "两条会话路径共用同一解码器(control.ts / sessionRuntime.ts 均从 ./decoder.js 引入)",
  /from\s*"\.\/decoder\.js"/.test(read("backend/src/services/airplay/sessionRuntime.ts"))
    && /spawnDecoder/.test(read("backend/src/services/airplay/sessionRuntime.ts")),
  "sessionRuntime.ts 未从 decoder.js 引入 spawnDecoder",
);

console.log("===== R6 重采样器不得再归一(它是解码侧的另一半,同样会二次压缩) =====");
// 2026-10-26 补:R1–R3 只钉了 decoder.ts,但解码侧的**另一半**是 48k→44.1k 的重采样器。
// 若有人在这里补一段 loudnorm/limiter(理由是「重采样后要重新压一下」),同一段音频会被
// 归一两次,且仍绕开「唯一发生地=出流侧」的契约 —— 不报错,只是听感变差,手测极难发现。
{
  const resCode = stripComments(read("backend/src/services/airplay/resampler.ts"));
  const trio = ["loudnorm", "alimiter", "volume="].map((k) => [k, count(resCode, k)]);
  check(
    "resampler.ts 剥注释后无 loudnorm / alimiter / volume= 增益段",
    trio.every(([, n]) => n === 0),
    trio.filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`).join(", "),
  );
  check(
    "resampler.ts 不引用归一/DSP 符号(resolveLoudnessAf / playerDspFilters)",
    count(resCode, "resolveLoudnessAf") === 0 && count(resCode, "playerDspFilters") === 0,
    `resolveLoudnessAf×${count(resCode, "resolveLoudnessAf")} playerDspFilters×${count(resCode, "playerDspFilters")}`,
  );
}

console.log("");
if (failures.length) {
  console.log(`✗ AirPlay 解码 af 守卫失败 ${failures.length} 项:`);
  for (const f of failures) console.log("   - " + f);
  process.exit(1);
}
console.log("✓ AirPlay 解码 af 守卫全部通过");
