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

console.log("===== R11 设备级串行闸:「流转 + 拖动」并发不得交错建 RTSP 会话 =====");
{
  // 2026-10-21 240 现网:客户端 transfer 与 seek 是**并发**的两条链(seek 不走 advancing),
  // 各自对同一台设备停/建会话 → 设备会话表错乱 → 后续握手挂住 → advancing 永久占用
  // (用户观感「一直卡在同一首,点别的歌没反应」)。
  check(
    "存在 withDeviceGate(per-device promise 链)",
    /function\s+withDeviceGate\s*</.test(ap),
    "未找到 withDeviceGate",
  );
  check(
    "闸必须可重入(AsyncLocalStorage 记录已持有的设备)",
    /new\s+AsyncLocalStorage/.test(ap) && /gateHeld\.getStore\(\)\?\.has\(deviceId\)/.test(ap),
    "闸未做重入判定(同一调用链里再调 stop 会自锁死)",
  );
  check(
    "**常量断言**:六个会话入口都走闸(cast/seek/stop/pause/resume/stopAirPlaySession)",
    count(ap, "withDeviceGate(") === 6,
    `withDeviceGate 调用 = ${count(ap, "withDeviceGate(")}(六入口各 1,应为 6;函数定义是 withDeviceGate<T>( 不计入)`,
  );
  check(
    "castToAirPlayDevice → withDeviceGate(opts.deviceId, ... castUnlocked)",
    /withDeviceGate\(opts\.deviceId,\s*\(\)\s*=>\s*castUnlocked\(opts\)\)/.test(ap),
    "castToAirPlayDevice 未包闸(或没走 castUnlocked)",
  );
  check(
    "seekAirPlay → withDeviceGate(deviceId, ... seekUnlocked)",
    /withDeviceGate\(deviceId,\s*\(\)\s*=>\s*seekUnlocked\(deviceId,\s*seconds\)\)/.test(ap),
    "seekAirPlay 未包闸(或没走 seekUnlocked)",
  );
  check(
    "**反向断言**:闸内实现(castUnlocked/seekUnlocked)不得再调公开入口(防自锁)",
    !/castUnlocked[\s\S]{0,2000}?await\s+castToAirPlayDevice\(/.test(ap)
      && !/seekUnlocked[\s\S]{0,3000}?await\s+seekAirPlay\(/.test(ap),
    "闸内又调了公开的 cast/seek(会二次排队自锁)",
  );
}

console.log("===== R12 SYNC 包 NTP 锚点:必须锚「推流墙钟」,不得把内容偏移(seek)当成未来时间 =====");
{
  // 2026-10-21 230 测试床实锤:seek 走完整重建后 startTs 被重锚到 baseTs+seekSec*rate,
  // 而 SYNC 仍用 ts2ntp(headTs) → 把 30s 处的内容标成「未来 30 秒才播」。shairport 日志:
  //   "Check packet from buffer … 31.08 seconds ahead" / "crazy time interval of -30.08 seconds"
  // 接收端一直等这个时间点 ⇒ **拖动进度后彻底无声**(HiVi 同症状)。
  const raop = stripComments(read("backend/src/services/airplay/raop.ts"));
  check(
    "RaopPlayer 持有 startNtp(内容起点对应的真实 NTP 时刻)",
    /private\s+startNtp\s*=\s*0n/.test(raop),
    "缺 startNtp 字段",
  );
  check(
    "RECORD 时记下 ntp0 → startNtp(基准会话)",
    /const\s+ntp0\s*=\s*ntpNow\(\)[\s\S]{0,400}?this\.startNtp\s*=\s*ntp0/.test(raop),
    "connect() 未把 RECORD 时刻记进 startNtp",
  );
  check(
    "stream() 起播时重锚 startNtp = ntpNow()(seek 重建也生效)",
    /this\.startNtp\s*=\s*ntpNow\(\)/.test(raop),
    "stream() 未在起播时重锚 startNtp",
  );
  check(
    "sendSync:ntp = startNtp + ts2ntp(headTs − startTs)",
    /this\.startNtp\s*\+\s*ts2ntp\(elapsedTs/.test(raop),
    "sendSync 未按「起点 NTP + 已播时长」换算",
  );
  check(
    "**反向断言**:sendSync 不得再用 ts2ntp(this.headTs)(含内容偏移)",
    !/sendSync[\s\S]{0,1200}?ts2ntp\(this\.headTs/.test(raop),
    "sendSync 仍直接换算 headTs → seek 后接收端会把音频当成未来时间",
  );
}

console.log("===== R13 seek 语义:默认完整重建 + seq 连续(禁止随机重置) =====");
{
  const raop = stripComments(read("backend/src/services/airplay/raop.ts"));
  check(
    "prepareSeek 不得随机重置 seq(接收端会判丢包/持续 NACK)",
    !/prepareSeek[\s\S]{0,1600}?this\.seq\s*=\s*\(Math\.random\(\)\s*\*\s*0xffff\)/.test(raop),
    "prepareSeek 里有 seq 随机重置",
  );
  check(
    "AirPlay 侧提供 setStartPosition(只重锚时间线,不发 FLUSH)",
    /setStartPosition\(seekSec:\s*number\)/.test(raop),
    "缺 setStartPosition",
  );
  check(
    "seek 默认走完整重建(AIRPLAY_SEEK_INPLACE=1 才保留原地实验路径)",
    /AIRPLAY_SEEK_INPLACE\s*!==\s*"1"/.test(ap),
    "control.ts 的 seek 默认分支不是重建",
  );
  check(
    "重建起播时按 seek 目标重锚 RTP 时间线",
    /setStartPosition\(seekSec\)/.test(ap),
    "startSession 未按 seekSec 调用 setStartPosition",
  );
}

console.log("===== R14 stop/reset 容错:离线设备也必须停得掉、清得掉 =====");
{
  const peers = stripComments(read("backend/src/routes/api/peers.ts"));
  check(
    "stop:cast 端统一走 best-effort(transport 抛错不回 500,但 stopPlayback 必落)",
    /if \(isCastPeer\(parsed\)\) \{[\s\S]{0,400}?getQueueController\(\)\.stopPlayback\(parsed\.id\);[\s\S]{0,700}?transportError[\s\S]{0,300}?success: true/.test(peers),
    "stop 分支仍是各 kind 各自 try/catch 500,离线设备会停不掉",
  );
  check(
    "reset:传输失败后仍执行 clear(不得在 catch 里 return 500 跳过 clear)",
    /reset[\s\S]{0,2600}?transportError[\s\S]{0,600}?getQueueController\(\)\.clear\(parsed\.id\)/.test(peers),
    "reset 在传输抛错时跳过了 clear → 离线端 isActive 队列常驻",
  );
  check(
    "**反向断言**:reset 不得再在 catch 里直接回 500 并跳过 clear",
    !/catch \(e: any\) \{\s*return c\.json\(apiInternalError\(e\), 500\);\s*\}\s*return c\.json\(\{ success: true \}\);\s*\}\s*\/\/ local:清队列元数据/.test(peers),
    "reset 仍有『抛错即 500 且不 clear』的旧分支",
  );
}

console.log("===== R15 AirPlay 状态词表归一(与 dlna/sendspin/local 对齐) =====");
{
  const peers = stripComments(read("backend/src/routes/api/peers.ts"));
  check(
    "status 出口把 PAUSED → PAUSED_PLAYBACK",
    /parsed\.kind === "airplay"[\s\S]{0,500}?st\.state === "PAUSED"[\s\S]{0,120}?PAUSED_PLAYBACK/.test(peers),
    "AirPlay 的 PAUSED 未归一,客户端 peer.dart 会当成未在播",
  );
  check(
    "status 出口把 IDLE → STOPPED",
    /parsed\.kind === "airplay"[\s\S]{0,700}?st\.state === "IDLE"[\s\S]{0,120}?STOPPED/.test(peers),
    "AirPlay 的 IDLE 未归一为 STOPPED",
  );
  check(
    "归一必须是拷贝(不得改写共享状态对象)",
    /\{\s*\.\.\.getAirPlayPeerStatus\(parsed\.id\)\s*\}/.test(peers),
    "直接改动了 getAirPlayPeerStatus 返回的共享对象",
  );
  check(
    "group 状态同样归一(PAUSED → PAUSED_PLAYBACK / IDLE → STOPPED)",
    /status\.state === "PAUSED"[\s\S]{0,160}?PAUSED_PLAYBACK/.test(peers)
      && /status\.state === "IDLE"[\s\S]{0,120}?STOPPED/.test(peers),
    "组状态未归一,客户端会把暂停显示成未播放",
  );
}

console.log("===== R16 mDNS 无 A 记录时不得把 `.local` 当可路由 host =====");
{
  const disc = stripComments(read("backend/src/services/airplay/discovery.ts"));
  check(
    "维护 hostname → IPv4 旁路表(同主机其它记录可回填)",
    /hostIps\s*=\s*new Map/.test(disc) && /hostIps\.set\(/.test(disc),
    "discovery 没有 hostIps 旁路表",
  );
  check(
    "无可路由地址时不登记(不能把解不了的 .local 存成 host)",
    /const addr = ip \|\| hostIps\.get\(hostKey\) \|\| \(isIp \? String\(svc\.host\) : ""\)/.test(disc)
      && /if \(!addr \|\| !svc\.port\) return;/.test(disc),
    "仍可能把裸 `.local` 主机名写成 dev.host",
  );
  check(
    "**反向断言**:不得再直接 `\|\| svc.host \|\|` 兜底",
    !/svc\.addresses\?\.find\([^\n]*\)\s*\|\|\s*svc\.host\s*\|\|/.test(disc),
    "discovery 仍有 `addresses || svc.host ||` 的旧兜底",
  );
}

console.log("===== R17 DLNA 状态一致性:陈旧 GENA 不得覆盖 SOAP =====");
{
  const peers = stripComments(read("backend/src/routes/api/peers.ts"));
  const dlna = stripComments(read("backend/src/services/dlna/control.ts"));
  check(
    "status 路由对 GENA state 有新鲜度闸(15s)",
    /const fresh = evtAt === null \|\| evtAt >= \(status\.updatedAt \?\? 0\) - 15_000;/.test(peers),
    "缺少 GENA 新鲜度闸,旧 STOPPED 会盖掉 SOAP PLAYING",
  );
  check(
    "castToDevice 成功后同步事件缓存 PLAYING",
    /setTransportState\(opts\.deviceId, "PLAYING"\)/.test(dlna),
    "castToDevice 未同步 PLAYING,缓存里会残留旧 STOPPED",
  );
}

console.log("");
if (failures.length) {
  console.log(`✗ AirPlay 播放链路时序守卫失败 ${failures.length} 项:`);
  for (const f of failures) console.log("   - " + f);
  process.exit(1);
}
console.log("✓ AirPlay 播放链路时序守卫全部通过");
