#!/usr/bin/env node
// ==================== AirPlay ↔ DLNA 双协议互斥守卫 ====================
//
// 契约:AirPlay 起播前必须让**同一物理设备**(同 host 的 DLNA renderer)彻底让出音频输入,
// 且必须做**两件事**缺一不可:
//   ① 冻结该 DLNA 队列的自动推进(QueueController.stopPlayback);
//   ② 对同 host 的 DLNA renderer 下发 SOAP Stop + 清内存媒体态(stopDevicePlayback)。
//
// 为什么必须在 CI 钉死(2026-10-20 实测二阶反杀):
//   AP1 修复后 AirPlay 已能出声,但首轮仅 129 chunks / 1.0s 就被打断,日志为
//   `双协议互斥:DLNA 播放前停止同 host AirPlay 会话`。根因不是设备,而是只做了 ②:
//   设备 Stop 后经 GENA 上报 IDLE,而 DLNA 队列仍 active,PlaybackTracker 把它判成
//   「这首自然放完」→ advance → 重新 castToDevice → castToDevice 的互斥再 TEARDOWN
//   掉刚建立的 AirPlay 会话。用户可见症状 =「AirPlay 刚出声约 1 秒就被切走/断开」。
//
// 破坏完全是静默的:不报错、不崩溃,只是「刚出声就没声了」,手测极易误判为设备/网络问题。
//
// 两个方向都要保住:
//   · AirPlay 起播 → 停并冻结同 host DLNA(本文件 R1–R3);
//   · DLNA 起播  → 停同 host AirPlay 会话(dlna/control.ts,R4/R5)。
//
// 零依赖 node 脚本,挂 ci.yml 的守卫 job(与 check-* 系列同款)。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const AIRPLAY = "backend/src/services/airplay/control.ts";
const DLNA = "backend/src/services/dlna/control.ts";

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}

const apCode = stripComments(read(AIRPLAY));
const dlnaCode = stripComments(read(DLNA));
const count = (hay, needle) => hay.split(needle).length - 1;

console.log("===== R1 单一助手:同 host DLNA 互斥只能有一处实现 =====");
const helperStart = apCode.indexOf("async function yieldSiblingDlnaForAirPlay");
const helperEnd = apCode.indexOf("async function startSession");
const helper = helperStart >= 0 && helperEnd > helperStart ? apCode.slice(helperStart, helperEnd) : "";
check("存在统一助手 yieldSiblingDlnaForAirPlay", helper.length > 0, "未找到该函数声明");
check(
  "助手内冻结同 host DLNA 队列(getQueueController().stopPlayback)",
  /getQueueController\(\)\s*\.\s*stopPlayback\(/.test(helper),
  "助手内未调用 getQueueController().stopPlayback(...)",
);
check(
  "助手内下发 SOAP Stop(stopDevicePlayback)",
  /stopDevicePlayback\(/.test(helper),
  "助手内未调用 stopDevicePlayback(...)",
);
const iFreeze = helper.indexOf("stopPlayback(");
const iStop = helper.indexOf("stopDevicePlayback(");
check(
  "助手内顺序:先冻结队列,再 SOAP Stop(GENA 事件异步回投,冻结必须抢在前面)",
  iFreeze >= 0 && iStop > iFreeze,
  `freeze@${iFreeze} stop@${iStop}(冻结必须在前)`,
);
check(
  "助手经动态 import 取 QueueController(避免 airplay↔player↔dlna 静态循环依赖)",
  /await\s+import\("\.\.\/player\/index\.js"\)/.test(helper),
  "助手内未见 `await import(\"../player/index.js\")`",
);

console.log("===== R2 两个起播入口都必须经过该助手 =====");
check(
  "startSession(in-proc)与 castViaChild(fork)各调用一次(共 2 处)",
  count(apCode, "await yieldSiblingDlnaForAirPlay(opts.deviceId)") === 2,
  `实际 = ${count(apCode, "await yieldSiblingDlnaForAirPlay(opts.deviceId)")} 处(应为 2)`,
);

console.log("===== R3 常量断言:起播路径不得再出现「只停 SOAP、不冻队列」的裸实现 =====");
// 把助手整段挖掉后,其余代码不该再有 stopDevicePlayback(...) —— 有了就是绕过助手的手写互斥。
const apWithoutHelper = helper ? apCode.replace(helper, "//<helper>") : apCode;
check(
  "**常量断言**:助手之外无裸 stopDevicePlayback 调用(互斥只能走单一助手)",
  count(apWithoutHelper, "stopDevicePlayback(") === 0,
  `助手外残留 ${count(apWithoutHelper, "stopDevicePlayback(")} 处`,
);

console.log("===== R4 反向互斥(DLNA 起播 → 停同 host AirPlay 会话)仍在 =====");
const castStart = dlnaCode.indexOf("export async function castToDevice");
const castBody = castStart >= 0 ? dlnaCode.slice(castStart, castStart + 2000) : "";
check("能定位到 dlna/control.ts 的 castToDevice", castBody.length > 0, "未找到 castToDevice");
check(
  "castToDevice 仍调用 stopAirPlaySessionsForHost(动态 import 避免循环依赖)",
  /await\s+import\("\.\.\/airplay\/control\.js"\)/.test(castBody)
    && /stopAirPlaySessionsForHost\(/.test(castBody),
  "castToDevice 内未见动态 import + stopAirPlaySessionsForHost(...)",
);

console.log("===== R5 反向互斥的实现仍在 airplay/control.ts =====");
check(
  "仍导出 stopAirPlaySessionsForHost(返回被停会话 id 列表)",
  /export\s+async\s+function\s+stopAirPlaySessionsForHost\s*\(/.test(apCode),
  "airplay/control.ts 未导出 stopAirPlaySessionsForHost",
);

console.log("");
if (failures.length) {
  console.log(`✗ AirPlay↔DLNA 双协议互斥守卫失败 ${failures.length} 项:`);
  for (const f of failures) console.log("   - " + f);
  process.exit(1);
}
console.log("✓ AirPlay↔DLNA 双协议互斥守卫全部通过");
