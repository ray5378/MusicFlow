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

console.log("===== R8 取流契约:解码器必须吃「本机回环的完整管道」,且不得静默重连 =====");
//
// 背景(2026-10-20 240 现网实测,用户可见症状「HiVi 播到一半从头开始 / 去下一首」):
//   · 旧实现用 resolvePipelineInput 把 airplay 出流地址包成 raw 直通
//     (`/rest/dlna/stream/:tok?raw=1`)⇒ 丢掉整曲内存缓冲与「上游死亡⇒显式错误」契约;
//   · raw 上游是 WebDAV 的 200 长连接(无 Range),中途断流时:
//       ① 干净 EOF ⇒ ffmpeg exit 0 ⇒ 会话在 54s/265s 处报 IDLE ⇒ idle_early 切歌;
//       ② 以错误收尾 ⇒ `-reconnect_streamed 1` 对无长度的 chunked 流**没有续接位置**,
//          重连请求恒为 `Range: bytes=0-` ⇒ 从 0 重读(实测 20s 内 19730 次)。
//   · 重连风暴期间 SIGTERM 不生效 ⇒ 每首歌遗留一个 18MB 僵尸解码器(实测累积 12 个)。
// 三条都必须钉死:任何一条被改回去,单测都不会自己变红。
const DECODER = "backend/src/services/airplay/decoder.ts";
const dec = stripComments(read(DECODER));
check(
  "control.ts 存在 toLoopbackAirPlayStreamUrl(出流地址→本机回环同路径)",
  /export\s+function\s+toLoopbackAirPlayStreamUrl\s*\(/.test(ap),
  "未找到 toLoopbackAirPlayStreamUrl 的定义",
);
check(
  "回环化只改 origin:路径必须仍是 /rest/airplay/stream/(不得误吞别的命名空间)",
  /pathname\.startsWith\("\/rest\/airplay\/stream\/"\)/.test(ap)
    && /return\s+`\$\{loopbackBase\(\)\}\$\{u\.pathname\}\$\{u\.search\}`/.test(ap),
  "回环化实现未按「同 path/token 只换 origin」写",
);
check(
  "in-proc 起播:spawnDecoder 首参是 feedUrl(回环管道),不是 raw 包装结果",
  /const\s+feedUrl\s*=\s*toLoopbackAirPlayStreamUrl\(streamUrl\)/.test(ap)
    && /spawnDecoder\(feedUrl,/.test(ap),
  "起播路径未见 spawnDecoder(feedUrl, ...)",
);
check(
  "原地 seek 重建解码器同样用 s.feedUrl(不得退回 streamUrl/raw)",
  /spawnDecoder\(s\.feedUrl,\s*t,/.test(ap),
  "seek 重建解码器未使用 s.feedUrl",
);
check(
  "**反向断言**:control.ts 不得再用 resolvePipelineInput 包装 AirPlay 出流地址",
  !/resolvePipelineInput\s*\(\s*\{\s*input:\s*(streamUrl|s\.streamUrl)\s*\}/.test(ap),
  "又出现了把 streamUrl 交给 resolvePipelineInput(raw 直通)的写法",
);
check(
  "fork 路径传给子进程的 streamUrl 也必须是回环管道",
  /const\s+compliantUrl\s*=\s*toLoopbackAirPlayStreamUrl\(streamUrl\)/.test(ap)
    && /streamUrl:\s*compliantUrl/.test(ap),
  "castViaChild 未把回环化后的地址传给子进程",
);
check(
  "解码器显式禁用 HTTP 重连(decodeArgs 传 reconnect: false)",
  /reconnect:\s*false/.test(dec),
  "spawnDecoder 的 decodeArgs 未见 reconnect: false",
);
check(
  "**反向断言**:decodeArgs 的重连是可选开关(缺省仍为 true,其它链路零变化)",
  /req\.reconnect\s*!==\s*false/.test(stripComments(read("backend/src/services/audio/pipeline.ts"))),
  "decodeArgs 未按 req.reconnect !== false 判定(可能把其它链路的重连一起关了)",
);

console.log("===== R9 解码器回收:必须 SIGKILL(SIGTERM 对卡在重连/阻塞写的 ffmpeg 无效) =====");
check(
  "decoder.ts 导出 killDecoder 且实现为 SIGKILL",
  /export\s+function\s+killDecoder\s*\(/.test(dec) && /kill\?\.\("SIGKILL"\)/.test(dec),
  "killDecoder 缺失或未使用 SIGKILL",
);
check(
  "**常量断言**:airplay 两个模块的 kill 调用一律走 killDecoder",
  !/[a-zA-Z.]+\??\.kill\(\)/.test(ap) && !/[a-zA-Z.]+\??\.kill\(\)/.test(runtime),
  "仍存在无参 .kill()(缺省 SIGTERM ⇒ 重连风暴中的解码器杀不掉)",
);
check(
  "control/sessionRuntime 都从 decoder 模块引入 killDecoder",
  /killDecoder\s*\}\s*from\s*"\.\/decoder\.js"/.test(ap)
    && /killDecoder\s*\}\s*from\s*"\.\/decoder\.js"/.test(runtime),
  "有模块未从 ./decoder.js 引入 killDecoder",
);

console.log("===== R10 上游超时只约束「建连+响应头」,不得挂到 body(否则长流每 15s 被掐断) =====");
{
  const raw = stripComments(read("backend/src/services/dlna/rawStreamCache.ts"));
  // 240 实测:rawStreamCache 把 AbortSignal.timeout(openTimeoutMs) 直接交给 fetch,
  // 该 signal 在 body 读取期间同样 abort ⇒ 上游长流精确每 15.000s 断一次
  // (buf-start → 出流结束 ms≈13372)。解码器表现为「播到一半停住 / 重连从头 / 提前 IDLE」。
  check(
    "存在 fetchHeadersWithTimeout(拿到响应头即解绑超时)",
    /async\s+function\s+fetchHeadersWithTimeout\s*\(/.test(raw),
    "未见 fetchHeadersWithTimeout",
  );
  check(
    "**反向断言**:不得再把 AbortSignal.timeout 直接交给 fetch 挂全程",
    !/fetchSignalWithTimeout\s*\(/.test(raw) && !/signal:\s*fetchSignalWithTimeout/.test(raw),
    "rawStreamCache 里仍存在 fetchSignalWithTimeout(超时会挂到 body 上)",
  );
  check(
    "解绑点:fetch resolve 后 clearTimeout(超时不得继续生效)",
    /finally\s*\{\s*clearTimeout\(timer\);/.test(raw),
    "fetchHeadersWithTimeout 的 finally 未见 clearTimeout(timer)",
  );
  check(
    "两个入口(openUpstream / passthrough)都走 fetchHeadersWithTimeout",
    count(raw, "fetchHeadersWithTimeout(") === 3,
    `调用点 = ${count(raw, "fetchHeadersWithTimeout(")}(定义 1 + 两入口各 1,应为 3)`,
  );
}

console.log("");
if (failures.length) {
  console.log(`✗ AirPlay 播放链路时序守卫失败 ${failures.length} 项:`);
  for (const f of failures) console.log("   - " + f);
  process.exit(1);
}
console.log("✓ AirPlay 播放链路时序守卫全部通过");
