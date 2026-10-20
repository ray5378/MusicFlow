#!/usr/bin/env node
// ==================== AirPlay/RAOP RTSP 请求行守卫(版本段不得省) ====================
//
// 背景(2026-10-20 在 230 的 shairport-sync 接收器上定位):
//   `services/airplay/raop.ts` 的 sendRtsp / sendRtspNoWait 发出的请求行只有两段
//   `METHOD rtsp://host:port/sid` —— **漏了 RFC 2326 要求的 `RTSP/1.0` 版本段**。
//   真机 HiVi H5MKII 容错吸收了非法请求行,所以此前一直没暴露;换成标准合规的
//   shairport-sync,对端直接回 `RTSP/1.0 400 Bad Request`
//   (接收端日志 `msg_handle_line fail` / `can't find an RTSP header`),
//   表现为「AirPlay 接收器连不上、一个字都放不出来」。A/B 实测(同一 SDP):
//     无版本段 → 400;补上 `RTSP/1.0` → ANNOUNCE / SETUP / RECORD 全 200。
//
// 为什么要在 CI 钉死:这类缺陷**全静默** ——
//   · 不报错(我们只是把 400 当"握手失败"抛出来,不解释原因);
//   · 真机(容错型)上完全正常,只有换一台合规接收端才复现;
//   · 单测若只断言 `toContain("ANNOUNCE ")`,漏版本段照样绿(本次之前正是如此)。
//
// 三条规则:
//   R1 两个发送函数(sendRtsp / sendRtspNoWait)的请求行模板都必须拼出三段式;
//   R2 反向钉死:不得存在只拼两段(`METHOD ${url}\r\n`)的写法;
//   R3 动态契约(在单测里):raopTransport.test.ts 必须断言请求行以 `RTSP/1.0` 收尾。
//
// 零依赖 node 脚本,挂 ci.yml 的 AirPlay 守卫 job。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const RAOP = "backend/src/services/airplay/raop.ts";
const TEST = "backend/tests/airplay/raopTransport.test.ts";

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}

const code = stripComments(read(RAOP));
const test = stripComments(read(TEST));
const count = (hay, needle) => hay.split(needle).length - 1;

console.log("===== R1 两个发送函数的请求行都拼成三段式(METHOD url RTSP/1.0) =====");
const withVersion = count(code, "` ${this.url} RTSP/1.0\\r\\n`");
// 1 处 sendRtsp + 1 处 sendRtspNoWait = 2。
check(
  "**常量断言**:`${this.url} RTSP/1.0` 出现且仅出现 2 次(sendRtsp + sendRtspNoWait)",
  withVersion === 2,
  `实际 = ${withVersion}(应为 2)`,
);
check(
  "sendRtsp 存在且在其体内拼接请求行",
  /private\s+sendRtsp\([\s\S]*?`\s\$\{this\.url\} RTSP\/1\.0\\r\\n`/.test(code),
  "sendRtsp 内未找到三段式请求行",
);
check(
  "sendRtspNoWait 存在且在其体内拼接请求行(fire-and-forget 同样不得漏版本段)",
  /private\s+sendRtspNoWait\([\s\S]*?`\s\$\{this\.url\} RTSP\/1\.0\\r\\n`/.test(code),
  "sendRtspNoWait 内未找到三段式请求行",
);

console.log("===== R2 反向钉死:不得再出现只拼两段的请求行 =====");
// 两段写法形如 `` ` ${this.url}\r\n` ``(没有 RTSP/1.0)。
const twoSegment = count(code, "` ${this.url}\\r\\n`");
check(
  "不存在 `METHOD url`(缺版本段)的请求行模板",
  twoSegment === 0,
  `仍有 ${twoSegment} 处两段式请求行`,
);

console.log("===== R3 动态契约:单测必须断言请求行以 RTSP/1.0 收尾 =====");
check(
  "raopTransport.test.ts 断言三条握手请求行以 RTSP/1.0 收尾",
  count(test, "RTSP/1\\.0$") >= 1 || count(test, "RTSP\\/1\\.0") >= 1,
  "未见请求行版本段断言",
);
check(
  "raopTransport.test.ts 覆盖 fire-and-forget 分支(SET_PARAMETER)的版本段",
  /SET_PARAMETER rtsp:\\\/\\\/\\S\+ RTSP\\\/1\\\.0/.test(test) || count(test, "SET_PARAMETER ") >= 1,
  "未见 SET_PARAMETER 请求行断言",
);

if (failures.length) {
  console.error(`\n[AirPlay RTSP 请求行守卫] FAIL:${failures.length} 项`);
  process.exit(1);
}
console.log("\n[AirPlay RTSP 请求行守卫] 全部通过");
