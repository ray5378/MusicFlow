#!/usr/bin/env node
// ==================== AirPlay/Sendspin 桥接静态守卫(Phase 8 · 17 条不变量) ====================
//
// 背景:AirPlay 1/2 与 Sendspin 桥接是一条「全静默」链路 —— 时序锚点用错时钟源、缓冲深度被
// 归零、组公共 send_ahead 被桥 lead 污染、桥集合被并进 WS 成员集合、播放结束误清桥……
// 这些缺陷**都不报错**,只表现为「声音慢 3.7 秒」「偶发 underrun」「切歌后整组无声」「延迟调了没反应」,
// 靠真机 A/B 才能定位,成本极高。本守卫把 17 条已踩过的坑固化成静态不变量,CI 里直接失败。
//
// 🔴 硬性要求 1(项目里踩过的坑):**只认非注释行**。
//   源码里大量「⚠️ 不得出现 XXX」的文档性注释,若直接对原文做正则,守卫会被自己的注释查红。
//   因此本脚本一律先过 `lib/strip-comments.mjs` 的 `stripComments()`(字符串感知:跳过
//   ' " ` 三种字面量与反斜杠转义,再剥 // 与 /* */),之后才匹配。
//   (例:utils/hostClock.ts 的注释里就写着「禁止 Date.now()」——不剥注释,① 必然假红。)
//
// 🔴 硬性要求 2:每条断言都必须**能真的失败**,且失败时**只红那一条**。
//   实现时一条断言 = 一个 check(),互不共享判定中间量;每条都做过最小违规反证。
//
// 17 条:
//   ① 锚点链不得用墙钟:tsUs / RAOP NTP 必须同源于 host 单调时钟;
//   ② latencyFrames 不得归零(接收端播放保持深度),不得 Math.min(...,0) 钳零;
//   ③ 常量唯一源 + 取值钉死(147/160、4.5M/2.5M、384K/1.5M、0.3627…);
//   ④ PCM 不得走 JSON IPC(必须二进制,否则 base64 膨胀 + 拷贝抖动);
//   ⑤ 不得存在 start(anchorUnixMs) 旧接口(锚点必须是 host µs,不是 Unix ms);
//   ⑥ 组指令 fanOut 必须跳过桥占用设备(否则与桥会话互踩);
//   ⑦ members 必须是强类型 Set<SendspinConnection>,桥集合与之并行、绝不并入;
//   ⑧ commonSendAheadUs 体内不得出现 bridge/lead/bridges(MAJ-01:并进去全组 +3.7s);
//   ⑨ pushFrame 必须含 pcm:100 虚拟组补偿(BLK-01:否则「只有桥」时上游判零产出→切歌);
//   ⑩ playGroupCore 重建路径不得清桥(BLK-02:清桥会掐断刚接上的桥会话);
//   ⑪ generation 必须取二元组 epoch * 1_000_003 + timelineReseed;rehost 不得动 epoch;
//   ⑫ RAOP RECORD 后四个锚点必须同域:baseTs 在赋值列表里、先 >>> 0 再 % CHUNK_LEN、禁用 & 0xFFFFFFFF;
//   ⑬ 不得伪造 acked(设备播放确认);上报字段名必须是 scheduledAnchorUs;
//   ⑭ 桥 socket 路径必须是 mfab/<短 hash>(deviceId/token 只进 hash,不进文件名);
//   ⑮ 锚点一次性:aligner 非空必须早退(改群组延迟只能重建桥,热改=整组飘音);
//   ⑯ 群延迟补偿只有一个落点(firstFrameTsUs + anchorShiftUs),不得两头各加一次;
//   ⑰ RAOP 重连退避必须双层封顶(指数项 + 抖动项,否则重连风暴/永不重连)。
//
// 零依赖 node 脚本,挂 ci.yml 的 AirPlay 守卫 job(与既有 check-airplay-*.mjs 同构)。
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = "backend/src";

const read = (rel) => readFileSync(join(root, rel), "utf8");
/** 读源码并**剥注释**(剥离后才允许匹配 —— 见文件头硬性要求 1)。 */
const code = (rel) => stripComments(read(rel));
const count = (hay, needle) => hay.split(needle).length - 1;

/** 递归收集 backend/src 下的 .ts(可排除 *.test.ts)。 */
function walkTs(dirAbs, out = []) {
  for (const e of readdirSync(dirAbs, { withFileTypes: true })) {
    const p = join(dirAbs, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const absSrc = join(root, SRC);
const ALL_TS = walkTs(absSrc);
const SRC_TS = ALL_TS.filter((p) => !p.endsWith(".test.ts"));
const rel = (p) => relative(root, p);
/** 预先剥离全部源码注释(全仓扫描用;只算一次)。 */
const SRC_STRIPPED = SRC_TS.map((p) => ({ path: rel(p), code: stripComments(read(rel(p))) }));

/** 全仓计数(仅 backend/src,排除 *.test.ts)。返回命中详情。 */
function countInSrc(needle) {
  let n = 0;
  const where = [];
  for (const f of SRC_STRIPPED) {
    const c = f.code.split(needle).length - 1;
    if (c > 0) {
      n += c;
      where.push(`${f.path}×${c}`);
    }
  }
  return { n, where: where.join(", ") };
}

/** 全仓正则统计(仅 backend/src,排除 *.test.ts)。`filter` 可按路径收窄作用域。 */
function matchInSrc(re, filter = null) {
  const rx = new RegExp(re.source, "g");
  let n = 0;
  const where = [];
  for (const f of SRC_STRIPPED) {
    if (filter && !filter(f.path)) continue;
    const m = f.code.match(rx);
    if (m && m.length > 0) {
      n += m.length;
      where.push(`${f.path}×${m.length}`);
    }
  }
  return { n, where: where.join(", ") };
}

/**
 * 取一段函数体:从签名所在位置起,按**花括号配平**截到该函数自己的闭合 `}`。
 * ⚠️ 不能用 `indexOf("\n}")` —— 本仓库大量函数是嵌套定义的(如
 * `createGroupProtocolPlayer` 内部的 fanOut / prepareBridgeRoute),首个行首 `}` 会
 * 越界吞掉后续函数,导致「体内不得出现 X」误判(首版就踩了这个,6 条假红)。
 * 扫描时跳过 ' " ` 三种字符串字面量与反斜杠转义,避免字符串里的花括号带偏配平。
 */
function bodyOf(text, signatureRe) {
  const m = signatureRe.exec(text);
  if (!m) return null;
  let i = text.indexOf("{", m.index + m[0].length - 1);
  if (i === -1) return null;
  const start = m.index;
  let depth = 0;
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
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}

const HOST_CLOCK = `${SRC}/utils/hostClock.ts`;
const SPIN_CLOCK = `${SRC}/services/sendspin/clock.ts`;
const BRIDGE_MATH = `${SRC}/services/airplay/bridgeMath.ts`;
const RAOP = `${SRC}/services/airplay/raop.ts`;
const RATES = `${SRC}/services/airplay/rates.ts`;
const RESAMPLER = `${SRC}/services/airplay/resampler.ts`;
const IPC = `${SRC}/services/airplay/ipcProtocol.ts`;
const BRIDGE_CHANNEL = `${SRC}/services/airplay/bridgeChannel.ts`;
const BRIDGE_SESSION = `${SRC}/services/airplay/bridgeSession.ts`;
const GROUP_PLAYER = `${SRC}/services/group/protocolPlayer.ts`;
const SPIN_SERVER = `${SRC}/services/sendspin/server.ts`;
const SPIN_ENGINE = `${SRC}/services/sendspin/streamEngine.ts`;
const BRIDGE_ATTACH = `${SRC}/services/sendspin/bridgeAttach.ts`;
const PLAYER_CORE = `${SRC}/services/sendspin/playerCore.ts`;

// ---------------------------------------------------------------------------
// ① 锚点链不得用墙钟(tsUs / RAOP NTP 必须同源于 host 单调时钟)
// ---------------------------------------------------------------------------
console.log("===== ① 锚点链不得出现 Date.now / performance.now / Unix 毫秒来源 =====");
{
  const WALL = /\bDate\.now\b|\bperformance\.now\b/;
  const hc = code(HOST_CLOCK);
  check(
    "utils/hostClock.ts 剥注释后不得出现 Date.now / performance.now",
    !WALL.test(hc),
    `命中:${(hc.match(new RegExp(WALL.source, "g")) || []).join(", ")}`,
  );
  check(
    "utils/hostClock.ts 的 nowUs 取自 process.hrtime.bigint() / 1000n(单调 µs,非墙钟)",
    /BigInt\(\s*hrtime\.bigint\(\)\s*\/\s*1000n\s*\)/.test(hc),
    "未找到 hrtime.bigint()/1000n 的单调 µs 实现",
  );
  const sc = code(SPIN_CLOCK);
  check(
    "sendspin/clock.ts 只从 hostClock re-export(不得自建墙钟)",
    /export\s*\{\s*nowUs,\s*setNowUsOverride\s*\}\s*from\s*"\.\.\/\.\.\/utils\/hostClock\.js"/.test(sc) &&
      !WALL.test(sc),
    WALL.test(sc) ? "clock.ts 出现墙钟调用" : "未找到对 hostClock 的 re-export",
  );
  const bm = code(BRIDGE_MATH);
  check(
    "bridgeMath.ts(时间↔样本换算唯一出处)不得出现墙钟",
    !WALL.test(bm),
    `命中:${(bm.match(new RegExp(WALL.source, "g")) || []).join(", ")}`,
  );
  const raop = code(RAOP);
  const ntpNowBody = bodyOf(raop, /export\s+function\s+ntpNow\(\)\s*:\s*bigint\s*\{/);
  check(
    "raop.ts 的 ntpNow() 体内是 ntpFromHostUs(nowUs())(锚点不得由墙钟构造)",
    ntpNowBody !== null && /ntpFromHostUs\(\s*nowUs\(\)\s*\)/.test(ntpNowBody) && !WALL.test(ntpNowBody),
    ntpNowBody === null ? "未找到 ntpNow()" : "体内缺 ntpFromHostUs(nowUs()) 或出现墙钟",
  );
  check(
    "raop.ts 的 RECORD 锚点 ntp0 取自 ntpNow(),不得是 Date.now()",
    /const\s+ntp0\s*=\s*ntpNow\(\)\s*;/.test(raop),
    "未找到 `const ntp0 = ntpNow();`",
  );
}

// ---------------------------------------------------------------------------
// ② latencyFrames 不得归零
// ---------------------------------------------------------------------------
console.log("===== ② latencyFrames 不得被赋 0 / 不得 Math.min(...,0) 钳零 =====");
{
  const zeroAssign = matchInSrc(/\blatencyFrames\s*[:=]\s*0\b/);
  check(
    "全仓不得出现 `latencyFrames = 0` / `latencyFrames: 0`",
    zeroAssign.n === 0,
    `${zeroAssign.n} 处:${zeroAssign.where}`,
  );
  const clampA = matchInSrc(/Math\.min\([\s\S]{0,120}?latencyFrames[\s\S]{0,120}?,\s*0\s*\)/);
  const clampB = matchInSrc(/Math\.min\(\s*0\s*,[\s\S]{0,120}?latencyFrames\s*\)/);
  check(
    "不得用 Math.min(..., 0) 把 latencyFrames 钳到 0(任一参数顺序)",
    clampA.n === 0 && clampB.n === 0,
    `${clampA.n + clampB.n} 处:${clampA.where} ${clampB.where}`.trim(),
  );
  const raop = code(RAOP);
  check(
    "raop.ts RECORD 回执的 Audio-Latency 用 Math.max 抬高(≥ 1 秒帧数,不得下沉归零)",
    /this\.latencyFrames\s*=\s*Math\.max\(\s*audioLatency\s*,\s*this\.opts\.sampleRate\s*\)/.test(raop),
    "未找到 Math.max(audioLatency, sampleRate)",
  );
  const bs = code(BRIDGE_SESSION);
  check(
    "bridgeSession 取接收端 L 时用 Math.max(1, ...) 兜底",
    /Math\.max\(\s*1\s*,\s*player\.negotiatedLatencyFrames\s*\)/.test(bs),
    "未找到 Math.max(1, player.negotiatedLatencyFrames)",
  );
}

// ---------------------------------------------------------------------------
// ③ 常量唯一源 + 取值钉死
// ---------------------------------------------------------------------------
console.log("===== ③ 常量唯一源 + 取值钉死(禁止散落硬编码) =====");
{
  const rates = code(RATES);
  check(
    "rates.ts 是速率唯一源:SENDSPIN_RATE = 48000 与 AIRPLAY1_RATE = 44100",
    /export\s+const\s+SENDSPIN_RATE\s*=\s*48000\s*;/.test(rates) &&
      /export\s+const\s+AIRPLAY1_RATE\s*=\s*44100\s*;/.test(rates),
    "rates.ts 缺少 SENDSPIN_RATE=48000 或 AIRPLAY1_RATE=44100",
  );
  const uniq = (needle) => {
    const r = countInSrc(needle);
    check(`字面量 ${JSON.stringify(needle)} 全仓只允许出现 1 次`, r.n === 1, `实际 ${r.n} 次:${r.where}`);
  };
  uniq("= 147");
  uniq("= 160");
  uniq("4_500_000");
  uniq("2_500_000");
  uniq("BRIDGE_MIN_BUFFER_US = 1_000_000;");
  uniq("384 * 1024");
  uniq("1536 * 1024");
  uniq("0.3627");
  // 800_000(ANCHOR_SAFE_LEAD_US)唯一源 = rates.ts,streamEngine 一律 import。
  // ⚠️ 钉值与钉唯一必须在同一条 check(拆两条会让「改值」一次打红两条,违反
  // 硬性要求 2「只红那一条」),且不得把 "800_000" 追加进 uniq() 列表(同因
  // 第二条断言,同样连带变红)。
  // ⚠️ 用 matchInSrc(/\b800_000\b/) 不用 countInSrc("800_000") 纯子串计数:
  // split 无词边界,1_800_000 / 48_800_000 会被误计入;正则 \b 在 `_` 与数字
  // 之间无边界,天然排除下划线连接的大数,避免无关字面量连带打红本条。
  const ratesLead = /export\s+const\s+ANCHOR_SAFE_LEAD_US\s*=\s*800_000\s*;/.test(rates);
  const leadOnce = matchInSrc(/\b800_000\b/).n === 1;
  check(
    "ANCHOR_SAFE_LEAD_US 全仓只在 rates.ts 以 800_000 声明一次(其余一律 import,禁止重复声明/内联)",
    ratesLead && leadOnce,
    `rates.ts 声明=${ratesLead} 全仓 \\b800_000\\b 命中 ${matchInSrc(/\b800_000\b/).n} 处`,
  );
  check(
    "重采样因子只有 rates.ts 的 RESAMPLE_L/RESAMPLE_M,resampler.ts 不得内联 147/160",
    /import\s*\{\s*RESAMPLE_L,\s*RESAMPLE_M\s*\}\s*from\s*"\.\/rates\.js"/.test(code(RESAMPLER)) &&
      count(code(RESAMPLER), "= 147") === 0 &&
      count(code(RESAMPLER), "= 160") === 0,
    "resampler.ts 未从 rates 取 RESAMPLE_L/RESAMPLE_M,或内联了 147/160",
  );
}

// ---------------------------------------------------------------------------
// ④ PCM 不得走 JSON IPC
// ---------------------------------------------------------------------------
console.log("===== ④ PCM 不得走 JSON IPC(必须二进制帧) =====");
{
  const ipc = code(IPC);
  check(
    "ipcProtocol.ts 不得出现 JSON.stringify(PCM 必须走二进制帧,不得 base64/JSON)",
    count(ipc, "JSON.stringify") === 0,
    `命中 ${count(ipc, "JSON.stringify")} 处`,
  );
  // 只查 IPC / 桥通道的**载荷路径**:全仓 base64 有很多合法用途(QR、插件加密、
  // RAOP SDP 的 rsaaeskey/aesiv、歌词等),不是本断言的对象。
  const payloadPath = (p) => p === IPC || p === BRIDGE_CHANNEL;
  const b64 = matchInSrc(/toString\(\s*["']base64["']\s*\)/, payloadPath);
  check(
    "IPC/桥通道载荷不得用 toString(\"base64\") 搬运音频字节(必须二进制帧)",
    b64.n === 0,
    `${b64.n} 处:${b64.where}`,
  );
  // JSON.stringify 可以用于 BOUNDARY 之类的元数据,但**不得**出现在 PCM 载荷附近。
  const nearPcm = matchInSrc(/JSON\.stringify\([\s\S]{0,200}?\b(?:pcm|PCM|audio|Audio)\b/);
  check(
    "JSON.stringify 的 200 字符邻域内不得出现 pcm/audio 载荷(元数据除外)",
    nearPcm.n === 0,
    `${nearPcm.n} 处:${nearPcm.where}`,
  );
}

// ---------------------------------------------------------------------------
// ⑤ 不得存在 start(anchorUnixMs) 旧接口
// ---------------------------------------------------------------------------
console.log("===== ⑤ 不得存在 start(anchorUnixMs) 旧接口 =====");
{
  const unixAnchor = matchInSrc(/anchorUnixMs/);
  check(
    "全仓不得出现 anchorUnixMs(锚点必须是 host µs,Unix ms 会被墙钟回拨带歪)",
    unixAnchor.n === 0,
    `${unixAnchor.n} 处:${unixAnchor.where}`,
  );
  const callForm = matchInSrc(/\.start\(\s*anchorUnixMs\b/);
  check(
    "不得存在 .start(anchorUnixMs) 调用形态",
    callForm.n === 0,
    `${callForm.n} 处:${callForm.where}`,
  );
}

// ---------------------------------------------------------------------------
// ⑥ 组指令 fanOut 必须跳过桥占用设备
// ---------------------------------------------------------------------------
console.log("===== ⑥ 组指令 fanOut 必须跳过桥占用设备(避免与桥会话互踩) =====");
{
  const gp = code(GROUP_PLAYER);
  // ⚠️ 这里刻意**不**用 bodyOf 取 fanOut 函数体:它的返回类型 `Promise<{ fulfilled: ... }>`
  // 含花括号,配平会把类型字面量误当成函数体(首版即栽在此处)。改用对「唯一语句形态」
  // 做整文件断言 —— 该语句在 protocolPlayer.ts 里只出现一次,精度足够且不会越界。
  check(
    "fanOut 的 airplay 成员取用必须 `.filter((d) => !isBridgeOwned(d))`(桥占用设备的传输由组泵承担)",
    /const\s+apIds\s*=\s*getOnlineAirplayIds\(groupId\)\.filter\(\s*\(d\)\s*=>\s*!isBridgeOwned\(d\)\s*\)\s*;/.test(gp),
    "未找到 `const apIds = getOnlineAirplayIds(groupId).filter((d) => !isBridgeOwned(d));`",
  );
  check(
    "该过滤语句全仓唯一(不得再有第二份 fanOut 绕开过滤)",
    countInSrc("getOnlineAirplayIds(groupId).filter((d) => !isBridgeOwned(d))").n === 1,
    `命中 ${countInSrc("getOnlineAirplayIds(groupId).filter((d) => !isBridgeOwned(d))").n} 次`,
  );
  check(
    "回落 solo cast 的设备由 prepareBridgeRoute 的 soloFallback 单独记名(与 fanOut 分流)",
    /soloFallback\.push\(d\)/.test(gp) && /soloFallback\.includes\(d\)/.test(gp),
    "prepareBridgeRoute 未记录或未消费 soloFallback",
  );
}

// ---------------------------------------------------------------------------
// ⑦ members 必须强类型、桥集合不得并入
// ---------------------------------------------------------------------------
console.log("===== ⑦ members 不得退化为 Set<any>,桥集合绝不并入 members =====");
{
  const server = code(SPIN_SERVER);
  check(
    "SendspinGroup.members 必须是 `new Set<SendspinConnection>()`(强类型)",
    count(server, "members = new Set<SendspinConnection>();") === 1,
    `命中 ${count(server, "members = new Set<SendspinConnection>();")} 次`,
  );
  // 作用域收窄到桥接相关的两个域:插件发现里的 Set<any> 与本不变量无关。
  const bridgeDomains = (p) =>
    p.includes("/services/airplay/") || p.includes("/services/sendspin/") || p.includes("/services/group/");
  const anySet = matchInSrc(/new\s+Set<\s*any\s*>/, bridgeDomains);
  check(
    "桥接相关模块(airplay/sendspin/group)不得出现 new Set<any>()(弱化后桥/成员集合互换失去编译期保护)",
    anySet.n === 0,
    `${anySet.n} 处:${anySet.where}`,
  );
  const attach = code(BRIDGE_ATTACH);
  check(
    "bridgeAttach.ts 不得把桥塞进 members(members.add 应为 0 次)",
    count(attach, "members.add(") === 0,
    `命中 ${count(attach, "members.add(")} 处`,
  );
  check(
    "桥集合是独立字段 bridges(与 members 并行),由 bridgeAttach 以 g.bridges 访问",
    /const\s+bridges\s*=\s*g\.bridges\b/.test(attach),
    "bridgeAttach 未通过 g.bridges 访问独立桥集合",
  );
}

// ---------------------------------------------------------------------------
// ⑧ commonSendAheadUs 体内不得出现 bridge/lead
// ---------------------------------------------------------------------------
console.log("===== ⑧ commonSendAheadUs 体内不得出现 bridge/lead(MAJ-01 回归防线) =====");
{
  const server = code(SPIN_SERVER);
  const body = bodyOf(server, /commonSendAheadUs\(\)\s*:\s*number\s*\{/);
  check("commonSendAheadUs 存在且取其函数体", body !== null, "未找到 commonSendAheadUs()");
  // ⚠️ 用**子串**匹配,不用 `\b` 词边界:MAJ-01 的真实引信几乎都是 camelCase 复合名
  // (`bridgeLeadUs` / `bridgesLeadUs` / `leadUs` / `this.bridges`),而 `\blead\b` 抓不到
  // `bridgeLead`(`Lead` 前面是字母 `e`,没有词边界)。注释已被 stripComments 剥掉,
  // 所以子串匹配不会误伤文档性注释。
  const LEAK = /bridg|lead/i;
  check(
    "commonSendAheadUs() 实现体内不得出现 bridge / lead 任一标识(含 camelCase 复合名)",
    body !== null && !LEAK.test(body),
    body === null
      ? "无函数体"
      : `体内命中:${(body.match(/[A-Za-z0-9_]*(?:bridg|lead)[A-Za-z0-9_]*/gi) || []).join(", ")}`,
  );
  check(
    "commonSendAheadUs 只由 members 的 sendAheadInputOf 汇总(不含桥成员)",
    body !== null && /computeCommonSendAhead\(\[\.\.\.this\.members\]\.map\(\(m\)\s*=>\s*sendAheadInputOf\(m\)\)\)/.test(body),
    "实现体不是 [...this.members].map(sendAheadInputOf) 形态",
  );
}

// ---------------------------------------------------------------------------
// ⑨ pushFrame 必须含 pcm:100 虚拟组补偿
// ---------------------------------------------------------------------------
console.log("===== ⑨ pushFrame 必须含 pcm:100 虚拟组补偿(BLK-01) =====");
{
  const server = code(SPIN_SERVER);
  check(
    "pushFrame 内以 encoderKey(\"pcm\", 100) 建虚拟组键",
    /const\s+pcmKey\s*=\s*this\.encoderKey\(\s*"pcm"\s*,\s*100\s*\)\s*;/.test(server),
    "未找到 const pcmKey = this.encoderKey(\"pcm\", 100);",
  );
  check(
    "虚拟组 members=[] 且 codec/gain 为 pcm:100(编码与真实成员解耦)",
    /groups\.set\(\s*pcmKey\s*,\s*\{\s*codec:\s*"pcm"\s*,\s*gain:\s*100\s*,\s*members:\s*\[\]\s*\}\s*\)/.test(server),
    "未找到 groups.set(pcmKey, { codec: \"pcm\", gain: 100, members: [] })",
  );
  check(
    "虚拟组只在有桥时创建(不得给无桥场景增加编码开销)",
    /if\s*\(\s*this\.bridges\.size\s*>\s*0\s*\)\s*\{\s*const\s+pcmKey/.test(server),
    "虚拟组创建未被 this.bridges.size > 0 门控",
  );
}

// ---------------------------------------------------------------------------
// ⑩ playGroupCore 不得清桥
// ---------------------------------------------------------------------------
console.log("===== ⑩ playGroupCore 不得清桥;clearGroupBridges 只许两处终态(stopGroupCore/空组回收) =====");
{
  const pc = code(PLAYER_CORE);
  const idxPlay = pc.indexOf("export function playGroupCore(");
  const idxStop = pc.indexOf("export function stopGroupCore(");
  check("playerCore.ts 同时存在 playGroupCore 与 stopGroupCore", idxPlay !== -1 && idxStop !== -1,
    `playGroupCore=${idxPlay} stopGroupCore=${idxStop}`);
  // playGroupCore 区间 = 从它开始到下一个顶层 export function 之前。
  const nextExport = idxPlay === -1 ? -1 : pc.indexOf("\nexport function ", idxPlay + 10);
  const playRegion = idxPlay === -1 ? "" : pc.slice(idxPlay, nextExport === -1 ? undefined : nextExport);
  check(
    "playGroupCore 内不得调用 clearGroupBridges / bridges.clear / 清 bridgeSpecs",
    playRegion.length > 0 &&
      !/clearGroupBridges|\bbridges\.clear\(\)|bridgeSpecs\s*=\s*\[\s*\]/.test(playRegion),
    "playGroupCore 体内出现清桥操作",
  );
  // 终态白名单两处(BLK-02 语义:只有**终态**可清桥;playGroupCore 的 seek 重建
  // 热复用路径一律不清):① stopGroupCore(显式组停);② server.ts onConnectionClosed
  // 空组回收(组对象即将丢弃,不清则活 BridgeMember 永不可触达 —— 洞 B)。
  check(
    "clearGroupBridges(g) 全仓恰好两处(终态白名单:stopGroupCore + 空组回收)",
    countInSrc("clearGroupBridges(g)").n === 2,
    `全仓调用 ${countInSrc("clearGroupBridges(g)").n} 次(白名单 2)`,
  );
  // 区间断言①:playerCore 内恰 1 处,且落在 stopGroupCore 体(到下一个顶层 export 前)。
  const stopNext = idxStop === -1 ? -1 : pc.indexOf("\nexport function ", idxStop + 10);
  const stopRegion = idxStop === -1 ? "" : pc.slice(idxStop, stopNext === -1 ? undefined : stopNext);
  check(
    "playerCore.ts 的 clearGroupBridges(g) 必须在 stopGroupCore 体内(且仅 1 处)",
    (pc.split("clearGroupBridges(g)").length - 1) === 1 && stopRegion.includes("clearGroupBridges(g)"),
    `playerCore 内 ${pc.split("clearGroupBridges(g)").length - 1} 处;stopGroupCore 体含=${stopRegion.includes("clearGroupBridges(g)")}`,
  );
  // 区间断言②:server.ts 内恰 1 处,且落在 onConnectionClosed 的 g.empty 终态分支。
  const srvTs = code(SPIN_SERVER);
  const idxClosed = srvTs.indexOf("onConnectionClosed(conn: SendspinConnection): void {");
  const idxGroupFn = idxClosed === -1 ? -1 : srvTs.indexOf("  group(name: string)", idxClosed);
  const closedRegion = (idxClosed === -1 || idxGroupFn === -1) ? "" : srvTs.slice(idxClosed, idxGroupFn);
  check(
    "server.ts 的 clearGroupBridges(g) 必须在 onConnectionClosed 空组回收分支内(且仅 1 处)",
    (srvTs.split("clearGroupBridges(g)").length - 1) === 1 && closedRegion.includes("clearGroupBridges(g)") && closedRegion.includes("if (g.empty)"),
    `server.ts 内 ${srvTs.split("clearGroupBridges(g)").length - 1} 处;onConnectionClosed 区间含清桥=${closedRegion.includes("clearGroupBridges(g)")}`,
  );
  check(
    "clearGroupBridges 定义只在 bridgeAttach.ts(单一实现)",
    countInSrc("export function clearGroupBridges(").n === 1 &&
      code(BRIDGE_ATTACH).includes("export function clearGroupBridges("),
    `定义处 ${countInSrc("export function clearGroupBridges(").n} 个`,
  );
}

// ---------------------------------------------------------------------------
// ⑪ generation 二元组;rehost 不得动 epoch
// ---------------------------------------------------------------------------
console.log("===== ⑪ generation 必须取 epoch * 1_000_003 + timelineReseed,rehost 不得 epoch++ =====");
{
  const eng = code(SPIN_ENGINE);
  check(
    "get generation() 返回 this.epoch * 1_000_003 + this.timelineReseed(二元组解冲突)",
    /get\s+generation\(\)\s*:\s*number\s*\{\s*return\s+this\.epoch\s*\*\s*1_000_003\s*\+\s*this\.timelineReseed\s*;/.test(eng),
    "未找到 get generation() 的 epoch*1_000_003+timelineReseed 实现",
  );
  check(
    "乘法基数必须是 1_000_003(大于 timelineReseed 上限,避免 (epoch,reseed) 撞值)",
    count(eng, "* 1_000_003") === 2,
    `命中 ${count(eng, "* 1_000_003")} 次(期望 2:getter + BOUNDARY 上报)`,
  );
  check(
    "rehost 分支不得自增 epoch(否则推流循环立即退出)",
    !/rehost[\s\S]{0,400}?this\.epoch\s*(?:\+\+|\+=\s*1\b)/.test(eng),
    "rehost 附近出现 this.epoch++ / this.epoch += 1",
  );
  const ch = code(BRIDGE_CHANNEL);
  check(
    "FrameSequencer.reset 用 >>> 0 归一 generation(32 位回绕安全)",
    /this\.gen\s*=\s*generation\s*>>>\s*0\s*;/.test(ch),
    "未找到 this.gen = generation >>> 0;",
  );
}

// ---------------------------------------------------------------------------
// ⑫ RECORD 后四个锚点同域
// ---------------------------------------------------------------------------
console.log("===== ⑫ RAOP RECORD 后四锚点同域:baseTs 在列表、先 >>> 0 再 % CHUNK_LEN、禁 & 0xFFFFFFFF =====");
{
  const raop = code(RAOP);
  const bm = code(BRIDGE_MATH);
  check(
    "headTs 由 ntpToRtpMod(ntp0, sampleRate, CHUNK_LEN) 产出(唯一出处)",
    /this\.headTs\s*=\s*ntpToRtpMod\(\s*ntp0\s*,\s*this\.opts\.sampleRate\s*,\s*CHUNK_LEN\s*\)\s*;/.test(raop),
    "未找到 headTs = ntpToRtpMod(ntp0, ...)",
  );
  check(
    "四锚点同域赋值:startTs / baseTs / startNtp 都由 headTs 或 ntp0 直接派生",
    /this\.startTs\s*=\s*this\.headTs\s*;/.test(raop) &&
      /this\.baseTs\s*=\s*this\.headTs\s*;/.test(raop) &&
      /this\.startNtp\s*=\s*ntp0\s*;/.test(raop),
    "startTs/baseTs/startNtp 未与 headTs 同域赋值",
  );
  check(
    "baseTs 必须出现在 RECORD 处的赋值列表里(不得只声明不赋值/延后到别处)",
    count(raop, "this.baseTs = this.headTs;") === 1,
    `this.baseTs = this.headTs; 命中 ${count(raop, "this.baseTs = this.headTs;")} 次`,
  );
  const mod = bodyOf(bm, /export\s+function\s+ntpToRtpMod\(/);
  const iU32 = mod === null ? -1 : mod.indexOf(">>> 0");
  const iMod = mod === null ? -1 : mod.indexOf("% chunkLen");
  check(
    "ntpToRtpMod 必须先 `>>> 0`(ToUint32)再 `% chunkLen`(对齐)(顺序反了会残 32 破坏 352 对齐)",
    iU32 !== -1 && iMod !== -1 && iU32 < iMod,
    `>>> 0 位置=${iU32}, % chunkLen 位置=${iMod}`,
  );
  // 只禁「用掩码做 ToUint32 截断」。`& 0xffffffffn`(BigInt 取低 32 位,带 n 后缀)是
  // NTP 拆字段的合法用法,不在本断言范围内 —— 靠负向 lookahead 区分。
  const MASK = /&\s*0x[Ff]{8}(?![0-9a-fA-Fn])/;
  const raopMask = matchInSrc(MASK, (p) => p === RAOP);
  check(
    "raop/bridgeMath 不得用 `& 0xFFFFFFFF` 做截断(边界得 −1,负余数让对齐失效) —— 应写 `>>> 0`",
    raopMask.n === 0 && (mod === null || !MASK.test(mod)),
    `${raopMask.n} 处:${raopMask.where}`,
  );
}

// ---------------------------------------------------------------------------
// ⑬ 不得伪造 acked;上报字段名必须是 scheduledAnchorUs
// ---------------------------------------------------------------------------
console.log("===== ⑬ 不得伪造 acked,上报字段名必须是 scheduledAnchorUs =====");
{
  const acked = matchInSrc(/\backed\b/);
  check(
    "全仓不得出现 acked 字段(无 ack 诚实语义:绝不伪造设备播放确认)",
    acked.n === 0,
    `${acked.n} 处:${acked.where}`,
  );
  const bs = code(BRIDGE_SESSION);
  check(
    "bridgeSession 上报字段名为 scheduledAnchorUs",
    /scheduledAnchorUs:\s*Number\(plan\.anchorUs\)/.test(bs),
    "未找到 scheduledAnchorUs: Number(plan.anchorUs)",
  );
  // 注意:这里**不**包含 anchorUnixMs —— 那是 ⑤ 的判据。两条断言必须互不重叠,
  // 否则 ⑤ 的最小违规会把 ⑬ 一起带红,反证就无法证明「只红一条」。
  const badName = matchInSrc(/\b(?:anchorUsMs|scheduledAnchorMs|anchorMs)\b/);
  check(
    "不得用 anchorUsMs / scheduledAnchorMs / anchorMs 等毫秒口径字段名(锚点一律 µs)",
    badName.n === 0,
    `${badName.n} 处:${badName.where}`,
  );
}

// ---------------------------------------------------------------------------
// ⑭ 桥 socket 路径必须是 mfab/<短 hash>
// ---------------------------------------------------------------------------
console.log("===== ⑭ 桥 socket 路径必须是 mfab/<短 hash>(deviceId/token 不进文件名) =====");
{
  const ch = code(BRIDGE_CHANNEL);
  const sock = bodyOf(ch, /export\s+function\s+bridgeSocketPath\(/);
  check("bridgeSocketPath 存在且取其函数体", sock !== null, "未找到 bridgeSocketPath()");
  check(
    "Unix 侧路径形如 path.join(os.tmpdir(), \"mfab\", `${name}.sock`)(固定目录 + 短名)",
    sock !== null && /path\.join\(\s*os\.tmpdir\(\)\s*,\s*"mfab"\s*,\s*`\$\{name\}\.sock`\s*\)/.test(sock),
    "未找到 mfab/<name>.sock 拼接",
  );
  check(
    "短 hash 恒定 11 位 base36(sha1 前 64bit → base36 → padStart(11).slice(0,11))",
    sock !== null && /padStart\(\s*11\s*,\s*"0"\s*\)\.slice\(\s*0\s*,\s*11\s*\)/.test(sock),
    "未找到 11 位 base36 文件名生成",
  );
  // 只查**产出路径**的那条语句:sha1 的输入 `\`${deviceId}:${token}\`` 是允许的,
  // 违规的是把 deviceId/token 拼进文件名(长度泄漏 + 路径注入)。
  const pathStmt = sock === null ? "" : (sock.match(/const\s+p\s*=[\s\S]*?;\n/) || [""])[0];
  check(
    "文件名不得拼接 deviceId / token(路径只能由 hash 变量 name 组成)",
    pathStmt.length > 0 && !/\$\{\s*(?:deviceId|token)\s*\}/.test(pathStmt),
    pathStmt.length === 0
      ? "未找到 `const p = ...` 路径语句"
      : `路径语句里出现 deviceId/token 插值:${pathStmt.replace(/\s+/g, " ").slice(0, 120)}`,
  );
  check(
    "deviceId/token 只进 sha1 输入(`${deviceId}:${token}`)",
    sock !== null && /createHash\(\s*"sha1"\s*\)\.update\(\s*`\$\{deviceId\}:\$\{token\}`/.test(sock),
    "未找到 createHash(\"sha1\").update(`${deviceId}:${token}`)",
  );
  check(
    "路径长度在 bind 前断言(< 100 字节)",
    sock !== null && /Buffer\.byteLength\(\s*p\s*,\s*"utf8"\s*\)\s*>=\s*100/.test(sock),
    "未找到 100 字节长度断言",
  );
}

// ---------------------------------------------------------------------------
// ⑮ 锚点一次性(aligner 非空即不再起流)
// ---------------------------------------------------------------------------
// 2026-10-26 补:这是「改群组延迟必须重建桥」的**根因**。锚点在 RECORD 后一次算死,
// 若有人把早退改成「可以热改锚点」却忘了把旧 aligner 清掉,表现是:延迟调了没反应,
// 或者新旧锚点同时在用 → 整组缓慢飘音。两种都不报错,只有真机/示波器能看出来。
console.log("===== ⑮ 锚点一次性:aligner 非空必须早退(改延迟只能重建桥) =====");
{
  const bs = code(BRIDGE_SESSION);
  check(
    "maybeBeginStream 保留锚点一次性守卫:if (this.aligner !== null) return;",
    count(bs, "if (this.aligner !== null) return;") === 1,
    `命中 ${count(bs, "if (this.aligner !== null) return;")} 次(应恰好 1)`,
  );
  const ctor = countInSrc("new BridgeTimelineAligner(");
  check(
    "BridgeTimelineAligner 全仓只在一处被创建(锚点只落一次,不存在第二套对齐器)",
    ctor.n === 1,
    `创建点 ${ctor.n} 处:${ctor.where}`,
  );
}

// ---------------------------------------------------------------------------
// ⑯ 群延迟补偿只有一个落点
// ---------------------------------------------------------------------------
// 2026-10-26 补:按组 A/V 延迟补偿落地后,这个偏移**只能**加在锚点算术里(:209)。
// 若同时在 sendspin 侧也加 anchorShift(或 airplay 侧也加 dspDelay),同一偏移会被
// 两头各加一次 = 双倍补偿,表现是「调 100ms 实际偏 200ms」,用户只会觉得"这功能不准"。
console.log("===== ⑯ 群延迟补偿只有一个落点(firstFrameTsUs + anchorShiftUs) =====");
{
  const bs = code(BRIDGE_SESSION);
  check(
    "planBridgeAnchor 内锚点 = opts.firstFrameTsUs + BigInt(opts.anchorShiftUs ?? 0)",
    /let\s+anchorUs\s*=\s*opts\.firstFrameTsUs\s*\+\s*BigInt\(\s*opts\.anchorShiftUs\s*\?\?\s*0\s*\)/.test(bs),
    "未找到 `let anchorUs = opts.firstFrameTsUs + BigInt(opts.anchorShiftUs ?? 0)` —— 补偿落点被改/被删",
  );
  const inSpin = matchInSrc(/anchorShift/i, (p) => p.startsWith(`${SRC}/services/sendspin/`));
  const inAirplay = matchInSrc(/dspDelay/i, (p) => p.startsWith(`${SRC}/services/airplay/`));
  check(
    "同一偏移不得两头各加一次(sendspin/** 无 anchorShift,airplay/** 无 dspDelay)",
    inSpin.n === 0 && inAirplay.n === 0,
    `sendspin 侧 anchorShift=${inSpin.n} 处(${inSpin.where});airplay 侧 dspDelay=${inAirplay.n} 处(${inAirplay.where})`,
  );
}

// ---------------------------------------------------------------------------
// ⑰ RAOP 重连退避必须双层封顶
// ---------------------------------------------------------------------------
// 2026-10-26 补:退避公式少一层 clamp 都不会报错 —— 指数项不封顶 = 设备离线久了重连间隔
// 指数爆炸(等于永不重连,用户看到的是"设备回来也不自动恢复");抖动项不封顶 = 实际间隔
// 超上限 ±20%(2026-10-23 桥队列被打满 → 重连风暴的直接成因之一)。
console.log("===== ⑰ RAOP 重连退避必须双层封顶(指数项与抖动项都 clamp) =====");
{
  const bsSrc = code(`${SRC}/services/airplay/bridgeSource.ts`);
  check(
    "退避 = min(maxMs, base·2^(n-1)) 再 min(maxMs, exp·jitter)(两层都封顶)",
    /Math\.min\(\s*maxMs\s*,\s*baseMs\s*\*\s*2\s*\*\*\s*\(\s*n\s*-\s*1\s*\)\s*\)/.test(bsSrc) &&
      /Math\.min\(\s*maxMs\s*,\s*exp\s*\*\s*jitter\s*\)/.test(bsSrc),
    "退避封顶缺失:base·2^(n-1) 无上限 ⇒ 重连间隔指数爆炸(等于永不重连)",
  );
  const rates = code(RATES);
  const decl = countInSrc("BRIDGE_BACKOFF_MAX_MS =");
  const pinned = /export\s+const\s+BRIDGE_BACKOFF_MAX_MS\s*=\s*30_000\s*;/.test(rates);
  check(
    "BRIDGE_BACKOFF_MAX_MS = 30_000 且全仓只声明一次",
    pinned && decl.n === 1,
    `rates.ts 声明=${pinned} 全仓声明 ${decl.n} 处(${decl.where})`,
  );
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n[AirPlay 桥接守卫] FAIL:${failures.length} 项`);
  for (const f of failures) console.error("  · " + f);
  process.exit(1);
}
console.log("\n[AirPlay 桥接守卫] 17 条全部通过");
