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
  "in-proc 起播:spawnDecoder 首参是 feedUrl(回环管道 + 服务端 timeOffset),不是 raw 包装结果",
  /const\s+feedUrl\s*=\s*toLoopbackAirPlayStreamUrl\(withPlaybackOffset\(streamUrl, seekSec\)\)/.test(ap)
    && /spawnDecoder\(feedUrl, undefined/.test(ap),
  "起播路径未见 spawnDecoder(feedUrl, undefined, ...)",
);
check(
  "原地 seek 重建解码器同样用重编 timeOffset 的 s.feedUrl(不得退回 streamUrl/raw/-ss)",
  /s\.feedUrl\s*=\s*toLoopbackAirPlayStreamUrl\(withPlaybackOffset\(s\.streamUrl, t\)\)/.test(ap)
    && /spawnDecoder\(s\.feedUrl,\s*undefined,/.test(ap),
  "seek 重建解码器未使用 s.feedUrl 或又退回 -ss",
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

console.log("===== R18 流转接续:起播即落位 + 建会话硬预算(HiVi 真机 2026-10-21) =====");
{
  const qc = stripComments(read("backend/src/services/player/QueueController.ts"));
  const raop = stripComments(read("backend/src/services/airplay/raop.ts"));
  const peers = stripComments(read("backend/src/routes/api/peers.ts"));
  const uni = stripComments(read("backend/src/services/player/UniversalPlayer.ts"));
  check(
    "cast 超时的兜底回调不得 throw(定时器里抛错 = 未捕获异常 = 进程退出)",
    /\(\)\s*=>\s*null as \{ mediaUri: string \} \| null/.test(qc)
      && !/\(\)\s*=>\s*\{\s*throw new Error\("playMedia 超过/.test(qc),
    "withTimeout 兜底仍在 setTimeout 里抛错(HiVi 流转现场:整个后端崩,容器重启)",
  );
  check(
    "cast 超时后 best-effort 回收设备侧半开会话(player.stop)",
    /abortTimedOutCast/.test(qc) && /player\.stop\(\)\.catch/.test(qc),
    "超时后不回收,下一次 cast 会与幽灵会话并存",
  );
  check(
    "playFrom/playCurrent 透传起播落点 startPositionMs",
    /startPositionMs\?: number/.test(qc)
      && /playCurrent\(playerId, baseUrl, startPositionMs\)/.test(qc)
      && /player\.playMedia\(fullItem, baseUrl, castStartMs\)/.test(qc),
    "起播落点没有传进 cast",
  );
  check(
    "UniversalPlayer 透传 startMs(其余协议忽略即为零变化)",
    /playMedia\(item: QueueItem, baseUrl: string, startMs\?: number\)/.test(uni)
      && /this\.protocol\.playMedia\(item, baseUrl, startMs\)/.test(uni),
    "UniversalPlayer 把落点参数吞掉了",
  );
  check(
    "AirPlay 起播即落位:seekSec 由 startMs 派生",
    /const seekSec = startMs > 0 \? startMs \/ 1000 : undefined;/.test(proto)
      && /\.\.\.\(seekSec !== undefined \? \{ seekSec \} : \{\}\)/.test(proto),
    "protocolPlayer 未把落点交给 cast",
  );
  check(
    "transfer 到 AirPlay:把源进度交给本次 cast",
    /const inCastPos = !borrow\.armed[\s\S]{0,260}?parsedTo\.kind === "airplay"/.test(peers)
      && /Math\.round\(inCastPos \* 1000\)/.test(peers),
    "transfer 仍走「先起播、再 seek」",
  );
  check(
    "transfer 到 AirPlay 不再补 seek(避免第二次建会话)",
    /else if \(inCastPos !== null && inCastPos > 0\)/.test(peers),
    "起播落位后仍会再 seek 一次",
  );
  check(
    "RAOP 握手有总预算,单步等待按剩余预算收缩",
    /HANDSHAKE_BUDGET_MS = 8_000/.test(raop)
      && /export function rtspTimeoutFor/.test(raop)
      && /rtspTimeoutFor\(\s*method/.test(raop),
    "握手仍是三步各 10s(合计会撞 30s cast 硬顶)",
  );
  check(
    "清理类 RTSP(TEARDOWN/FLUSH)用短超时",
    /RTSP_CLEANUP_TIMEOUT_MS = 2_500/.test(raop)
      && /method === "TEARDOWN" \|\| method === "FLUSH"/.test(raop),
    "TEARDOWN 仍可能阻塞 10s",
  );
  check(
    "connect 有总预算(bindUdp/TCP/握手任一步卡死都必须失败返回)",
    /RAOP connect 总超时/.test(raop) && /Promise\.race\(\[this\.doConnect\(\), timeout\]\)/.test(raop),
    "connect 没有总预算,卡在 bindUdp 会永久占住设备闸",
  );
  check(
    "互斥 DLNA 与旧会话收尾有硬上限(不得拖死 cast)",
    /DLNA_YIELD_DEADLINE_MS = 6_000/.test(ap)
      && /STOP_SESSION_DEADLINE_MS = 4_000/.test(ap)
      && /withDeadline\(stopDevicePlayback/.test(ap)
      && /withDeadline\(stopSession/.test(ap),
    "清理步骤没有硬上限,慢设备会把 cast 拖到 30s",
  );
}

console.log("===== R19 插件默认开启 + 启停零残留(2026-10-21 用户拍板) =====");
{
  const plugin = stripComments(read("backend/src/services/plugin/renderers/airplay.ts"));
  check(
    "AirPlay renderer manifest 的 defaultEnabled 必须为 true",
    /defaultEnabled:\s*true/.test(plugin) && !/defaultEnabled:\s*false/.test(plugin),
    "插件仍默认关闭:新装实例开箱看不到 AirPlay 设备",
  );
  check(
    "插件文案不得再声称「默认关闭 / Disabled by default」",
    !/默认关闭/.test(plugin) && !/Disabled by default/.test(plugin),
    "文案与 manifest 不一致,用户会按旧文案以为要手动开启",
  );
  check(
    "插件停用必须回收 AirPlay 设备/会话/discovery(零残留)",
    /unregisterAirPlayDevices\(\)/.test(ap) && /stopAirPlayDiscovery\(\)/.test(ap),
    "停用插件后仍残留设备注册或 mDNS 监听",
  );
  // 「默认开启」只改初始值,绝不能变成「不可关闭」:插件页的手动开关必须继续存在,
  // 且 PUT /v1/plugins/:id/toggle 仍要联动 start/stopAirPlayService。
  const pluginsRoute = stripComments(read("backend/src/routes/api/plugins.ts"));
  check(
    "插件开关仍联动 AirPlay 服务(默认开启 ≠ 不可手动关闭)",
    /airplay-renderer/.test(pluginsRoute)
      && /startAirPlayService\(\)/.test(pluginsRoute)
      && /stopAirPlayService\(\)/.test(pluginsRoute),
    "toggle 路由丢失了 AirPlay 启停联动:默认开启后将无法真正关闭",
  );
  check(
    "存在「关 → 停在播会话 / 开 → 起监听」的回归用例",
    /airplay-renderer:关 → 停在播会话;开 → 起监听/.test(
      read("backend/tests/routes/lt2_pluginsRouteBranches.test.ts"),
    ),
    "插件开关的回归用例被删,手动关闭能力失去测试保护",
  );
}

console.log("===== R20 RTSP 请求行:必须带 `RTSP/1.0` 版本段(缺了标准接收端直接 400) =====");
{
  const raop = stripComments(read("backend/src/services/airplay/raop.ts"));
  // 两处请求行:sendRtsp(常规请求) 与 sendRtspNoWait(音量等 fire-and-forget)。
  // 任何一处漏版本段,都会在 shairport-sync 这类合规接收端上表现为 400 Bad Request,
  // 而 LinkPlay 接收端较宽松 —— 只在部分设备上复现,极难定位。
  check(
    "两处 RTSP 请求行都带 RTSP/1.0",
    (raop.match(/RTSP\/1\.0\\r\\n/g) || []).length >= 2,
    "有请求行缺版本段(shairport-sync 会回 400)",
  );
}

console.log("===== R21 音量链路:0-100 → dB 映射、同 host DLNA 转发、静音独立 =====");
{
  const dec = stripComments(read("backend/src/services/airplay/decoder.ts"));
  check(
    "音量映射端点正确:0 → -144(静音),100 → 0dB",
    /if \(v <= 0\) return -144;/.test(dec)
      && /return -30 \+ \(v \/ 100\) \* 30;/.test(dec),
    "dB 映射端点被改动,会出现「0% 仍出声」或「100% 不是满音量」",
  );
  check(
    "LinkPlay(HiVi/MUZO 等)音量必须转发同 host 的 DLNA RenderingControl",
    /forwarded to DLNA device/.test(ap) && /setDeviceVolume\(dlnaPeer/.test(ap),
    "只发 RAOP SET_PARAMETER:LinkPlay 接收端忽略该指令,音量条不动",
  );
  check(
    "静音与音量相互独立(取消静音恢复原音量,不把 volume 归零)",
    /setAirPlayMuted/.test(ap) && /st\.muted = muted/.test(ap) && /st\.volume/.test(ap),
    "静音实现成了「音量置 0」,取消静音后会丢原音量",
  );
  // 重启后「强制音量」的根因是 volumeState 只在内存、读取点回落到写死缺省。
  // 正确做法:设置即落库;读取时用持久值播种(无行才用 DEFAULT_AIRPLAY_VOLUME)。
  check(
    "AirPlay 音量/静音必须落库(设置即持久,重启可恢复)",
    /saveAirPlayVolumeState\(deviceId, \{ volume: vol \}\)/.test(ap)
      && /saveAirPlayVolumeState\(deviceId, \{ muted \}\)/.test(ap),
    "音量仍只在内存:容器重启后丢设置,客户端重连会用缺省值覆盖设备音量",
  );
  check(
    "状态读取必须用持久值播种(不得写死缺省值)",
    /function volumeStateOf/.test(ap)
      && /getAirPlayVolumeState\(deviceId\)/.test(ap)
      && /const vol = volumeStateOf\(deviceId/.test(ap),
    "getAirPlayStatus 仍直接回 80:重启后客户端会把这个缺省值当权威回推",
  );
}

console.log("===== R22 取流会话:独立 token 命名空间 + 同 (song,device) 复用 =====");
{
  const sess = stripComments(read("backend/src/services/airplay/session.ts"));
  check(
    "AirPlay 走自己的 /rest/airplay/stream/ 路由",
    /\/rest\/airplay\/stream\//.test(sess) && !/\/rest\/dlna\/stream\//.test(sess),
    "又复用了 DLNA 取流路由:DLNA 兼容头会串到 AirPlay 解码器",
  );
  check(
    "同 (songId, deviceId) 未过期时复用 token(否则 uri 变会误判换歌)",
    /SELECT token FROM airplay_stream_tokens WHERE song_id = \? AND device_id = \?/.test(sess)
      && /UPDATE airplay_stream_tokens SET exp = \?/.test(sess),
    "每次 cast 都 mint 新 token → PlaybackTracker 把 seek 当成换歌并自动 advance",
  );
}

console.log("===== R23 起播/重启恢复:不得绕开统一起播路径;设备闸排队可观测 =====");
{
  const qc = stripComments(read("backend/src/services/player/QueueController.ts"));
  check(
    "resumeActive 仍走 playCurrent(重启恢复不得绕过统一起播路径)",
    /async resumeActive\(deviceId: string, baseUrl: string\)[\s\S]{0,400}playCurrent\(\s*deviceId,\s*baseUrl/.test(qc),
    "重启恢复另开了一条起播路径,落点/串行闸都会绕过去",
  );
  // 闸被某个挂死的操作占住时,后续 cast 会**静默排队**到超时;排队日志是唯一
  // 能在现场一眼看出「是谁占着闸」的线索,删掉它就回到盲调状态。
  check(
    "设备闸排队必须可观测(排队耗时日志)",
    /\[AirPlay\]\[gate\] \$\{deviceId\} 排队 \$\{waited\}ms 后开始/.test(ap),
    "缺排队日志:闸被谁占住无法定位",
  );
}

console.log("===== R24 音量/静音写入口径统一 + 永久观测日志 =====");
{
  const peers = stripComments(read("backend/src/routes/api/peers.ts"));
  // 2026-10-21 复盘:曾用「启动 120s 内按 HA UA 忽略第一笔音量」兜底,被用户否决 ——
  // 静默丢弃合法请求不合理(用户在重启后任何时刻调音量都必须生效),UA 匹配也脆弱。
  // 现在只保留:①写入口径统一(一次解析 body,禁止各 kind 分支各读一次);
  // ②永久观测日志(来源 UA / peer / 值),用于定位"谁在改音量"。
  check(
    "音量写入有永久观测日志(来源 UA / peer / 值)",
    /\[peer-volume\] \$\{peerId\} <- \$\{volume\} ua=/.test(peers),
    "缺写入口径日志,出现静默覆盖时无法定位来源",
  );
  check(
    "静音写入有永久观测日志",
    /\[peer-mute\] \$\{peerId\} <- \$\{muted\} ua=/.test(peers),
    "静音写入口缺日志",
  );
  check(
    "不得按来源/启动窗口丢弃音量或静音请求(用户否决的兜底做法)",
    !/shouldIgnoreBootVolumeEcho/.test(peers) && !/bootVolumeGuard/.test(peers),
    "又出现了「启动期吞第一笔音量」的过滤逻辑",
  );
  check(
    "音量 body 只在写入口解析一次(五个 kind 分支不得各自解析)",
    (peers.match(/const body = await c\.req\.json\(\)\.catch/g) || []).length >= 1
      && !/kind === "dlna"\) \{\n    const \{ volume \} = await c\.req\.json/.test(peers),
    "分支内又各自解析 body:全局策略/日志会再次漏改",
  );
}
console.log("===== R25 同设备双协议流转(AirPlay <-> DLNA):落点/互斥/资源回收 =====");
{
  const peersG = stripComments(read("backend/src/routes/api/peers.ts"));
  const dlnaG = stripComments(read("backend/src/services/dlna/control.ts"));
  const sharedG = stripComments(read("backend/src/routes/api/shared.ts"));
  const restG = stripComments(read("backend/src/routes/rest/index.ts"));
  check(
    "流转识别同设备双身份(AirPlay host == DLNA location host)",
    /isSamePhysicalDevice/.test(peersG) && /listAirPlayDevices\(\)/.test(peersG) && /new URL\(dl\.location\)/.test(peersG),
    "同设备流转会被当成两台设备:起播互斥停掉源端后读不到进度",
  );
  check(
    "流转起点在任何起播/互斥动作之前定格(srcPosEarly 无条件早读,exp3)",
    /const srcPosEarly = askPosition \?\? await readPeerPositionSeconds\(fromPeerId\);/.test(peersG)
      && /const inCastPos = !borrow\.armed[\s\S]{0,300}sameDevice \? srcPosEarly : null/.test(peersG)
      && /const pos = late !== null && late > 0 \? late : srcPosEarly;/.test(peersG),
    "落点在源端被互斥停掉之后才读:会恒为 0(真机=流转后从头播);或 DLNA 跨设备红线例外被破坏(早读值漏进 startMs)",
  );
  check(
    "自动摘组回流记录与回加(exp3):detachFromActiveGroups 记 autoDetachedFromGroup;transfer-to-group 回加成员",
    /export const autoDetachedFromGroup = new Map</.test(sharedG)
      && /autoDetachedFromGroup\.set\(bare, \{ gid, memberKey, at: Date\.now\(\) \}\);/.test(sharedG)
      && /autoDetachedFromGroup\.get\(srcBare\)/.test(peersG)
      && /applyMemberDelta\(parsedTo\.id, \{ add: \[rec\.memberKey\] \}\)/.test(peersG),
    "回流链缺失:群组→设备流转后设备被永久摘出组,再流转回组即无声(case 3)",
  );
  check(
    "DLNA playMedia 把 startMs 编进 timeOffset(起播即落位)",
    /async playMedia\(item: QueueItem, baseUrl: string, startMs = 0\)/.test(dlnaG)
      && /timeOffset: startSec/.test(dlnaG),
    "DLNA 忽略 startMs:流转/续播只能从 0 秒拉流",
  );
  check(
    "DLNA 起播基线带上 timeOffset(进度不归零)",
    /const startOffsetSec = Math\.max\(0, Math\.round\(Number\(opts\.timeOffset\)/.test(dlnaG)
      && /pos: startOffsetSec/.test(dlnaG),
    "带进度投流后进度条从 0 重新爬",
  );
  check(
    "DLNA 起播前先冻结同 host AirPlay 队列,再停会话(防 IDLE->advance 反杀)",
    /getQueueController\(\)\.stopPlayback\(`airplay:\$\{d\.id\}`\)[\s\S]{0,900}?await stopAirPlaySession\(d\.id\)/.test(ap),
    "只停会话不冻队列:AirPlay 端会把 IDLE 判成自然结束并重新 cast,把 DLNA 反杀(真机=主卧 0 秒不出声)",
  );
  check(
    "flow 会话把下游取消接到 session.abort()(释放解码器槽)",
    /killOnCancel\(NodeReadable\.toWeb\(session\.stream as any\), \(\) => session\.abort\(\)\)/.test(restG),
    "设备切歌后旧 flow 会话继续占转码槽:出流首字节越来越慢,DLNA 反复卡死",
  );
  check(
    "同一设备的新 flow 会话接管旧会话(防旧连接迟迟不关)",
    /const activeFlowAborts = new Map<string, \(\) => void>\(\)/.test(restG)
      && /activeFlowAborts\.get\(opts\.deviceId\)/.test(restG),
    "缺每设备单会话约束:旧会话残留时新会话只能排队",
  );
}
console.log("===== R26 慢源熔断:DLNA 25s 窗口 + 跨曲连跳上限 =====");
{
  const pcG = stripComments(read("backend/src/services/player/PlayerController.ts"));
  const qcG = stripComments(read("backend/src/services/player/QueueController.ts"));
  check(
    "DLNA 阶段2 窗口 25s(其余 5s)",
    /const PLAY_TIMEOUT_MS = 5000;/.test(pcG)
      && /const DLNA_PLAY_TIMEOUT_MS = 25_000;/.test(pcG)
      && /playerId\.startsWith\("dlna:"\) \? DLNA_PLAY_TIMEOUT_MS : PLAY_TIMEOUT_MS/.test(pcG),
    "DLNA 沿用 5s:慢速网络源每次起播都判 stalled,整队被推着走",
  );
  check(
    "跨曲连续卡死熔断(3 首即停队列)",
    /const STALL_SKIP_LIMIT = 3;/.test(qcG)
      && /this\.stallSkipStreak\.set\(id, streak\)/.test(qcG)
      && /streak >= STALL_SKIP_LIMIT/.test(qcG)
      && /q\.isActive = false;[\s\S]{0,220}q\.ended = true;/.test(qcG),
    "无跨曲熔断:整段不可播时会把整圈走完并拖死事件循环",
  );
}
console.log("===== R27 flow 起播不得被整队预解析阻塞 + 大文件直通 + 负缓存失效 =====");
{
  const restG = stripComments(read("backend/src/routes/rest/index.ts"));
  const flowG = stripComments(read("backend/src/services/audio/flow.ts"));
  const prefG = stripComments(read("backend/src/services/source/prefetchCache.ts"));
  // 240 现场(2026-10-21):DLNA 拉 /rest/dlna/stream 后 12s 收不到任何响应头,
  // 根因是 serveFlowQueue 起播前 for 循环解析整条队列(上限 200 首)。
  check(
    "flow 只同步解析首曲,其余候选懒解析(禁止起播前整队解析)",
    /candidates\.map\([\s\S]{0,400}resolve: resolveFlowItem\(cand\)/.test(restG)
      && /const first = items\[0\] \? await items\[0\]\.resolve!\(\)/.test(restG)
      && !/for \(const cand of candidates\) \{\s*const row = db\.select\(\)\.from\(songs\)/.test(restG),
    "又在起播前逐首解析整条队列:首字节被推迟 10~400s,设备 25s 超时后反复重投",
  );
  check(
    "flow 会话在上一首播放期间预解析下一首",
    /void resolveItem\(index \+ 1\)/.test(flowG) && /const resolveItem = \(index: number\)/.test(flowG),
    "下一首在曲尾才开始解析:过渡点停顿甚至断流",
  );
  check(
    "flow 起播预热前 3 首(并行、不阻塞首字节)",
    /for \(let i = 1; i < Math\.min\(items\.length, 3\); i\+\+\) void resolveItem\(i\)/.test(flowG),
    "设备倍速预读时第 2 首 1~2s 就到:只靠曲内解析来不及,接缝会干等探测",
  );
  check(
    "flow 连续流实时节流(队列下标不跑到实际播放前面)",
    /export const FLOW_REALTIME_LEAD_SEC = 5;/.test(flowG)
      && /flowRealtimeLeadMs\(\)/.test(flowG)
      && /await paceSleep\(dueMs\)/.test(flowG),
    "编码器以远超实时速度推进:DLNA 贪婪读 → 27s 就推完 236s 的第一首,界面一直跳下一首",
  );
  check(
    "flow 解析失败跳过时先把上一曲 carry 吐出去",
    /if \(!item\) \{[\s\S]{0,240}await emitTail\(carry\)/.test(flowG),
    "跳过不可用曲目时丢掉上一曲尾部一个过渡窗口(静默少一段音频)",
  );
  const dlnaG = stripComments(read("backend/src/services/plugin/renderers/dlna.ts"));
  check(
    "大文件直通默认关闭:只有 DLNA 插件开关 + DLNA 链路同时满足才生效",
    /export const STREAM_BUFFER_SKIP_OVER_MB = 20;/.test(restG)
      && /streamBufferSkipOverBytes\(pluginEnabled: boolean = false\)/.test(restG)
      && /getPluginConfig\(DLNA_RENDERER_ID\)\?\.largeFileDirect === true/.test(restG)
      && /largeFileDirect: ctx\.kind === "dlna"/.test(restG)
      && /prog\.sizeBytes > skipOverBytes/.test(restG),
    "大文件直通又变成默认/全通道生效:完整音源(判官前提)会被跳过",
  );
  check(
    "DLNA 插件详情弹窗提供「大文件直通」开关(默认 false)",
    /key: "largeFileDirect"[\s\S]{0,160}type: "switch"[\s\S]{0,160}default: false/.test(dlnaG),
    "用户没有手动开启大文件直通的入口,或默认被打开",
  );
  check(
    "播放路径复用预取判官:preview/not-audio 判死+负缓存,too-small 只回退直通",
    /prefetchIntegrityConfig\(\)\.enabled/.test(restG)
      && /judgePrefetchedBuffer\(r\.buf, expectedSec/.test(restG)
      && /verdict\.reason === "too-small"[\s\S]{0,220}return undefined/.test(restG)
      && /markUnplayable\(songId\)/.test(restG)
      && /⇒ 记无源负缓存 \+ 显式失败/.test(restG),
    "播放路径没有判官,或把 too-small 当硬死(会导致误跳歌)",
  );
  check(
    "预取 too-small 不立即判死:先换源、再重试一次,且不写负缓存",
    /const tooSmallRetry: any\[\] = \[\]/.test(prefG)
      && /verdict\.reason === "too-small"[\s\S]{0,300}return "toosmall"/.test(prefG)
      && /for \(const cand of tooSmallRetry\)/.test(prefG)
      && /重试仍 too-small ⇒ 不记负缓存/.test(prefG),
    "too-small 直接写 5 分钟负缓存:一次上游截断就让队列把整首歌判跳",
  );
  check(
    "整曲字节完整拿到后失效该曲负缓存(预取 + 播放两条链路)",
    /evictStreamFallbackCache\(cand\.id\)/.test(prefG)
      && /if \(songId !== cand\.id\) evictStreamFallbackCache\(songId\)/.test(prefG)
      && /evictStreamFallbackCache\(songId\)/.test(restG),
    "成功可播后仍留着旧负缓存:队列继续判跳",
  );
}
console.log("===== R28 AirPlay 流转/seek 落位:偏移走服务端回环流,不在 live FLAC 上 -ss =====");
{
  const apG = stripComments(read("backend/src/services/airplay/control.ts"));
  const restG = stripComments(read("backend/src/routes/rest/index.ts"));
  check(
    "起播偏移编进 feed URL(timeOffset),解码器不再对 live FLAC 做 -ss",
    /export function withPlaybackOffset\(streamUrl: string, seekSec\?: number\)/.test(apG)
      && /withPlaybackOffset\(streamUrl, seekSec\)/.test(apG)
      && /spawnDecoder\(feedUrl, undefined/.test(apG),
    "解码器在不可寻址的 FLAC 管线上 -ss:帧中间起读 ⇒ invalid sync code / 0 字节 ⇒ 有进度没声音",
  );
  check(
    "原地 seek 同样重编 feedUrl 且不做 -ss",
    /withPlaybackOffset\(s\.streamUrl, t\)/.test(apG) && /spawnDecoder\(s\.feedUrl, undefined/.test(apG),
    "原地 seek 仍在 live 流上 -ss:拖动进度后无声/杂音",
  );
  check(
    "AirPlay + web 源 seek 先整曲缓冲(服务端 -ss 落在可定位的 membuf)",
    /airplaySeekNeedsBuffer/.test(restG)
      && /ctx\.kind === "airplay" && timeOffset > 0 && \(resolvedSong\.type \|\| "local"\) === "web"/.test(restG)
      && /buffering: timeOffset === 0 \|\| airplaySeekNeedsBuffer/.test(restG),
    "web 直链不支持 Range:服务端 -ss 直接失败(timeOffset=60 返回 Invalid data / 0 字节)",
  );
  check(
    "同设备 DLNA→AirPlay:等 DLNA 报 STOPPED + 宽限后再建 AirPlay 会话",
    /DLNA_SETTLE_MAX_MS = 2_500/.test(apG)
      && /getTransportState\(dlnaPeer\)/.test(apG)
      && /DLNA_SETTLE_GRACE_MS/.test(apG)
      && /wasActive/.test(apG),
    "DLNA Stop 返回立刻就建 AirPlay 会话:设备还在切输入 ⇒ RTP 在发、设备不响",
  );
  check(
    "DLNA 侧提供轻量 GetTransportInfo 状态读取(不得用 full status 轮询)",
    /export async function getTransportState\(deviceId: string\)/.test(
      stripComments(read("backend/src/services/dlna/control.ts")),
    ),
    "缺少轻量状态读取,互斥等待无法判断设备是否真的停稳",
  );
}
console.log("===== R29 DLNA Stop 不得误杀同 host AirPlay 输出(流转后 reset 源端) =====");
{
  const apG = stripComments(read("backend/src/services/airplay/control.ts"));
  const dlG = stripComments(read("backend/src/services/dlna/control.ts"));
  check(
    "AirPlay 侧提供 hasActiveAirPlaySessionForHost(同 host 活跃会话判定)",
    /export function hasActiveAirPlaySessionForHost\(host: string\): boolean/.test(apG)
      && /hasActiveSession\(d\.id\)/.test(apG),
    "缺少反向互斥判定:DLNA 侧无法知道同 host 的 AirPlay 是否在播",
  );
  check(
    "DLNA stopDevice 在 AirPlay 会话活跃时跳过硬停(只做本地收尾)",
    /hasActiveAirPlaySessionForHost\(host\)/.test(dlG)
      && /跳过设备 Stop\(防误杀 AirPlay 输出\)/.test(dlG),
    "客户端流转后 reset 源端 DLNA 会连带停掉 HiVi 的 AirPlay 输出 ⇒ 有进度无声",
  );
  check(
    "**常量断言**:stopDevice 的硬停分支必须在守卫之后(不得先发 Stop 再判)",
    (() => {
      const iFn = dlG.indexOf("export async function stopDevice(");
      const iGuard = dlG.indexOf("hasActiveAirPlaySessionForHost(host)", iFn);
      const iSoap = dlG.indexOf('soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop"', iFn);
      return iFn >= 0 && iGuard > iFn && iSoap > iGuard;
    })(),
    "守卫与 Stop 的下发顺序倒置:先发 Stop 再判等于没守",
  );
  check(
    "守卫 host 取 avTransportUrl(不得用可能缺失的 location → 空串静默失效)",
    /const host = new URL\(device\.avTransportUrl\)\.hostname;/.test(dlG),
    "host 解析用 location:持久化/缓存记录缺 location 时守卫恒 false,真机复现无声",
  );
  check(
    "**常量断言**:SOAP Stop 调用点恰为 4 处(castToDevice/playUriOnDevice/stopDevicePlayback/stopDevice)",
    dlG.split('soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop"').length - 1 === 4,
    `实际 = ${dlG.split('soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop"').length - 1}(应为 4;多出的直调会绕过 stopDevice 的同 host AirPlay 守卫)`,
  );
  check(
    "互斥让位 stopDevicePlayback 保持无守卫(AirPlay 起播前必须仍能硬停 DLNA)",
    (() => {
      const iPb = dlG.indexOf("export async function stopDevicePlayback(");
      const iSt = dlG.indexOf("export async function stopDevice(");
      const body = iPb >= 0 && iSt > iPb ? dlG.slice(iPb, iSt) : "";
      return body.length > 0
        && !/hasActiveAirPlaySessionForHost/.test(body)
        && body.includes('soapCall(device.avTransportUrl, AV_TRANSPORT, "Stop"');
    })(),
    "互斥让位被反向守卫挡住:DLNA 不停 ⇒ AirPlay 起播后设备仍占着 DLNA 输入",
  );
}
console.log("===== R30 AirPlay 独立子进程(与 sendspin 对齐):默认 fork + RPC 不得被收尾挂死 =====");
{
  const modeG = stripComments(read("backend/src/services/airplay/mode.ts"));
  const raopG = stripComments(read("backend/src/services/airplay/raop.ts"));
  const rtG = stripComments(read("backend/src/services/airplay/sessionRuntime.ts"));
  check(
    "AirPlay 默认 fork(defaultFork: true),与 sendspin 同为独立子进程",
    /defaultFork:\s*true/.test(modeG),
    "默认仍是 in-proc:主进程事件循环被前端/批量任务占住时 7.98ms RTP 节拍被打散",
  );
  check(
    "RTSP 等待响应期间连接关闭必须 reject(不得只 clearTimeout)",
    /const onClose = \(\) => bad\(new Error\(`RTSP \$\{method\} failed: socket closed`\)\)/.test(raopG)
      && /sock\.once\("close", onClose\)/.test(raopG),
    "close 只清定时器:Promise 永不 settle ⇒ 子进程 cast/stop RPC 永久挂起(25s 超时)",
  );
  check(
    "RaopPlayer 提供 forceClose(收尾超时的传输层强制释放)",
    /forceClose\(\): void \{/.test(raopG),
    "缺少强制关闭出口,收尾卡住时只能干等",
  );
  check(
    "子进程会话收尾有硬上限(STOP_DEADLINE_MS + stopPlayerBounded)",
    /const STOP_DEADLINE_MS = 4_000/.test(rtG)
      && /private async stopPlayerBounded\(/.test(rtG)
      && /s\.player\.forceClose\(\)/.test(rtG),
    "子进程 await player.stop() 无上限:设备不答 TEARDOWN 时 cast RPC 永不回包",
  );
  check(
    "子进程 cast/seek 的偏移编进服务端流且解码器不做 -ss(与 in-proc 同口径)",
    /spawnDecoder\(withOffset\(a\.streamUrl, a\.seekSec\), undefined/.test(rtG)
      && /spawnDecoder\(withOffset\(s\.streamUrl, t\), undefined/.test(rtG),
    "fork 路径对 live FLAC 做 -ss:残帧 ⇒ 有进度无声",
  );
  check(
    "推流追赶时必须让出事件循环(每 16 包 setImmediate)",
    /if \(\+\+burst >= 16\)/.test(raopG) && /setImmediate\(r\)/.test(raopG),
    "微任务连续发包会饿死子进程 IPC/RTSP 响应处理",
  );
}
console.log("");
console.log("===== exp4:桥 RECORD→首包 solo 语义对齐实验开关(缺省关闭) =====");
{
  const raopG = stripComments(read("backend/src/services/airplay/raop.ts"));
  const bsG = stripComments(read("backend/src/services/airplay/bridgeSession.ts"));
  check(
    "exp4:MF_BRIDGE_RAOP_SUPPRESS_INITIAL_VOLUME 缺省关闭且 pushInitialVolume 尊重之",
    /MF_BRIDGE_RAOP_SUPPRESS_INITIAL_VOLUME/.test(bsG)
      && /if \(raopSuppressInitialVolume\(\)\)/.test(bsG)
      && /v === "1" \|\| v === "true"/.test(bsG),
    "桥初始音量抑制开关缺失或语义被改",
  );
  check(
    "exp4:同 host DLNA 豁免开关(MF_BRIDGE_RAOP_SKIP_VOLUME_WITH_DLNA_PEER,solo 对齐)",
    /MF_BRIDGE_RAOP_SKIP_VOLUME_WITH_DLNA_PEER/.test(bsG)
      && /raopSkipVolumeWithDlnaPeer\(\) && sameHostDlnaPeer/.test(bsG)
      && /shouldSkipBridgeInitialVolume\(sameHostDlnaPeer\?: string\)/.test(bsG),
    "桥对 Linkplay 的 SET_PARAMETER 豁免实验开关缺失",
  );
  check(
    "exp4:豁免判据必须来自主进程载荷(桥侧禁止自查注册表——子进程两表恒空)",
    !/bridgeDlnaPeerOfAirPlay/.test(bsG)
      && /sameHostDlnaPeer: dlnaPeer,/.test(stripComments(read("backend/src/services/airplay/control.ts")))
      && /sameHostDlnaPeer\?: string;/.test(stripComments(read("backend/src/services/airplay/ipcProtocol.ts")))
      && /sameHostDlnaPeer,/.test(stripComments(read("backend/src/services/airplay/childMain.ts"))),
    "同 host DLNA 判据回到了子进程自查(E1 空转根因),或载荷链路断裂",
  );
  check(
    "exp4(E3):桥 settle 标记只在 settle 成功后写 + reset/stop 消费(开关缺省关)",
    /MF_BRIDGE_RAOP_SUPPRESS_DLNA_RESET_AFTER_BRIDGE/.test(stripComments(read("backend/src/services/airplay/bridgeSettleMarks.ts")))
      && /yieldSiblingDlnaForAirPlay\(deviceId\);[\s\S]{0,300}markBridgeSettledDlnaPeer\(peer, deviceId\)/.test(stripComments(read("backend/src/services/airplay/control.ts")))
      && /isRecentlyBridgeSettledDlnaPeer\(parsed\.id\)/.test(stripComments(read("backend/src/routes/api/peers.ts"))),
    "E3 标记写入点必须晚于 settle(提前写会跳过 settle 自己的 Stop),或 reset/stop 消费点缺失",
  );
  check(
    "exp4:首 SYNC now 语义开关在 streamBridge 首包路径(MF_BRIDGE_RAOP_FIRST_SYNC_NOW)",
    /MF_BRIDGE_RAOP_FIRST_SYNC_NOW/.test(raopG)
      && /raopBridgeFirstSyncNowEnabled\(\)\) \{[\s\S]{0,80}this\.startNtp = ntpNow\(\)/.test(raopG),
    "首 SYNC now 语义开关缺失",
  );
  check(
    "exp4:RECORD 后静音灌注 prime(MF_BRIDGE_RAOP_CONNECT_PRIME,真·首包保留 marker)",
    /MF_BRIDGE_RAOP_CONNECT_PRIME/.test(raopG)
      && /primeSilence\(count: number, session\?: RaopSession\)/.test(raopG)
      && /this\.started = false/.test(raopG)
      && /raopBridgeConnectPrimeEnabled\(\)/.test(bsG),
    "prime 静音灌注缺失或未复位 marker",
  );
  check(
    "exp4:prime 必须在 connect 之后且带 session(端口 0 会整段被吞,240 实证)",
    /session = await player\.connect\(\);[\s\S]{0,700}primeSilence\(RAOP_CONNECT_PRIME_CHUNKS, session\)/.test(bsG)
      && /unresolved RTP target port/.test(raopG),
    "prime 调用点早于 connect/未传 session —— dgram 目标端口=0 会静默吞掉",
  );
}

if (failures.length) {
  console.log(`✗ AirPlay 播放链路时序守卫失败 ${failures.length} 项:`);
  for (const f of failures) console.log("   - " + f);
  process.exit(1);
}
console.log("✓ AirPlay 播放链路时序守卫全部通过");
