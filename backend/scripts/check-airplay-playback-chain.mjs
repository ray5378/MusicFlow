#!/usr/bin/env node
// ==================== AirPlay 播放链路时序守卫(PLAYING 主动上报 / IDLE 真实落点 / 过期会话抑制) ====================
//
// 背景(2026-10-20 现网三条现象定位,HiVi H5MKII 实测):
//   a) 当前曲放完不自动下一首;
//   b) 重复播放同一首、且未播完就从头循环;
//   c) 不接受外部切歌指令(客户端/网页切歌无效)。
//
// 三条**共同的可观测根因** = AirPlay 的 PLAYING 只有「5s 兜底轮询」一个来源:
//   · 轮询在 QueueController.advancing 期间被整台跳过,而 cast 返回后
//     resetTracker/armOptimisticTimeout 与下一次轮询之间可能跨过整整一个 5s 周期;
//   · 乐观窗口(PlayerController.armOptimisticTimeout,**只由一条 PLAYING 关闭**)因此
//     常常先超时 → 判 stalled → QueueController 重投**当前曲**(从头) ⇒ (b);
//   · 自然结束的 IDLE 又被**仍开着**的乐观窗口吞掉
//     (`窗口内忽略 IDLE(等待 PLAYING 确认)`)⇒ (a);
//   · 反复 5s 重投长期占用 advancing 闸,期间 next/playFrom 被
//     `if (advancing.has(id)) return` 静默吞掉 ⇒ (c)。
// 另有第二条独立缺陷:被新起播/显式 stop 取代的旧会话,其 finalizer 仍会上报 IDLE ——
// 那条 IDLE 属于**上一首**,与新会话共用同一 playerId,会把刚切过去的新曲判成"已结束"
// (用户观感「刚切过去就被切走」)。
//
// 破坏全是静默的:不报错、不崩溃、既有测试也照样绿,只在真机上表现为"没法用"。
// 零依赖 node 脚本,挂 ci.yml 的守卫 job(与 check-* 系列同款)。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const CONTROL = "backend/src/services/airplay/control.ts";
const PROTO = "backend/src/services/airplay/protocolPlayer.ts";
const RUNTIME = "backend/src/services/airplay/sessionRuntime.ts";
const IPC = "backend/src/services/airplay/ipcProtocol.ts";
const CHILD_MAIN = "backend/src/services/airplay/childMain.ts";
const SUPERVISOR = "backend/src/services/airplay/supervisor.ts";

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}

const ap = stripComments(read(CONTROL));
const proto = stripComments(read(PROTO));
const runtime = stripComments(read(RUNTIME));
const ipc = stripComments(read(IPC));
const childMain = stripComments(read(CHILD_MAIN));
const supervisor = stripComments(read(SUPERVISOR));
const count = (hay, needle) => hay.split(needle).length - 1;

console.log("===== R1 单一 PLAYING 上报出口,且 in-proc / fork 两个起播入口都调用 =====");
check(
  "存在统一助手 reportAirPlayPlaying(会话建立即上报 PLAYING)",
  /function\s+reportAirPlayPlaying\s*\(/.test(ap),
  "未找到 reportAirPlayPlaying 的函数声明",
);
// 1 处定义 + 2 处调用(runStream in-proc / castViaChild fork)= 3。少一处即"某条链路
// 又退回只等 5s 轮询",而这条缺陷在单测里**不会**自己变红。
check(
  "**常量断言**:reportAirPlayPlaying 出现且仅出现 3 次(定义 1 + 两入口各 1)",
  count(ap, "reportAirPlayPlaying(") === 3,
  `实际 = ${count(ap, "reportAirPlayPlaying(")}(应为 3)`,
);
check(
  "in-proc 入口(runStream)调用 reportAirPlayPlaying",
  count(ap, "reportAirPlayPlaying(active.deviceId") === 1,
  `runStream 内调用 = ${count(ap, "reportAirPlayPlaying(active.deviceId")}(应为 1)`,
);
check(
  "fork 入口(castViaChild)调用 reportAirPlayPlaying",
  count(ap, "reportAirPlayPlaying(opts.deviceId") === 1,
  `castViaChild 内调用 = ${count(ap, "reportAirPlayPlaying(opts.deviceId")}(应为 1)`,
);

console.log("===== R2 PLAYING 载荷必须带 mediaUri(否则「uri 变 = 换歌」判据恒不可达) =====");
const playingFnStart = ap.indexOf("function reportAirPlayPlaying(");
const playingFnEnd = ap.indexOf("function getAirPlayMediaUri(", playingFnStart);
const playingFn = playingFnStart >= 0 && playingFnEnd > playingFnStart
  ? ap.slice(playingFnStart, playingFnEnd) : "";
check("能定位到 reportAirPlayPlaying 函数体", playingFn.length > 0, "函数体切片为空");
check(
  "PLAYING 载荷:playbackState = PlaybackState.PLAYING",
  /playbackState:\s*PlaybackState\.PLAYING/.test(playingFn),
  "PLAYING 载荷里未见 playbackState: PlaybackState.PLAYING",
);
check(
  "PLAYING 载荷:mediaUri = 取流地址(不得省略)",
  /mediaUri:\s*streamUrl/.test(playingFn),
  "PLAYING 载荷里未见 mediaUri: streamUrl",
);

console.log("===== R3 上报时点:必须晚于「会话已就绪」,不能挂在起播前的占位态上 =====");
{
  const iAttach = ap.indexOf("active.streamPromise = p;");
  const iReport = ap.indexOf("reportAirPlayPlaying(active.deviceId");
  check(
    "runStream:PLAYING 上报在 `active.streamPromise = p;` **之后**(会话已挂上推流)",
    iAttach >= 0 && iReport > iAttach,
    `attach@${iAttach} report@${iReport}(上报必须晚于挂载)`,
  );
  const iLastCast = ap.indexOf("lastCast.set(opts.deviceId");
  const iForkReport = ap.indexOf("reportAirPlayPlaying(opts.deviceId");
  check(
    "castViaChild:PLAYING 上报在 `lastCast.set(opts.deviceId` **之后**(主进程已持有本轮地址)",
    iLastCast >= 0 && iForkReport > iLastCast,
    `lastCast@${iLastCast} report@${iForkReport}`,
  );
}

console.log("===== R4 IDLE 出口唯一 + 必须带真实落点(不得写死 0) =====");
check(
  "reportAirPlayIdle 接收 positionSec/durationSec(不再是无参上报)",
  /function\s+reportAirPlayIdle\s*\(\s*deviceId:\s*string\s*,\s*positionSec\s*=\s*0\s*,\s*durationSec\s*=\s*0\s*\)/.test(ap),
  "reportAirPlayIdle 签名未见 positionSec/durationSec 默认参",
);
const idleFnStart = ap.indexOf("function reportAirPlayIdle(");
const idleFnEnd = ap.indexOf("function reportAirPlayPlaying(", idleFnStart);
const idleFn = idleFnStart >= 0 && idleFnEnd > idleFnStart ? ap.slice(idleFnStart, idleFnEnd) : "";
check("能定位到 reportAirPlayIdle 函数体", idleFn.length > 0, "函数体切片为空");
check(
  "IDLE 载荷用真实落点(position: Math.max(0, positionSec))",
  /position:\s*Math\.max\(0,\s*positionSec\)/.test(idleFn),
  "IDLE 载荷未见 position: Math.max(0, positionSec)",
);
// 常量断言:旧实现把 position 写死 0 —— 它靠"末次 5s 轮询恰好落在结尾附近"才碰巧
// 满足 tracker 的结束判据(位置 ≥ 时长−容差),漏一拍就退化成 idle_early。
check(
  "**常量断言**:IDLE 载荷不得出现写死的 `position: 0,`",
  !/position:\s*0\s*,/.test(idleFn),
  "IDLE 载荷里又出现了写死的 position: 0",
);
// 常量断言:control.ts 里 reportState 调用点**恰好 2 处**(两个助手)。
// 旧实现在 runStream finalizer 里还内联上报一次 IDLE(与 handleAirplaySessionEnded
// 里的那条重复),不但双报,还把 position 写死 0。加回来即 = 3 处 → 判红。
check(
  "**常量断言**:control.ts 的 reportState 调用点恰为 2(reportAirPlayIdle + reportAirPlayPlaying)",
  count(ap, "reportState(") === 2,
  `实际 = ${count(ap, "reportState(")}(应为 2;>2 说明又出现了内联/重复上报)`,
);

console.log("===== R5 过期会话抑制:被取代的旧会话不得上报 IDLE(切歌通路) =====");
check(
  "handleAirplaySessionEnded 接收第 4 参 endInfo(携带 current/落点)",
  /handleAirplaySessionEnded\(\s*deviceId: string,\s*loudnessStderr = "",\s*songIdHint\?: string,\s*endInfo\?: AirplaySessionEndInfo,\s*/m
    .test(ap),
  "handleAirplaySessionEnded 未见 endInfo?: AirplaySessionEndInfo 形参",
);
check(
  "存在抑制分支:endInfo && endInfo.current === false 时**不上报** IDLE",
  /if\s*\(endInfo\s*&&\s*endInfo\.current\s*===\s*false\)/.test(ap),
  "未见 endInfo.current === false 的抑制分支",
);
{
  // 抑制分支里绝不能再出现 reportAirPlayIdle —— 否则"抑制"是假的。
  const iGuard = ap.indexOf("endInfo.current === false");
  const iElse = ap.indexOf("reportAirPlayIdle(deviceId,", iGuard);
  const iBlockEnd = ap.indexOf("const songId = songIdHint", iGuard);
  check(
    "抑制分支的 else 支才调 reportAirPlayIdle(守卫分支内不得上报)",
    iGuard >= 0 && iElse > iGuard && iElse < iBlockEnd,
    `guard@${iGuard} idle@${iElse} blockEnd@${iBlockEnd}`,
  );
}
{
  // stillCurrent 必须在 delete **之前**判定 —— 放在 delete 之后永远读到 false,
  // 会把**自然结束**也一起抑制掉(队列永不推进),这是最危险的等价变异。
  const iStill = ap.indexOf("const stillCurrent = sessions.get(active.deviceId) === active;");
  const iDel = ap.indexOf("sessions.delete(active.deviceId)");
  check(
    "in-proc finalizer:stillCurrent 判定先于 sessions.delete(顺序不得倒置)",
    iStill >= 0 && iDel > iStill,
    `stillCurrent@${iStill} delete@${iDel}`,
  );
  check(
    "in-proc finalizer:endInfo 带上 current: stillCurrent",
    count(ap, "current: stillCurrent") === 1,
    `current: stillCurrent 出现 ${count(ap, "current: stillCurrent")} 次(应为 1)`,
  );
}

console.log("===== R6 子进程(fork)侧同口径:事件带落点与 current =====");
check(
  "sessionRuntime 导出共享类型 AirplaySessionEndInfo(current/positionSec/durationSec)",
  /export\s+interface\s+AirplaySessionEndInfo/.test(runtime)
    && /current:\s*boolean;/.test(runtime)
    && /positionSec:\s*number;/.test(runtime)
    && /durationSec:\s*number;/.test(runtime),
  "AirplaySessionEndInfo 缺 current/positionSec/durationSec 字段",
);
check(
  "sessionRuntime hooks.onSessionEnded 传 info 对象(不再是裸 stderr 字符串)",
  /onSessionEnded\?:\s*\(deviceId:\s*string,\s*info:\s*AirplaySessionEndInfo\)\s*=>\s*void/.test(runtime),
  "hooks.onSessionEnded 签名未改为 (deviceId, info: AirplaySessionEndInfo)",
);
{
  const iStill = runtime.indexOf("const stillCurrent = this.sessions.get(active.deviceId) === active;");
  const iDel = runtime.indexOf("this.sessions.delete(active.deviceId)");
  check(
    "sessionRuntime finalizer:stillCurrent 判定先于 sessions.delete",
    iStill >= 0 && iDel > iStill,
    `stillCurrent@${iStill} delete@${iDel}`,
  );
  check(
    "sessionRuntime finalizer:事件带上 current: stillCurrent 与真实落点",
    count(runtime, "current: stillCurrent") === 1
      && /positionSec:\s*Math\.max\(0,\s*Number\(active\.player\.positionSec\)/.test(runtime),
    "sessionEnded 载荷缺 current/positionSec",
  );
}
check(
  "ipcProtocol:sessionEnded 事件类型挂上 AirplaySessionEndInfo",
  /export\s+type\s+AirplayChildEvent\s*=\s*\{\s*t:\s*"sessionEnded";\s*deviceId:\s*string\s*\}\s*&\s*AirplaySessionEndInfo/.test(ipc)
    && /AirplaySessionEndInfo/.test(ipc.split("export type AirplayChildEvent")[0]),
  "AirplayChildEvent 未交叉 AirplaySessionEndInfo(或未从 sessionRuntime 透出)",
);
check(
  "childMain:sessionEnded 载荷透传 current/positionSec/durationSec",
  /current:\s*info\.current/.test(childMain)
    && /positionSec:\s*info\.positionSec/.test(childMain)
    && /durationSec:\s*info\.durationSec/.test(childMain),
  "childMain 未透传 current/positionSec/durationSec",
);
check(
  "supervisor:事件原样交给主进程(hooks.onSessionEnded(ev.deviceId, ev))",
  /hooks\.onSessionEnded\?\.\(ev\.deviceId,\s*ev\)/.test(supervisor),
  "supervisor 仍只挑 loudnessStderr 传,current/落点会丢",
);
check(
  "supervisor:AirplayHostHooks.onSessionEnded 用 AirplaySessionEndInfo",
  /onSessionEnded\?:\s*\(deviceId:\s*string,\s*info\?:\s*AirplaySessionEndInfo\)\s*=>\s*void/.test(supervisor),
  "AirplayHostHooks.onSessionEnded 签名未改",
);

console.log("===== R7 pollState 契约与 DLNA 对齐:PLAYING 必须带 mediaUri(且不得删掉其余字段) =====");
const pollStart = proto.indexOf("async pollState()");
const pollEnd = proto.indexOf("},\n  };", pollStart) >= 0 ? proto.indexOf("},\n  };", pollStart) : pollStart + 900;
const pollBody = pollStart >= 0 ? proto.slice(pollStart, pollEnd) : "";
check("能定位到 protocolPlayer.pollState", pollBody.length > 0, "未找到 async pollState()");
check(
  "pollState 带 mediaUri: getAirPlayMediaUri(deviceId)",
  /mediaUri:\s*getAirPlayMediaUri\(deviceId\)/.test(pollBody),
  "pollState 未见 mediaUri: getAirPlayMediaUri(deviceId)",
);
// 反向断言:防止"只加 mediaUri,把 playbackState/position/duration 一起删了"这种
// 看着像完成、实则把状态查询做空的等价变异。
check(
  "**反向断言**:pollState 仍返回 playbackState / position / duration(不得为加 mediaUri 而删)",
  /playbackState:\s*s\.playbackState/.test(pollBody)
    && /position:\s*s\.position/.test(pollBody)
    && /duration:\s*s\.duration/.test(pollBody),
  "pollState 的 playbackState/position/duration 有缺失",
);
check(
  "control.ts 导出 getAirPlayMediaUri(pollState 与 playMedia 同源)",
  /export\s+function\s+getAirPlayMediaUri\s*\(/.test(ap)
    && /return\s+lastCast\.get\(deviceId\)\?\.streamUrl;/.test(ap),
  "control.ts 未导出 getAirPlayMediaUri 或未取 lastCast.streamUrl",
);

console.log("");
if (failures.length) {
  console.log(`✗ AirPlay 播放链路时序守卫失败 ${failures.length} 项:`);
  for (const f of failures) console.log("   - " + f);
  process.exit(1);
}
console.log("✓ AirPlay 播放链路时序守卫全部通过");
