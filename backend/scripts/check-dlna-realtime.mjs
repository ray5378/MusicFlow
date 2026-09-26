#!/usr/bin/env node
// ==================== DLNA 实时发现守卫（设备上线即刻入列） ====================
//
// 契约:DLNA 设备「实际已在线且在播」必须尽快出现在 `/v1/peers`(播放器列表)。
// 这是一条**静默退化**纪律 —— 不报错、不崩溃,只是「歌都放半天了列表里还没有这台
// 设备」,手测极易当成网络问题(2026-09-26 用户报「主卧已经开始播放很久了,一直不显示」)。
//
// 旧行为(任一条被改回去都会让 bug 复活):
//   · 周期扫描 5 分钟:设备不发 SSDP 通告时(音流等第三方 App 直接把已开机的设备拉起来播,
//     设备自己不会再广播 ssdp:alive),最坏要空等一整轮。
//   · 客户端拉 `/v1/peers` 完全不补扫:用户「打开/刷新列表」这个最自然的操作带不出设备。
//   · alive 通告抓取 description 失败一次就静默放弃,且**白白用掉 60s 去抖窗口** ——
//     设备刚上电时 SSDP 栈往往先于内嵌 HTTP 就绪,此刻必失败,于是这次「上线」被彻底错过
//     (230 模拟器实测:HTTP 恢复后设备还要 85s 才可见)。
//
// 七条规则:
//   R1 间隔单一真源:dlna/scanPolicy.ts 导出 DLNA_SCAN_INTERVAL_MS = 90s。
//   R2 入口不写死:index.ts 必须引用该常量,禁止再出现本地 `const DLNA_SCAN_INTERVAL`。
//   R3 拉列表即补扫:`/v1/peers` 路由必须调用 shouldRefreshDevices() 触发后台补扫。
//   R4 去抖可放开:discovery.ts 必须导出 clearAliveEmit(失败后放开窗口的能力)。
//   R5 alive 分支接线:control.ts 的 alive 处理必须①失败放开去抖 ②广播(仅新设备/离线→上线)。
//   R6 byebye 反向语义:必须标离线 + 落库 + 广播(不能变成无脑保活)。
//   R7 扫描并发去重:refreshDevices 必须用 refreshInFlight 共享同一轮扫描。
//
// 零依赖 node 脚本(与 check-seek-granularity.mjs / check-renderer-host.mjs 同款),
// 挂 ci.yml 的守卫 job。
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SCAN_POLICY = "backend/src/services/dlna/scanPolicy.ts";
const ENTRY = "backend/src/index.ts";
const PEERS_ROUTE = "backend/src/routes/api/index.ts";
const DISCOVERY = "backend/src/services/dlna/discovery.ts";
const CONTROL = "backend/src/services/dlna/control.ts";

const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "");
/** 剥掉注释:只审「代码里真的这么写」,注释里的说明/示例不拦。 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 从源码里取出某个 `if (...)` 分支的**整段内容**(按花括号配对)。返回 `{ body, end }`,找不到返回 null。 */
function branchBody(src, header, from = 0) {
  const i = src.indexOf(header, from);
  if (i === -1) return null;
  const start = src.indexOf("{", i + header.length - 1);
  if (start === -1) return null;
  let depth = 0;
  for (let k = start; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(start + 1, k), end: k };
    }
  }
  return null;
}

/** 取出 `export function <name>(...)` 的整个函数体(含花括号配对)。 */
function functionBody(src, name) {
  const header = "export function " + name + "(";
  const i = src.indexOf(header);
  if (i === -1) return null;
  const start = src.indexOf("{", i + header.length - 1);
  if (start === -1) return null;
  let depth = 0;
  for (let k = start; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, k + 1);
    }
  }
  return null;
}

const violations = [];
const fail = (rule, msg) => violations.push(`${rule} ${msg}`);

// ---------------- R1 间隔单一真源 ----------------
const policy = stripComments(read(SCAN_POLICY));
if (!/export\s+const\s+DLNA_SCAN_INTERVAL_MS\s*=\s*90\s*\*\s*1000\s*;/.test(policy)) {
  fail("R1", `${SCAN_POLICY} 必须导出 \`DLNA_SCAN_INTERVAL_MS = 90 * 1000\``);
}
if (!/export\s+const\s+DISCOVERY_CACHE_TTL_MS\s*=/.test(policy)) {
  fail("R1", `${SCAN_POLICY} 必须导出 \`DISCOVERY_CACHE_TTL_MS\``);
}

// ---------------- R2 入口不写死 ----------------
// 注意:这里**故意不** stripComments。—— index.ts 存在跨行块注释,剥注释时会把中间的
// import 一并吞掉,导致守卫对「真的写了」的代码误报(2026-09-26 实测:剥完后
// `import { DLNA_SCAN_INTERVAL_MS } from "./services/dlna/scanPolicy.js"` 整条消失)。
// import / setInterval 这类接线本就不该藏在注释里,直接用原文审更贴合意图。
const entry = read(ENTRY);
if (/\bconst\s+DLNA_SCAN_INTERVAL\s*=/.test(entry)) {
  fail("R2", `${ENTRY} 不得再定义本地 \`const DLNA_SCAN_INTERVAL\`,应引用 scanPolicy 的单一真源`);
}
if (/setInterval\s*\(\s*\(\)\s*=>\s*\{\s*refreshAndRegisterDevices\(\)\s*;?\s*\}\s*,\s*DLNA_SCAN_INTERVAL_MS\s*\)/.test(entry)) {
  // 接线正确：无需追加断言
} else if (entry.includes("refreshAndRegisterDevices")) {
  fail("R2", `${ENTRY} 的周期扫描未以 DLNA_SCAN_INTERVAL_MS 为间隔`);
}
if (!/from\s+"\.\/services\/dlna\/scanPolicy\.js"/.test(entry)) {
  fail("R2", `${ENTRY} 未从 scanPolicy.js 引入 DLNA_SCAN_INTERVAL_MS`);
}

// ---------------- R3 拉列表即补扫 ----------------
const routes = stripComments(read(PEERS_ROUTE));
const peersIdx = routes.indexOf('"/v1/peers"');
if (peersIdx === -1) {
  fail("R3", `${PEERS_ROUTE} 未找到 \`/v1/peers\` 路由`);
} else {
  // 取该路由处理函数的开头一小段（应紧跟路由声明）
  const body = routes.slice(peersIdx, peersIdx + 700);
  if (!/shouldRefreshDevices\(\)/.test(body)) {
    fail("R3", `${PEERS_ROUTE} 的 \`/v1/peers\` 未调用 shouldRefreshDevices() 后台补扫 —— 拉列表本身带不出刚上线的设备`);
  }
}

// ---------------- R4 去抖可放开 ----------------
const discovery = stripComments(read(DISCOVERY));
if (!/export\s+function\s+clearAliveEmit\s*\(/.test(discovery)) {
  fail("R4", `${DISCOVERY} 必须导出 \`clearAliveEmit\`(失败后放开 alive 去抖窗口)`);
}

// ---------------- R5 / R6 alive 与 byebye 分支接线 ----------------
// 只在 wireSsdpRealtime 这个函数体里找:control.ts 里 `} else {` 有多处
// (refreshDevices、设备清理等),直接取第一个会取错分支(2026-09-26 实测踩到)。
const control = stripComments(read(CONTROL));
const wireFn = functionBody(control, "wireSsdpRealtime");
if (wireFn === null) {
  fail("R5", `${CONTROL} 未找到 wireSsdpRealtime 函数`);
} else {
  const aliveFound = branchBody(wireFn, 'if (e.type === "alive")');
  const alive = aliveFound ? aliveFound.body : null;
  if (aliveFound === null) {
    fail("R5", `${CONTROL} 未找到 alive 处理分支`);
  } else {
    if (!alive.includes("clearAliveEmit(")) {
      fail("R5", `${CONTROL} 的 alive 分支抓 description 失败后未调 clearAliveEmit() 放开去抖 —— 这一次上线窗口会被白白用掉`);
    }
    if (!alive.includes("emitDeviceListChanged")) {
      fail("R5", `${CONTROL} 的 alive 分支未广播设备列表变化(三端不会即时可见)`);
    }
    // 只在「新设备」或「离线→上线」时广播,避免周期通告反复刷屏
    if (!/if\s*\(\s*idx\s*<\s*0\s*\|\|\s*!wasAvailable\s*\)\s*\{?\s*getEventManager\(\)\.emitDeviceListChanged/.test(alive)) {
      fail("R5", `${CONTROL} 的 alive 广播条件不再是「新设备 或 离线→上线」(会周期性刷屏)`);
    }
  }

  // ---------------- R6 byebye 反向语义 ----------------
  // 两个坑(2026-09-26 实测踩过):
  //  ① `} else {` 全文件有 8 处,必须限定在 wireSsdpRealtime 体内;
  //  ② 即便限定在体内,alive 分支里的 `if (idx >= 0) { … } else { … }` 又贡献了一个,
  //     直接取第一个会抓到「push(d) / upsertDeviceRow(d)」那段。
  //     → 从 alive 分支结束处(`end`)往后找,才拿到与 alive 对齐的那个 else。
  const bye = aliveFound ? branchBody(wireFn, "} else {", aliveFound.end) : null;
  const byeBody = bye ? bye.body : null;
  if (byeBody === null) {
    fail("R6", `${CONTROL} 未找到与 alive 配对的 byebye 分支`);
  } else {
    if (!byeBody.includes("available = false")) {
      fail("R6", `${CONTROL} 的 byebye 分支未标离线(会退化成无脑保活,设备下线后永远留在列表)`);
    }
    if (!byeBody.includes("markDeviceOfflineInDb")) {
      fail("R6", `${CONTROL} 的 byebye 分支未落库`);
    }
    if (!byeBody.includes("emitDeviceListChanged")) {
      fail("R6", `${CONTROL} 的 byebye 分支未广播`);
    }
  }
}

// ---------------- R7 扫描并发去重 ----------------
// 跨度必须放宽:`let refreshInFlight` 与 `if (refreshInFlight)` 之间隔着
// `refreshDevices(timeoutMs = 4000)` 的整个函数签名(实测约 140 字符),
// 按原来的 {0,120} 会误报(2026-09-26 实测)。
if (!/let\s+refreshInFlight[\s\S]{0,400}?if\s*\(\s*refreshInFlight\s*\)\s*return\s+refreshInFlight/.test(control)) {
  fail("R7", `${CONTROL} 的 refreshDevices 未用 refreshInFlight 共享同一轮扫描(多端同时拉列表会重复扫)`);
}

// ---------------- 报告 ----------------
if (violations.length) {
  console.error("DLNA 实时发现守卫 失败:");
  for (const v of violations) console.error("  ✗ " + v);
  process.exit(1);
}
console.log("· R1 间隔单一真源(scanPolicy: 90s / TTL 60s)");
console.log("· R2 入口引用常量,无本地写死");
console.log("· R3 `/v1/peers` 拉列表即补扫");
console.log("· R4 discovery 导出 clearAliveEmit");
console.log("· R5 alive 分支:失败放开去抖 + 按需广播");
console.log("· R6 byebye 分支:标离线 + 落库 + 广播");
console.log("· R7 refreshDevices 并发去重");
console.log("✅ DLNA 实时发现守卫通过");
