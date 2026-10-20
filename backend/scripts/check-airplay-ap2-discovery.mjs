#!/usr/bin/env node
// ==================== AirPlay 2 能力分级发现守卫(E2) ====================
//
// 契约(2026-10-20 课题 E2 定稿):
//   1. **设备表仍只由 `_raop._tcp` 产生** —— `_airplay._tcp` 只给「已存在的」raop 设备
//      打能力标记。纯 AP2-only 广播不得凭空造出设备:AP2 发送端(E3~E5)落地前它投不了,
//      进来只会变成一个「点了报错」的死设备,还会污染既有的 AP1 设备表。
//   2. AP2 判据 = 同时有 `_airplay` 记录 **且** `protovers ≥ 1.1`。不认「某个 features 位」:
//      位定义只能由 230 接收器实测反证,凭记忆写死会在真机上分错级。
//   3. `_airplay` 记录下线 ⇒ 能力翻回 false,但设备**可用性**仍由 `_raop` 的 up/down 决定。
//   4. AP1 链路零回归:投屏入口仍是 `castToAirPlayDevice`(AP2 分流不在 E2 范围内)。
//
// 为什么要在 CI 钉死:这类破坏全静默 ——
//   · 把 `_airplay` 记录当设备写进表 → 多出一批投不了的设备,但没有任何报错;
//   · 判据写错(比如无条件 true)→ 所有设备都「支持 AP2」,E3 之后才会集体发疯;
//   · 漏了 down 的清理 → 设备明明关了 AP2 仍长期显示支持。
// 零依赖 node 脚本,挂 ci.yml 的 AirPlay 守卫 job。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const DISCOVERY = "backend/src/services/airplay/discovery.ts";
const RENDERER = "backend/src/services/plugin/renderers/airplay.ts";
const CONTROL = "backend/src/services/airplay/control.ts";

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}

const disc = stripComments(read(DISCOVERY));
const rend = stripComments(read(RENDERER));
const ctrl = stripComments(read(CONTROL));
const count = (hay, needle) => hay.split(needle).length - 1;

console.log("===== R1 两种 mDNS 记录都浏览,但设备表只有一个来源 =====");
check(
  "同时浏览 `_raop._tcp` 与 `_airplay._tcp`",
  /type:\s*"raop"/.test(disc) && /type:\s*"airplay"/.test(disc),
  "缺少其中一种 type",
);
check(
  "`_raop` 常驻 browser 仍由 upsert(建表)驱动",
  /bonjour\.find\(\{\s*type:\s*"raop"\s*\},[\s\S]{0,120}?upsert\(/.test(disc),
  "raop browser 的命中回调不是 upsert",
);
check(
  "`_airplay` 常驻 browser 由 upsertAp2(只打能力)驱动",
  /bonjour\.find\(\{\s*type:\s*"airplay"\s*\},[\s\S]{0,120}?upsertAp2\(/.test(disc),
  "airplay browser 的命中回调不是 upsertAp2",
);
// upsertAp2 体内不得写 devices.set —— 那等于让 `_airplay` 也能造设备。
const upsertAp2Body = (disc.match(/function upsertAp2\([\s\S]*?\n\}/) || [])[0] || "";
check(
  "**upsertAp2 不得写 devices 表**(纯 AP2-only 广播不能造出 AP1 设备)",
  upsertAp2Body.length > 0 && count(upsertAp2Body, "devices.set(") === 0,
  upsertAp2Body ? "upsertAp2 内出现了 devices.set(" : "未找到 upsertAp2",
);
check(
  "upsertAp2 只往能力表写(ap2Caps.set 恰好 1 处)",
  count(upsertAp2Body, "ap2Caps.set(") === 1,
  `实际 = ${count(upsertAp2Body, "ap2Caps.set(")}(应为 1)`,
);
check(
  "`_airplay` 缺 deviceid 时直接忽略(不靠名字猜设备)",
  /if\s*\(!id\)\s*return/.test(upsertAp2Body),
  "upsertAp2 未见 deviceid 空值早退",
);

console.log("===== R2 判据:protovers ≥ 1.1 且必须同时有 `_airplay` 记录 =====");
const applyBody = (disc.match(/function applyAp2\([\s\S]*?\n\}/) || [])[0] || "";
check(
  "存在唯一写 supportsAp2 的助手 applyAp2",
  applyBody.length > 0 && count(disc, "supportsAp2 =") === 1,
  applyBody ? `supportsAp2 赋值出现 ${count(disc, "supportsAp2 =")} 次(应为 1)` : "未找到 applyAp2",
);
check(
  "supportsAp2 = 同时依赖 ap2Caps 命中与 protovers 下限(不得写死 true)",
  /supportsAp2\s*=\s*!!info\s*&&\s*protoversAtLeast\(/.test(applyBody),
  "判据不是「信息存在 && protoversAtLeast」",
);
check(
  "protoversAtLeast 对缺省 / 非法值返回 false(宁可不认 AP2,也不误判)",
  /if\s*\(!v\)\s*return false/.test(disc) && /if\s*\(!m\)\s*return false/.test(disc),
  "protoversAtLeast 缺少空值 / 解析失败早退",
);
check(
  "AP2 协议版本下限常量为 1.1(与 230 接收器 protovers 实测一致)",
  /AP2_MIN_PROTOVERS[^=]*=\s*\[1,\s*1\]/.test(disc),
  "未找到 [1, 1] 的版本下限",
);

console.log("===== R3 down 必须清能力(否则关掉 AP2 仍长期显示支持) =====");
const dropBody = (disc.match(/function dropAp2\([\s\S]*?\n\}/) || [])[0] || "";
check(
  "存在 dropAp2 且删除能力表条目",
  dropBody.length > 0 && count(dropBody, "ap2Caps.delete(") === 1,
  dropBody ? "dropAp2 未删除 ap2Caps" : "未找到 dropAp2",
);
check(
  "`_airplay` 的 down 走 dropAp2(不是把设备标记离线)",
  /ap2Browser\.on\("down"[\s\S]{0,80}?dropAp2\(/.test(disc),
  "airplay down 未接 dropAp2",
);
check(
  "`_raop` 的 down 仍只把设备标记离线(AP1 行为未变)",
  /browser\.on\("down"[\s\S]{0,160}dev\.available = false/.test(disc),
  "raop down 分支被改动",
);
check(
  "stop 时清空能力表(避免下一轮启动残留旧能力)",
  /ap2Caps\.clear\(\)/.test(disc),
  "stopAirPlayDiscovery 未清 ap2Caps",
);

console.log("===== R4 AP1 零回归:对外能力透出存在,投屏入口未改 =====");
check(
  "listAirPlayDevices 透出 supportsAp2 与 ap2 原始能力",
  /supportsAp2:\s*!!d\.supportsAp2/.test(ctrl) && /ap2:\s*d\.ap2/.test(ctrl),
  "control.ts 未透出 AP2 能力",
);
check(
  "renderer 的 discover meta 带 supportsAp2",
  /supportsAp2:\s*d\.supportsAp2/.test(rend),
  "renderer discover 未上报 supportsAp2",
);
check(
  "**renderer 的 cast 仍只调 castToAirPlayDevice**(E2 不得提前分流 AP2)",
  count(rend, "castToAirPlayDevice(") === 1 && !/castToAirPlay2|ap2Cast|ap2\/cast/.test(rend),
  "renderer 里出现了 AP2 投屏分流",
);

if (failures.length) {
  console.error(`\n[AirPlay2 发现分级守卫] FAIL:${failures.length} 项`);
  process.exit(1);
}
console.log("\n[AirPlay2 发现分级守卫] 全部通过");
