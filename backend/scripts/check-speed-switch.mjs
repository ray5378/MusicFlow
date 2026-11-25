#!/usr/bin/env node
// ==================== 倍速(播放速率)回归守卫 S1–S38 ====================
//
// 背景:倍速这条路(2026-11-25 的 v4.15.6 热换源 + v4.15.8 容量投递/裁环)踩过的坑
// **全部是静默的** —— 不报错、不崩溃、既有用例全绿,只表现为「听着不对」:
//   · 提交点回到写前沿 ⇒ 改速又要等 30s(用户最初的投诉原样复现);
//   · 提交时不裁环 / 不回退 `cursorUs` ⇒ 新帧 ts 从旧前沿续,环里留几十秒断层,
//     桥按 hole-fill 灌静音(比不换源更糟);
//   · 换源顺带 `notifyBridgeGeneration` ⇒ 桥换代 ⇒ `newgen-skip` 丢 ~1.2s + 断点;
//   · `this.rate` 与 `positionMs` / `displayPositionMs` 不同拍换算 ⇒ 进度条跳一拍;
//   · 显示值改成 `Math.max` 历史最大值 ⇒ 往回拖卡死(「一个数字不能同时当判定和显示」);
//   · 投递闸去掉任一道 ⇒ 直连成员实收前沿 D 与桥游标 B 分叉:组内差一整个前瞻深度;
//   · `pumpMemberQueue` 里出现 `await` ⇒ 泵 stall 越过 500ms 宽限,5s 后判编码器死亡
//     直接放弃本曲(streamEngine 的 maxSilentDegradeUs 红线);
//   · 投递闸对**纯 sendspin 组**也生效 ⇒ 无桥组的稳态行为被顺带改掉(未测过的面);
//   · `prefill_buffer_ms` 不再下传 ⇒ 用户把「设备缓冲深度」改 5s 却毫无效果;
//   · 同倍率幂等被改成 `return false` ⇒ 重启后客户端回灌倍率白断一次流(实测丢 984ms);
//   · `case "setRate"` 并进 `transport` 分支(统一 `return null`) ⇒ 主进程永远拿到 null,
//     热换源静默失效,回落重投后断点照旧。
//
// 🔴 硬性要求 1:**只认非注释行**。源码里大量「⚠️ 不得出现 XXX」的说明性注释,直接对原文
//    做正则会被自己的注释查红,故一律先过 `lib/strip-comments.mjs` 的 stripComments()。
//
// 🔴 硬性要求 2:断言只锚「唯一的表达式前缀」,**绝不锚参数个数/闭括号**。取函数体一律
//    「2 空格缩进的成员定义 + 圆括号配平跳过参数表 + 花括号配平取体」,参数怎么改都不假红。
//    (2026-10-26 教训:check-airplay-playback-chain.mjs 把参数表连闭括号钉死,实现改签名后
//     守卫假红、main ci 连挂两轮。)
//
// 🔴 硬性要求 3:与现实冲突的不变量**不改代码**,登记为 TODO 缺口 —— 输出可见、不阻断 CI。
//
// 覆盖映射(编号 → 守护的东西):
//   S1–S6    投递闸存在且只对桥组启用(D = min(容量, 档位, 桥游标))
//   S7–S8    队列入队 + 上限(丢最旧,绝不无界)
//   S9–S13   非阻塞出队 + 记账 + 消费剔除 + 最落后成员前沿
//   S14–S17  桥游标过滤 / 裁环代次与钳制
//   S18–S22  提交点解析 min(B, D)、无桥回落旧路径、禁止回到「混合组一刀切 null」、提交处重取
//   S23–S27  提交原子段(裁环 + ts 回退 + 两量同拍 + 无 await + 显示纯派生)
//   S28–S30  换源不换代 / 降级判据
//   S31–S32  档位活值单向下传 / 闸③ 不得绕过组字段自读配置
//   S33–S35  跨进程 setRate 必须回布尔 / 同倍率幂等回 true
//   S36–S38  MA 对齐注释铁律 / 收益口径 / 「非桥组不启用」的刻意分叉
//
// 关联单测:`pumpRateHotSwitch.test.ts`(热换源骨架)、`pumpRateTrim.test.ts`(裁环 + 三道闸)。
// 关联实测量化判据:docs/按容量投递-设计方案-20261125.md §九、§九bis。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const SERVER = "backend/src/services/sendspin/server.ts";
const ENGINE = "backend/src/services/sendspin/streamEngine.ts";
const CORE = "backend/src/services/sendspin/playerCore.ts";
const CHILD = "backend/src/services/sendspin/childMain.ts";
const DEMAND = "backend/src/services/sendspin/contentDemand.ts";

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
/** 缺口:与现实冲突的不变量,只提示不阻断(硬性要求 3)。 */
const gaps = [];
function gap(name, hint) {
  gaps.push(name + (hint ? " —— " + hint : ""));
  console.log("  ! " + name + (hint ? " —— " + hint : ""));
}

// ---------------------------------------------------------------------------
// 「取函数体」工具 —— 刻意不看参数表(硬性要求 2)
// ---------------------------------------------------------------------------

/** 从 text[start] 的开括号起,按花括号配平截到其闭合 `}`(字符串感知)。 */
function sliceBraces(text, start) {
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 按「2 空格缩进的成员定义 + `(`」定位函数体。
 * ① 圆括号配平跳过整个参数表;② 跳过返回类型注解里的 `{ ... }` 类型字面量
 * (前一非空白字符是 `:`/`|`/`&` ⇒ 整体跳过);③ 花括号配平取体。
 * 传进来的 re 必须以 `\(` 结尾,且应锚 `^[ \t]{2}(修饰符)*name\s*\(` —— 保证拿的是**定义**
 * 而不是文件更早处的调用点(例如 `bridgeTrimCursorUs()` 在 canAccept 里先被调用过)。
 */
function bodyByName(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  let pdepth = 1;
  let quote = "";
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") pdepth += 1;
    else if (c === ")") {
      pdepth -= 1;
      if (pdepth === 0) {
        i += 1;
        break;
      }
    }
  }
  if (pdepth !== 0) return null;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") i += 2;
        else if (text[i] === q) {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (c === "{") {
      let j = i - 1;
      while (j >= 0 && /\s/.test(text[j])) j -= 1;
      const prev = j >= 0 ? text[j] : "";
      if (prev === ":" || prev === "|" || prev === "&") {
        const tl = sliceBraces(text, i);
        if (!tl) return null;
        i += tl.length;
        continue;
      }
      return sliceBraces(text, i);
    }
    i += 1;
  }
  return null;
}

/** 成员定义锚点:2 空格缩进 + 可选修饰符 + 名字 + `(`。 */
const member = (name) =>
  new RegExp("^[ \\t]{2}(?:(?:public|private|protected|static|readonly|async|override)\\s+)*" + name + "\\s*\\(", "m");

// ---------------------------------------------------------------------------
const srvRaw = read(SERVER);
const srv = stripComments(srvRaw);
const engRaw = read(ENGINE);
const eng = stripComments(engRaw);
const core = stripComments(read(CORE));
const child = stripComments(read(CHILD));
const demandRaw = read(DEMAND);

// ===========================================================================
// S1–S5 投递闸:D = min(容量, 档位, 桥游标)
// ===========================================================================
console.log("[S1–S5] 逐成员投递闸");

const gateOn = bodyByName(srv, member("audioGateOn"));
check(
  "S1 投递闸只对桥组启用(纯 sendspin 组行为不变)",
  !!gateOn && /bridges\.size\s*>\s*0/.test(gateOn),
  "audioGateOn 丢了 bridges.size>0 ⇒ 无桥组稳态被顺带改掉",
);

const canAccept = bodyByName(srv, member("canAccept"));
check("S2 canAccept 存在", !!canAccept, "三道闸的载体不见了");
check(
  "S3 闸①设备容量(issuedBytes + 本帧 <= buffer_capacity)",
  !!canAccept && canAccept.includes("this.issuedBytes + bytes > this.bufferCapacityBytes"),
  "容量闸丢了 ⇒ 无条件下发,设备侧 BufferTracker 拒收",
);
check(
  "S4 闸②不超过桥投递游标(D <= B)",
  !!canAccept && canAccept.includes("bridgeTrimCursorUs") && canAccept.includes("endUs > b"),
  "桥游标闸丢了 ⇒ 直连成员比桥多收 (B,D] ⇒ ts 重叠重发/组内分叉",
);
check(
  "S5 闸③设备侧期望水位(prefill 档位 = 用户旋钮)",
  !!canAccept && canAccept.includes("prefillWantedMsCache") && canAccept.includes("nowUs() + BigInt(Math.round(pfMs * 1000))"),
  "档位闸丢了 ⇒ 用户把「设备缓冲深度」改 5s 却毫无效果",
);
check(
  "S6 canAccept 同步判据(不得出现 await)",
  !!canAccept && !/\bawait\b/.test(canAccept),
  "闸里 await ⇒ 出队循环被拖,泵 stall 风险",
);

// ===========================================================================
// S7–S11 非阻塞入队 + 记账 + 消费剔除
// ===========================================================================
console.log("[S7–S11] 入队/记账/剔除");

const sendAudio = bodyByName(srv, member("sendAudio"));
check(
  "S7 sendAudio 走队列(不直接下发,便于按容量逐帧放行)",
  !!sendAudio && sendAudio.includes("this.audioQueue.push("),
  "又变回直发 ⇒ 投递闸形同虚设",
);
check(
  "S8 队列内存上限 = capacity × 3,溢出丢最旧并计数",
  !!sendAudio && sendAudio.includes("this.bufferCapacityBytes * 3") && sendAudio.includes("this.audioQueue.shift()") && sendAudio.includes("this.droppedByQueueCap++"),
  "无限增长会 OOM;静默丢弃会掩盖设备不消费",
);

const pumpQueue = bodyByName(srv, member("pumpMemberQueue"));
check("S9 pumpMemberQueue 存在", !!pumpQueue, "出队器不见了");
check(
  "S10 pumpMemberQueue 绝不 await(泵 stall 红线)",
  !!pumpQueue && !/\bawait\b/.test(pumpQueue),
  "阻塞 ⇒ starvationUs 越过 500ms 宽限,5s 后判编码器死亡并放弃本曲",
);
check(
  "S11 记账:已发未播字节 + 已发前沿(issuedBytes / issuedFrontUs)",
  !!pumpQueue && pumpQueue.includes("this.issuedBytes += head.data.length") && pumpQueue.includes("this.issuedFrontUs"),
  "记账丢了 ⇒ 容量闸与 D 都失去数据来源",
);

const prune = bodyByName(srv, member("prunePlayed"));
check(
  "S12 prunePlayed 按 endUs <= now 移出(对齐 BufferTracker.prune_consumed)",
  !!prune && prune.includes("endUs <= now"),
  "不剔除 ⇒ 已播过的字节永久占额度,容量闸越走越紧",
);

const slowest = bodyByName(srv, member("slowestDirectMemberFrontUs"));
check(
  "S13 最落后成员前沿:跳过未开始(0n)的成员并取 min",
  !!slowest && slowest.includes("issuedFrontUs") && slowest.includes("f === 0n") && slowest.includes("f < min"),
  "未开播成员会把 D 钉成 0 ⇒ 永不裁环;取 max 则会漏掉最慢的那台",
);

// ===========================================================================
// S14–S19 裁环与提交点
// ===========================================================================
console.log("[S14–S19] 裁环与提交点");

const bridgeCursor = bodyByName(srv, member("bridgeTrimCursorUs"));
check(
  "S14 桥游标:无桥/游标全 0 返回 null,且过滤非本组成员与 0n",
  !!bridgeCursor && bridgeCursor.includes("this.bridges.size === 0) return null") && bridgeCursor.includes("this.bridges.has(id)") && bridgeCursor.includes("c !== 0n"),
  "摘桥残留的冻结游标会污染裁上界 ⇒ 裁到已投递内容",
);

const trimRing = bodyByName(srv, member("trimRingAfter"));
check("S15 trimRingAfter 存在", !!trimRing, "裁环器不见了 ⇒ 又回到 30s");
check(
  "S16 裁环只裁当前内容代次,从尾部回扫、遇 <= cutUs 即停",
  !!trimRing && trimRing.includes("ring[i].ep !== this.bridgeContentEpoch") && trimRing.includes("ring.length - 1; i >= 0; i--") && trimRing.includes("ring[i].tsUs <= cutUs) break"),
  "裁到历史代次或正向扫,都会把已播内容删掉",
);
check(
  "S17 裁环后把各设备投递游标钳到 <= cutUs(只钳不删)",
  !!trimRing && trimRing.includes("this.bcCursor.set(id, cutUs)"),
  "不钳游标 ⇒ 桥从已删区间继续读,读到空洞",
);

const resolveTrim = bodyByName(eng, member("resolveTrimPoint"));
check("S18 resolveTrimPoint 存在", !!resolveTrim, "提交点解析不见了");
check(
  "S19 无桥(游标 null/0n)回落旧路径,不得裁",
  !!resolveTrim && resolveTrim.includes("bridgeUs === null || bridgeUs === 0n) return null"),
  "纯 sendspin 组被强行裁环 = 未测面",
);
check(
  "S20 混合组取 min(桥游标 B, 最落后成员前沿 D)",
  !!resolveTrim && resolveTrim.includes("directUs > 0n && directUs < trimUs"),
  "漏取 D ⇒ 把直连成员已收内容裁掉 ⇒ 空洞;漏取 B ⇒ 桥读到空档",
);
check(
  "S21 禁止回到「混合组一刀切 null」(P1 前行为)",
  !!resolveTrim && !resolveTrim.includes("hasDirectMembers"),
  "投递闸保证 D<=B 后,一刀切会让混合组又等 30s",
);

// 提交点必须**重取**:建窗期间游标在前进,沿用建窗值会裁掉已投递内容。
const trimCalls = eng.split("this.resolveTrimPoint()").length - 1;
check(
  "S22 提交处重取裁剪点(建窗 + 提交各一次,>= 2)",
  trimCalls >= 2,
  `只取了 ${trimCalls} 次 ⇒ 沿用建窗旧游标,裁掉 [旧,新] 已投递段 ⇒ 桥重投`,
);

// ---- 提交原子段:裁环 + ts 回退 + 两量同拍 + 无 await ----
const OPEN = "原子段(此间禁止 await)";
const CLOSE = "原子段结束";
const idxCommit = engRaw.indexOf("const trimCommit = this.resolveTrimPoint();");
const idxOpen = idxCommit >= 0 ? engRaw.indexOf(OPEN, idxCommit) : -1;
const idxClose = idxOpen >= 0 ? engRaw.indexOf(CLOSE, idxOpen) : -1;
let atomic = null;
if (idxCommit >= 0 && idxOpen >= 0 && idxClose > idxOpen) {
  // 必须从**行首**切:标记本身是注释(`// ------- 原子段(此间禁止 await)-------`),
  // 从标记词中间切会让这半截注释逃过 stripComments,把注释里的 "await" 当成代码。
  const lineStart = engRaw.lastIndexOf("\n", idxOpen) + 1;
  atomic = stripComments(engRaw.slice(lineStart, idxClose));
}
check("S23 提交原子段标记存在(此间禁止 await / 原子段结束)", !!atomic, "标记被删 ⇒ 守卫无法守护最危险的那段");
check(
  "S24 原子段内裁环 + cursorUs 同拍回退到裁剪点",
  !!atomic && atomic.includes("trimRingAfter") && atomic.includes("cursorUs = trimCommit.tsUs"),
  "不回退 ts ⇒ 新帧从旧前沿续,与裁后环尾形成几十秒断层 ⇒ hole-fill 灌静音",
);
check(
  "S25 原子段内 rate 与 positionMs / displayPositionMs 同拍换算",
  !!atomic && atomic.includes("this.rate = r1") && atomic.includes("this.group.positionMs = this.group.positionMs * k") && atomic.includes("this.group.displayPositionMs = this.group.displayPositionMs * k"),
  "不同拍 ⇒ 出口 posOut = positionMs × rate 跳一拍(进度条肉眼可见)",
);
check(
  "S26 原子段内绝不 await",
  !!atomic && !/\bawait\b/.test(atomic),
  "原子段里 await ⇒ 前后游标/汇率错拍,窗口与游标可能来自不同世代",
);
check(
  "S27 显示位置是纯派生量(禁止 Math.max 历史最大值)",
  !!atomic && !atomic.includes("Math.max(this.group.displayPositionMs"),
  "历史最大值补丁会让 seek 往回拖卡死",
);

// ===========================================================================
// S28–S31 换源不换代 / 降级判据 / 旋钮下传
// ===========================================================================
console.log("[S28–S31] 换源不换代 / 降级 / 旋钮");

const switchRate = bodyByName(eng, member("switchRate"));
check("S28 switchRate 存在", !!switchRate, "热换源骨架不见了");
check(
  "S29 换源绝不通知桥换代(epoch / timelineReseed / notifyBridgeGeneration)",
  !!switchRate && !switchRate.includes("notifyBridgeGeneration") && !switchRate.includes("this.epoch +="),
  "一换代桥就 newgen-skip,断点原样复现(实测丢 1.2s)",
);
check(
  "S30 降级判据仍在(未运行 / 起播在飞 / 已在建窗 / 同速率 / 非法值 / 无源)",
  !!switchRate &&
    switchRate.includes("this.running || !this.window || !this.songId") &&
    switchRate.includes("this.playInFlight || this.rateSwitching") &&
    switchRate.includes("Math.abs(r1 - r0) < 1e-9") &&
    switchRate.includes("if (!src) return false"),
  "少一条 ⇒ 起播在飞时硬换源 = 把旧曲音频灌进新曲时间轴",
);

check(
  "S31 prefill 档位由 pacing 单向写给组(server 侧闸③的唯一来源)",
  /this\.group\.prefillWantedMsCache\s*=\s*wantedMs/.test(eng),
  "下传断了 ⇒ 档位旋钮失效(改 5s 无效),或闸③永远读到 0 而形同虚设",
);
check(
  "S32 闸③ 的值只能来自组字段,不得在 server 侧直接读插件配置",
  !srv.includes("prefillTargetMs") && !srv.includes("readSendspinPluginConfig"),
  "server 自己读配置/缓存 ⇒ 与 streamEngine 形成循环依赖,且跨进程读到陈旧值",
);

// ===========================================================================
// S33–S35 跨进程链路 + 同倍率幂等
// ===========================================================================
console.log("[S33–S35] 跨进程 / 幂等");

const setRateIdx = child.indexOf('case "setRate"');
const nextCase = setRateIdx >= 0 ? child.indexOf('case "', setRateIdx + 10) : -1;
const setRateBlock = setRateIdx >= 0 ? child.slice(setRateIdx, nextCase > 0 ? nextCase : undefined) : "";
check(
  'S33 childMain 的 case "setRate" 独立返回布尔(不得并进 transport)',
  setRateBlock.includes("return setPlaybackRateCore("),
  "并进 transport(统一 return null)⇒ 主进程拿不到布尔,热换源静默失效",
);

const coreRate = bodyByName(core, /(?:export\s+)?async\s+function\s+setPlaybackRateCore\s*\(/);
check("S34 setPlaybackRateCore 存在", !!coreRate, "主进程侧入口不见了");
check(
  "S35 同倍率幂等:什么都不做但必须回 true",
  !!coreRate && coreRate.includes("Math.abs(from - r) < 1e-9") && coreRate.includes("return true"),
  "回 false ⇒ 重启后客户端回灌倍速白断一次流(实测丢 984ms)",
);

// ===========================================================================
// S36–S38 注释铁律 + 前瞻常量口径
// ===========================================================================
console.log("[S36–S38] 铁律与口径");

const lookaheadIdx = demandRaw.indexOf("PUMP_LOOKAHEAD_DEFAULT_US = ");
const lookaheadCtx = lookaheadIdx >= 0 ? demandRaw.slice(Math.max(0, lookaheadIdx - 900), lookaheadIdx) : "";
check(
  "S36 30s 前瞻常量处保留 MA 出处注释(用户铁律:对齐 MA 必须注明出处)",
  lookaheadIdx >= 0 && /MA\s+playback\.py/.test(lookaheadCtx) && /sleep_to_limit_buffer/.test(lookaheadCtx),
  "注释被删 ⇒ 后来者会把 30s 当魔法数随手改",
);
check(
  "S37 裁环的收益口径写死在代码注释里(30s → lead + RTP 队列)",
  /lead\s*\+\s*RTP\s*队列/.test(srvRaw) || /lead \+ RTP 队列/.test(engRaw),
  "口径失传 ⇒ 下次又用「提前=」当生效延迟",
);
check(
  "S38 投递闸的「非桥组不启用」理由仍在注释里(缩小改动面)",
  /纯 sendspin 组/.test(srvRaw),
  "注释删了看不出这是刻意分叉,容易被「统一」掉",
);

// ---------------------------------------------------------------------------
if (gaps.length > 0) {
  console.log(`\n! 已知缺口 ${gaps.length} 条(不阻断 CI):`);
  for (const g of gaps) console.log("  - " + g);
}
if (failures.length > 0) {
  console.error(`\n✗ check-speed-switch: ${failures.length}/${checks} 项不通过:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`\n✓ check-speed-switch: ${checks} 项全部通过`);
