#!/usr/bin/env node
// ==================== 群组(Groups)不变量静态守卫(G1–G15) ====================
//
// 背景:群组是「多台设备共用同一条内容时间线」的唯一载体,它踩过的坑**全是静默的** ——
// 不报错、不崩溃、既有用例也全绿,只表现为「听着不对 / 点了没反应」:
//   · 成员 id 被剥掉 `dlna:` 前缀落库 → 服务端按裸 id 比对,前端再删就 no-op(成员删不掉);
//   · DLNA 设备混进组 → 设备自拉流、组内没有共享时间线,听着就是「两台机器各放各的」;
//   · 组播中加入新成员「先起播再 seek」→ AirPlay 单会话设备永久等待(2026-10-21 真机);
//   · 成员位置用「会话已过时长/墙钟」推 → 一次卡顿就永久偏移,越放越不同步;
//   · 桥(或任何第二条泵)自己选歌推进 → 双泵抢队列,表现是随机跳曲/整组卡住;
//   · 组内无限换源 → 一首放不出来就整组循环重试,永不收敛;
//   · 延迟补偿写进 ring 的 tsUs → 桥投递窗口/水位/late-join 回填一起被带偏(整组飘音);
//   · watchdog 绕过统一起播路径 → 起点丢失 / 重复 cast;
//   · 内容同步埋点被删 → 回到「只能靠耳朵调参数」的盲调时代;
//   · 延迟参数域散落硬编码 → 前端标 ±30s、后端偷偷 ±2000,用户看到的值≠生效值;
//   · 延迟写进 PlayerGroup 实体会被 persist 的整行 upsert 冲回 0(改名/调音量即丢)。
// 本守卫把上面 11 条固化成 G1–G11 静态不变量,CI 里直接失败。
//
// 🔴 硬性要求 1:**只认非注释行**。源码里大量「⚠️ 不得出现 XXX」的说明性注释,直接对原文
//    做正则会被自己的注释查红,故一律先过 `lib/strip-comments.mjs` 的 stripComments()
//    (字符串感知:跳过 ' " ` 三种字面量与反斜杠转义,再剥 // 与 /* */)。
//
// 🔴 硬性要求 2:断言只锚「唯一的表达式前缀」,**绝不锚参数个数/闭括号**。
//    2026-10-26 教训:check-airplay-playback-chain.mjs 把 `playCurrent(deviceId, baseUrl)`
//    连闭括号一起钉死,实现改成 4 个参数后守卫假红、main ci 连挂两轮。本脚本因此不写任何
//    含参数表的签名:一律「函数名 + 圆括号配平跳过参数表 + 花括号配平取体」,参数怎么改都不假红。
//
// 🔴 硬性要求 3:与现实冲突的不变量**不改代码**,登记为 TODO 缺口 —— 输出可见、不阻断 CI,
//    免得「守卫红了但没人敢改」;缺口清单在末尾汇总,便于一次性排期。
//
// G1–G12:
//   G1 成员命名空间原样透传(setMembers 不得改写成员 id;splitMemberId 仍认 dlna:/裸 id,
//      但「含冒号的未知前缀」必须返回 null,不得落进裸 id 兜底 —— 否则报错误导成 DLNA)
//   G2 DLNA 不得入组(后端 kind allowlist 必须存在 + 前端候选只拼 airplay:/sendspin:)
//   G3 起播即落位(AirPlay 新成员起点编进本次 cast 的 startMs,绝不事后校准 seek;
//      DLNA 路径的「cast 后校准 seek」= 2026-10-26 已裁定例外,不要当 bug 去"修")
//   G4 成员位置基准取真实内容时间线(getGroupStatus),不得用墙钟/会话时长推算
//   G5 单泵(pushFrame 唯一出流入口;桥侧不得自建选歌/判死分支)
//   G6 组内换源上限 3 + 负缓存 TTL 统一(markUnplayable 读 negativeTtlSeconds 配置,默认 2 小时)
//   G7 ring 的 tsUs 不得被延迟补偿污染(偏移只加在成员下发戳)
//   G8 watchdog 悬挂→恢复必须走统一起播路径(resumeActive → playCurrent)
//   G9 内容同步 tick 的权威判据字段仍在(删了就回盲调)
//   G10 延迟补偿参数域单一定义 + 写入必经 clamp + AirPlay 变更必须重建组桥
//   G11 延迟只在读视图,不得进 PlayerGroup 实体 / persist
//   G12 重复成员语义刻意分叉:全量口 throw / 增量口 no-op(别被「统一」掉)
//
// 零依赖 node 脚本,挂 ci.yml 的守卫 job(与既有 check-*.mjs 同构)。
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = "backend/src";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
/** 读源码并**剥注释**(剥离后才允许匹配 —— 见文件头硬性要求 1)。 */
const code = (rel) => stripComments(read(rel));
const count = (hay, needle) => hay.split(needle).length - 1;

/** 递归收集 backend/src 下的 .ts。 */
function walkTs(dirAbs, out = []) {
  for (const e of readdirSync(dirAbs, { withFileTypes: true })) {
    const p = join(dirAbs, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p);
/** 预先剥离全部源码注释(全仓扫描用;只算一次)。 */
const SRC_STRIPPED = walkTs(join(ROOT, SRC))
  .filter((p) => !p.endsWith(".test.ts"))
  .map((p) => ({ path: rel(p), code: stripComments(read(rel(p))) }));

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
 * 按「名字 + `(`」定位一个函数/方法体。
 * ① 圆括号配平**跳过整个参数表**;② 跳过返回类型注解(形如 `: Promise<void>`,或
 * `: { a: string } | undefined` —— 后者里的 `{` 前一非空白字符是 `:` ⇒ 判为类型字面量整体跳过);
 * ③ 花括号配平取体。
 * 参数个数/类型怎么变都不会假红(硬性要求 2 的落地方式)。
 */
function bodyByName(text, nameRe) {
  const m = nameRe.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length; // 指向 `(` 之后
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
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === "{") {
      let j = i - 1;
      while (j >= 0 && /\s/.test(text[j])) j -= 1;
      if (text[j] === ":" || text[j] === "<") {
        const skip = sliceBraces(text, i); // 返回类型里的对象字面量类型(`Promise<{ ... }>` 由 `<` 命中)
        if (!skip) return null;
        i += skip.length;
        continue;
      }
      return sliceBraces(text, i);
    }
    if (c === ";" || c === "=") return null; // 命中的是调用点/赋值,不是定义
    i += 1;
  }
  return null;
}

/** 按「声明头部」定位一个 `{}` 块体(interface / 计算属性用;不含参数表)。 */
function bodyByHead(text, headRe) {
  const m = headRe.exec(text);
  if (!m) return null;
  const open = text.indexOf("{", m.index + m[0].length);
  if (open === -1) return null;
  return sliceBraces(text, open);
}

/** 从 marker 起截到第一个 endMarker(取「一段路由定义」用;不依赖括号形态)。 */
function sliceBetween(text, startMarker, endMarker) {
  const i = text.indexOf(startMarker);
  if (i === -1) return null;
  const j = text.indexOf(endMarker, i + startMarker.length);
  return text.slice(i, j === -1 ? text.length : j);
}

/** 方法/导出函数的名字锚:要求名字是行首首个标识符(允许前置修饰符),避免命中 `xx.foo(` 调用点。 */
const atLineStart = (name) =>
  new RegExp(`(?:^|\\n)[ \\t]*(?:(?:private|public|protected|static|async|export|function)\\s+)*${name}\\s*\\(`);

const failures = [];
const todos = [];
const exceptions = [];
let passed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}
/** 登记「不变量与现状冲突」:不改代码、不阻断 CI,但必须在 CI 日志里可见。 */
function todo(id, name, why) {
  todos.push(`${id} ${name}`);
  console.log(`  ⚠ TODO 缺口 ${id} ${name}`);
  console.log(`      现状:${why}`);
}
/**
 * 登记「已裁定例外」:与不变量口径有差异,但**已由产品/架构裁定保留现状**。
 * 与 todo() 的区别:todo 是"待修的真缺口",exception 是"明确不要修" ——
 * 单独打 ⊘ 标记,避免后人看到不变量与代码不符就当 bug 去改,把能用的路径改坏。
 */
function exception(id, name, ruling) {
  exceptions.push(`${id} ${name}`);
  console.log(`  ⊘ 已裁定例外 ${id} ${name}`);
  console.log(`      裁定(2026-10-26):${ruling}`);
}
const miss = (label) => `未找到 ${label}(实现改名/迁移?请同步本条断言)`;

const GROUP_INDEX = "backend/src/services/group/index.ts";
const DELAY_CALIB = "backend/src/services/group/delayCalib.ts";
const API_GROUPS = "backend/src/routes/api/groups.ts";
const AIRPLAY_CONTROL = "backend/src/services/airplay/control.ts";
const GROUP_WATCHDOG = "backend/src/services/group/watchdog.ts";
const QUEUE_CTL = "backend/src/services/player/QueueController.ts";
const SPIN_SERVER = "backend/src/services/sendspin/server.ts";
const SPIN_CORE = "backend/src/services/sendspin/playerCore.ts";
const BRIDGE_SESSION = "backend/src/services/airplay/bridgeSession.ts";
const PREFETCH = "backend/src/services/source/prefetchCache.ts";
const FALLBACK = "backend/src/services/source/online/streamFallback.ts";
const BFETCH = "backend/src/services/source/bufferedFetch.ts";
const GROUP_PROTOCOL_PLAYER = "backend/src/services/group/protocolPlayer.ts";
const SPIN_BRIDGE_ATTACH = "backend/src/services/sendspin/bridgeAttach.ts";
const SPIN_STREAM_ENGINE = "backend/src/services/sendspin/streamEngine.ts";
const SPIN_IPC = "backend/src/services/sendspin/ipcProtocol.ts";
const SPIN_SUPERVISOR = "backend/src/services/sendspin/supervisor.ts";
const SPIN_CHILD_MAIN = "backend/src/services/sendspin/childMain.ts";
const SPIN_INDEX = "backend/src/services/sendspin/index.ts";
const GROUPS_VUE = "frontend/src/views/Groups/index.vue";

// ===========================================================================
// G1 成员命名空间原样透传
// ===========================================================================
console.log("===== G1 成员命名空间原样透传(前缀不得被吞掉) =====");
{
  const gi = code(GROUP_INDEX);
  const setB = bodyByName(gi, atLineStart("setMembers"));
  check(
    "setMembers 把成员 id 原样写回(不做 strip/slice/replace 改写)",
    setB !== null &&
      /g\.memberIds\s*=\s*\[\s*\.\.\.memberIds\s*\]/.test(setB) &&
      count(setB, ".slice(") === 0 &&
      count(setB, ".replace(") === 0 &&
      count(setB, 'startsWith("dlna:")') === 0,
    setB === null
      ? miss("setMembers")
      : `改写痕迹:slice=${count(setB, ".slice(")} replace=${count(setB, ".replace(")} 剥dlna前缀=${count(setB, 'startsWith("dlna:")')}`,
  );
  const deltaB = bodyByName(gi, atLineStart("applyMemberDelta"));
  check(
    "applyMemberDelta 同样原样透传成员 id(增量口与全量口口径一致)",
    deltaB !== null && count(deltaB, ".slice(") === 0 && count(deltaB, ".replace(") === 0,
    deltaB === null
      ? miss("applyMemberDelta")
      : `改写痕迹:slice=${count(deltaB, ".slice(")} replace=${count(deltaB, ".replace(")}`,
  );
  const splitB = bodyByName(gi, atLineStart("splitMemberId"));
  check(
    'splitMemberId 仍解析 `dlna:` 前缀,并保留「裸 id ≡ DLNA」的历史口径',
    splitB !== null &&
      splitB.includes('startsWith("dlna:")') &&
      /return\s*\{\s*kind:\s*"dlna",\s*id:\s*m\s*\}/.test(splitB),
    splitB === null ? miss("splitMemberId") : "老成员(裸 id / dlna: 写法)会解析成 null ⇒ 组恒显示全员离线",
  );
  // 2026-10-27 新增(工程师 B 落地 splitMemberId 未知命名空间判定后):
  // 历史口径只豁免**裸 id**(不含冒号)。含冒号但没命中已知前缀的 `foo:xxx` 属于「未知命名空间」,
  // 必须返回 null —— 若落进裸 id 兜底会被当成 DLNA,用户看到的报错是「DLNA 设备不支持加入群组」,
  // 排障会一路往 DLNA 方向查(实际是前缀写错/新协议没注册)。这条守的是**报错理由的可诊断性**。
  // 判据不锚变量名与 includes/indexOf 写法:取「dlna 分支之后、裸 id 兜底之前」的那一段,
  // 段内必须既有「冒号判定」又有 `return null` —— 顺序错了(兜底在前)则该段为空,同样会红。
  {
    const dlnaAt = splitB === null ? -1 : splitB.indexOf('startsWith("dlna:")');
    const fallbackAt = splitB === null ? -1 : splitB.indexOf('return { kind: "dlna", id: m }');
    const between = dlnaAt !== -1 && fallbackAt > dlnaAt ? splitB.slice(dlnaAt, fallbackAt) : "";
    const hasColonProbe = /includes\(\s*":"\s*\)|indexOf\(\s*":"\s*\)/.test(between);
    const returnsNull = /return\s+null\s*;/.test(between);
    check(
      "含冒号的未知前缀(如 foo:xxx)返回 null,不得落进裸 id 兜底(否则报错误导成「DLNA 设备不支持入组」)",
      splitB !== null && hasColonProbe && returnsNull,
      splitB === null
        ? miss("splitMemberId")
        : `dlna 分支与裸 id 兜底之间:冒号判定=${hasColonProbe} return null=${returnsNull}` +
          (hasColonProbe || returnsNull ? "" : " —— 未知命名空间被当 DLNA,排障方向被带偏"),
    );
  }
  todo(
    "G1",
    "「airplay:/sendspin:/dlna: 前缀常量只有一处定义」",
    '仓库里没有前缀常量:`"airplay:"` / `"sendspin:"` / `"dlna:"` 字面量散落在 peer.ts(parse)、' +
      "QueueController.stripPlayerPrefix、playTarget.ts、playerRate.ts、group/index.ts(splitMemberId) 等 ≥8 处。" +
      "真实风险=改前缀要改 8 处且无任何编译错误;属重构(抽 peerId.ts),不在本轮守卫范围 —— " +
      "本轮只钉「不做破坏性改写」这一可观测行为。",
  );
}

// ===========================================================================
// G2 DLNA 不得入组
// ===========================================================================
console.log("===== G2 DLNA 不得入组(后端 kind allowlist 必须存在 + 前端候选过滤) =====");
{
  // ⚠️ 本条按**目标状态**写:服务端侧 kind allowlist 正在由另一路工程师落到 setMembers/校验函数上。
  // 断言刻意钉在「校验处必须按 kind 放行 sendspin/airplay、其余一律 throw」——只钉前端过滤是不够的
  // (API 直调能绕过前端),所以前端那条是**附加**而不是替代。
  const gi = code(GROUP_INDEX);
  const assertB =
    bodyByName(gi, atLineStart("assertMembersAvailable")) ||
    bodyByName(gi, atLineStart("assertMembersAllowed"));
  check(
    "服务端成员校验有 kind allowlist:sendspin/airplay 放行,DLNA(含历史裸 id)与未知前缀一律拒收",
    assertB !== null &&
      assertB.includes('split.kind === "sendspin"') &&
      assertB.includes('split.kind === "airplay"') &&
      /throw\s+new\s+Error\(/.test(assertB),
    assertB === null
      ? miss("assertMembersAvailable / assertMembersAllowed")
      : "缺 kind allowlist ⇒ DLNA(自拉流、无共享时间线)可被 API 直调写进组,表现是「两台机器各放各的」",
  );
  // G2a:DLNA 分支必须**抛错拒收**。改成 return / continue / 只 log 都不会让任何用例变红,
  // 但 API 直调立刻能把 DLNA 塞进组 —— 这类「防线降级成告警」是最典型的静默回归。
  // ⚠️ 不能只搜「body 里有提到 DLNA 的 throw」:本函数里 `成员 ${m} 不是 DLNA 设备` 那条
  //    也是 throw,会把这里查绿。判据改成「airplay 分支之后(即真正落到 DLNA 兜底的位置)
  //    仍必须是一条 throw」——与错误文案措辞无关。
  const afterAirplay = assertB === null ? "" : assertB.slice(assertB.lastIndexOf("continue;"));
  const dlnaThrow = /throw\s+new\s+Error\(/.test(afterAirplay);
  const dlnaPassThrough =
    /kind\s*===\s*"dlna"\s*\)\s*\{?\s*(return|continue)/.test(assertB || "") || /^\s*return;/m.test(afterAirplay);
  check(
    "DLNA 分支是 throw 拒收(不得降级成 return/continue/只打日志放行)",
    assertB !== null && dlnaThrow && !dlnaPassThrough,
    assertB === null
      ? miss("assertMembersAvailable")
      : `airplay 分支之后仍有 throw=${dlnaThrow} 放行分支=${dlnaPassThrough}`,
  );
  // G2b:两个写入口都必须过同一个校验。少一个就是后门:
  //   POST /v1/groups/:id/members {add:["dlna:x"]} 走 applyMemberDelta,PATCH 全量走 setMembers。
  const setB2 = bodyByName(gi, atLineStart("setMembers"));
  const deltaB2 = bodyByName(gi, atLineStart("applyMemberDelta"));
  const setGuard = setB2 !== null && count(setB2, "assertMembersAvailable(") >= 1;
  const deltaGuard = deltaB2 !== null && count(deltaB2, "assertMembersAvailable(") >= 1;
  check(
    "两个写入口(setMembers 全量 / applyMemberDelta 增量)都必须调成员校验",
    setGuard && deltaGuard,
    `setMembers=${setGuard} applyMemberDelta=${deltaGuard} —— 缺任一个即可用另一个口把 DLNA 塞进组`,
  );
  const vue = stripComments(read(GROUPS_VUE));
  const candSeg = sliceBetween(vue, "const selectableDevices", "\n});");
  check(
    "前端候选只由 airplay:/sendspin: 两个数据源拼装(不并入 DLNA 设备)",
    candSeg !== null &&
      candSeg.includes("`airplay:${") &&
      candSeg.includes("`sendspin:${") &&
      count(candSeg, "dlna:") === 0,
    candSeg === null
      ? miss("selectableDevices 计算属性")
      : `候选里出现 dlna: 前缀 ${count(candSeg, "dlna:")} 处 ⇒ 用户能把 DLNA 勾进组`,
  );
}

// ===========================================================================
// G3 起播即落位
// ===========================================================================
console.log("===== G3 起播即落位(AirPlay 侧禁止先起播再 seek;DLNA 校准 seek 属已裁定例外) =====");
{
  const qc = code(QUEUE_CTL);
  const apB = bodyByName(qc, atLineStart("rejoinMembersAirplay"));
  check(
    "组播中新增 AirPlay 成员:起点经 startMs 一次性编进本次 cast",
    apB !== null && /playMedia\(\s*fullItem,\s*baseUrl,\s*startMs/.test(apB),
    apB === null ? miss("rejoinMembersAirplay") : "未见 playMedia(fullItem, baseUrl, startMs)",
  );
  check(
    "同一路径不得事后校准 seek(否则 AirPlay 单会话设备永久等待)",
    apB !== null && count(apB, "alignDeviceToPosition") === 0 && count(apB, ".seek(") === 0,
    apB === null
      ? miss("rejoinMembersAirplay")
      : `事后 seek 痕迹:alignDeviceToPosition=${count(apB, "alignDeviceToPosition")} .seek(=${count(apB, ".seek(")}`,
  );
  check(
    "startMs 由 leader 当前落点换算(而不是从 0 起播后慢慢追)",
    apB !== null && /Math\.round\(\s*position\s*\*\s*1000\s*\)/.test(apB),
    apB === null ? miss("rejoinMembersAirplay") : "未见 Math.round(position * 1000)",
  );
  todo(
    "G3",
    "「castLanding.applied 语义」的命名",
    "全仓没有 castLanding 这个符号(0 命中)。本条不变量的现等价物 = rejoinMembers…() 里的 " +
      "`startMs` / `landed`:「起点真编进这次 cast」由上面的 startMs 断言钉住,「cast 成功」由 " +
      "try/catch 内 playMedia 抛错即整成员跳过 + 逐成员日志体现。",
  );
  exception(
    "G3",
    "DLNA 路径「先起播再校准 seek」(AirPlay 路径仍必须 startMs 一次编入)",
    "DLNA 渲染器在 cast 后**立刻** seek 会静默失效(实测 HiVi/多台 DLNA),所以 rejoinMembers(DLNA) 与 " +
      "group/watchdog 的恢复走「playMedia 不带 startMs → 等稳定 PLAYING → alignDeviceToPosition 按实时位置收敛」。\n" +
      "      裁定:保留为**显式例外**,不得为了「统一」而把 DLNA 改成 startMs(会把能用的路径改坏)。\n" +
      "      边界:AirPlay 侧不受此例外豁免 —— 见上面两条(AirPlay 必须 startMs 一次编入、且不得事后 seek)。",
  );
}

// ===========================================================================
// G4 成员位置基准
// ===========================================================================
console.log("===== G4 成员位置基准取真实内容时间线(不得用墙钟/会话时长推算) =====");
{
  const qc = code(QUEUE_CTL);
  const bodies = [
    ["rejoinMembersAirplay", bodyByName(qc, atLineStart("rejoinMembersAirplay"))],
    ["rejoinMembers", bodyByName(qc, atLineStart("rejoinMembers"))],
  ];
  let bad = "";
  for (const [n, b] of bodies) {
    if (b === null) bad += `${n}:未找到; `;
    else if (count(b, "getGroupStatus(") === 0) bad += `${n}:未取 getGroupStatus; `;
    else if (count(b, "Date.now()") > 0 || count(b, "performance.now()") > 0) bad += `${n}:用了墙钟; `;
  }
  check(
    "两条「新增成员对齐」路径的位置都取自 getGroupStatus(leader 真实落点),且体内无墙钟",
    bad === "",
    bad,
  );
  todo(
    "G4",
    "「位置基准必须取 contentClock」",
    "全仓没有 contentClock 这个抽象(0 命中)。现实基准 = leader 的 getGroupStatus().position" +
      "(组状态派生自 leader 的实时位置)。断言按其**意旨**落成「不得用 Date.now()/会话时长推算」;" +
      "若将来引入 contentClock,应把本条断言改指向它。",
  );
}

// ===========================================================================
// G5 单泵
// ===========================================================================
console.log("===== G5 单泵(pushFrame 唯一出流入口;桥侧不得自建选歌路径) =====");
{
  const defs = countInSrc("async pushFrame(");
  check("pushFrame 全仓只有一处定义(第二条出流泵 = 双泵抢队列)", defs.n === 1, `实际 ${defs.n} 处:${defs.where}`);
  const calls = countInSrc("g.pushFrame(");
  const core = code(SPIN_CORE);
  check(
    "pushFrame 的唯一调用点是 playerCore 的 g.pushFrame(cursor…",
    calls.n === 1 && /g\.pushFrame\(\s*cursor/.test(core),
    `调用点 ${calls.n} 处(${calls.where});playerCore 内未见 g.pushFrame(cursor`,
  );
  const BRIDGE_FILES = [
    "backend/src/services/airplay/bridgeCalib.ts",
    "backend/src/services/airplay/bridgeChannel.ts",
    "backend/src/services/airplay/bridgeMath.ts",
    "backend/src/services/airplay/bridgeServer.ts",
    "backend/src/services/airplay/bridgeSession.ts",
    "backend/src/services/airplay/bridgeSource.ts",
    "backend/src/services/sendspin/bridgeAttach.ts",
    "backend/src/services/sendspin/bridgeMember.ts",
  ];
  const banned = ["resolvePreferredSong", "judgePrefetchedBuffer", "markUnplayable"];
  const hits = [];
  for (const f of BRIDGE_FILES) {
    const c = code(f);
    for (const b of banned) if (count(c, b) > 0) hits.push(`${f}:${b}`);
  }
  check(
    "桥侧不得自建第二条选歌/判死路径(resolvePreferredSong / judgePrefetchedBuffer / markUnplayable 均 0 处)",
    hits.length === 0,
    `命中:${hits.join(", ")}`,
  );
}

// ===========================================================================
// G6 组内换源上限 + 判死负缓存
// ===========================================================================
console.log("===== G6 组内换源上限 3 + 负缓存 TTL 统一(默认 2 小时,可配) =====");
{
  const pf = code(PREFETCH);
  const declN = countInSrc("PREFETCH_MAX_ALT_SOURCES =");
  const prefOk = /export\s+const\s+PREFETCH_MAX_ALT_SOURCES\s*=\s*3\s*;/.test(pf);
  check(
    "PREFETCH_MAX_ALT_SOURCES = 3 且全仓只声明一次(上限一旦放开=整组在坏源上无限换)",
    prefOk && declN.n === 1,
    `prefetchCache 声明=${prefOk} 全仓声明 ${declN.n} 处(${declN.where})`,
  );
  const fb = code(FALLBACK);
  const ttlN = countInSrc("MARK_UNPLAYABLE_TTL_MS");
  check(
    "MARK_UNPLAYABLE_TTL_MS 已废除(2026-10-27 统一:内容型判死与探测型负缓存读同一份 negativeTtlSeconds 配置,不再固定 5 分钟)",
    ttlN.n === 0,
    `全仓仍声明 ${ttlN.n} 处(${ttlN.where}) ⇒ 两套 TTL 会再度分叉`,
  );
  const negOk = /const\s+NEGATIVE_TTL_DEFAULT_MS\s*=\s*2\s*\*\s*60\s*\*\s*60\s*\*\s*1000\s*;/.test(fb);
  check(
    "NEGATIVE_TTL_DEFAULT_MS = 2 小时(与 core-pre-probe negativeTtlSeconds 默认 7200 对齐)",
    negOk,
    `streamFallback 声明=${negOk} ⇒ 模块默认必须与插件默认一致,否则插件未配置时回落出两套口径`,
  );
  const muOk = /opts\.ttlMs : negativeTtlMs/.test(fb);
  check(
    "markUnplayable 默认 TTL 走 negativeTtlMs(跟随插件配置,过期自动复活)",
    muOk,
    `streamFallback 声明=${muOk} ⇒ markUnplayable 脱离配置会回到固定 TTL`,
  );
}

// ===========================================================================
// G7 ring 的 tsUs 不得被延迟补偿污染
// ===========================================================================
console.log("===== G7 延迟补偿只作用于成员下发戳(ring 时间基准不动) =====");
{
  const sv = code(SPIN_SERVER);
  const pushB = bodyByName(sv, atLineStart("pushFrame"));
  const ringLines = pushB === null ? [] : pushB.split("\n").filter((l) => l.includes("ring.push("));
  const dirty = ringLines.filter((l) => /dspDelay|DelayUs/.test(l));
  check(
    "ring 写入行(ring.push({ tsUs: … }))内不得出现 dspDelay/DelayUs",
    pushB !== null && ringLines.length > 0 && dirty.length === 0,
    pushB === null
      ? miss("pushFrame")
      : ringLines.length === 0
        ? "pushFrame 内未见 ring.push( —— 回填缓存被删/搬家?"
        : `污染行:${dirty.join(" | ").slice(0, 160)}`,
  );
  check(
    "成员下发戳是唯一加偏移的地方:sendAudio(ts + this.sendspinDelayUsOf(c.clientId)",
    pushB !== null && /sendAudio\(\s*ts\s*\+\s*this\.sendspinDelayUsOf\(c\.clientId/.test(pushB) && !/ts\s*\+\s*dspDelayUs/.test(pushB),
    pushB === null ? miss("pushFrame") : "未见按成员偏移 sendAudio(ts + sendspinDelayUsOf(...) —— 偏移没生效或动了 ring 基准",
  );
  const lateLine = sv.split("\n").filter((l) => l.includes("sendAudio(it.tsUs"));
  check(
    "late-join 回填同口径:sendAudio(it.tsUs + dspDelayUs",
    /sendAudio\(\s*it\.tsUs\s*\+\s*dspDelayUs/.test(sv) && lateLine.every((l) => l.includes("dspDelayUs")),
    lateLine.length === 0
      ? "未见 sendAudio(it.tsUs …) —— late-join 回填被删/改名"
      : "回填未加偏移 ⇒ 新入组成员比老成员早/晚 dspDelayUs,恒不同步",
  );
}

// ===========================================================================
// G8 watchdog 走统一起播路径
// ===========================================================================
console.log("===== G8 watchdog 悬挂→恢复必须走统一起播路径(resumeActive → playCurrent) =====");
{
  const wd = code(GROUP_WATCHDOG);
  check(
    "组 watchdog 的恢复入口是 qc.resumeActive(统一入口)",
    /qc\.resumeActive\(/.test(wd),
    "未见 qc.resumeActive( —— 看门狗自己起播会丢起点/重复 cast",
  );
  const qc = code(QUEUE_CTL);
  const rB = bodyByName(qc, atLineStart("resumeActive"));
  check(
    "resumeActive 的起播路径是 this.playCurrent(deviceId, baseUrl…",
    rB !== null && /this\.playCurrent\(\s*deviceId,\s*baseUrl/.test(rB),
    rB === null ? miss("resumeActive") : "未走 playCurrent ⇒ 恢复不经过取源/桥挂载/优化窗口",
  );
  check(
    "watchdog 不得绕过统一入口直接 playCurrent",
    count(wd, "playCurrent") === 0,
    `watchdog 内出现 playCurrent ${count(wd, "playCurrent")} 处`,
  );
}

// ===========================================================================
// G9 内容同步 tick 埋点
// ===========================================================================
console.log("===== G9 内容同步 tick 埋点仍在(删了就回盲调) =====");
{
  const bs = code(BRIDGE_SESSION);
  const tickB = bodyByName(bs, atLineStart("emitStatsTick"));
  check(
    'tick 事件仍在(ev:"tick"),且 clock 恒 local-rtp-ntp(同源 host 单调钟)',
    tickB !== null && /ev:\s*"tick"/.test(tickB) && /clock:\s*"local-rtp-ntp"/.test(tickB),
    tickB === null ? miss("emitStatsTick") : "未见 ev:tick 或 clock:local-rtp-ntp",
  );
  const need = [
    ["deltaUs(锚点偏移 ≈ L+队列+在途)", /\bdeltaUs[,:]\s/],
    ["deltaP95Us(偏移 P95)", /\bdeltaP95Us[,:]\s/],
    ["driftUs(对齐残差)", /\bdriftUs[,:]\s/],
    ["late(lead 不足计数)", /\blate[,:]\s/],
    ["queueMs(桥缓冲深度)", /\bqueueMs[,:]\s/],
    ["state(桥状态机 live/paused/connected/listening)", /\bstate[,:]\s/],
    ["gen(内容代次)", /\bgen[,:]\s/],
  ];
  const missing = tickB === null ? need.map(([n]) => n) : need.filter(([, re]) => !re.test(tickB)).map(([n]) => n);
  check(
    "tick 仍带全部内容同步判据(deltaUs/deltaP95Us/driftUs/late/queueMs/state/gen)",
    tickB !== null && missing.length === 0,
    tickB === null ? miss("emitStatsTick") : `缺字段:${missing.join("、")}`,
  );
  todo(
    "G9",
    "「`[airplay-bridge] stats` 的 w/m/clock/delta 四字段」",
    "该口径与现状不符:`[airplay-bridge] stats` 这个 tag **不存在**(0 命中),也没有 w/m 字段。" +
      '现在的等价物是每 2s 一条 `ev:"tick"` JSON:clock(时钟源)/deltaUs(偏移)/deltaP95Us/driftUs/' +
      "late/queueMs(maxQueueMs)/state/gen。本守卫改为钉这一组真实字段;若确实需要 w(written frontier)/" +
      "m(max queue) 这类简写,应由产品侧确认后新增埋点,不由守卫凭空造。",
  );
}

// ===========================================================================
// G10 延迟补偿参数域
// ===========================================================================
console.log("===== G10 延迟补偿参数域(±30s / 步进 10ms 单一源 + 写入必经 clamp) =====");
{
  const dc = code(DELAY_CALIB);
  const pin = (name, lit) => {
    const decl = `${name} =`;
    const n = countInSrc(decl);
    const declared = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*${lit}\\s*;`).test(dc);
    check(
      `${name} = ${lit} 且全仓只声明一次`,
      declared && n.n === 1,
      `delayCalib 声明=${declared} 全仓声明 ${n.n} 处(${n.where})`,
    );
  };
  pin("GROUP_DELAY_MIN_MS", "-30000");
  pin("GROUP_DELAY_MAX_MS", "30000");
  pin("GROUP_DELAY_STEP_MS", "10");
  const cgB = bodyByName(code(GROUP_INDEX), atLineStart("createGroup"));
  check(
    "createGroup 不得播种延迟(300ms 对齐点已取消 ⇒ 新组默认全 0,成员各自设值)",
    cgB !== null && count(cgB, "setGroupDelays") === 0 && count(cgB, "DEFAULT_AIRPLAY_ALIGN_MS") === 0,
    cgB === null ? miss("createGroup") : "createGroup 播种延迟 ⇒ 新组成员被静默带上默认偏移",
  );
  const setB = bodyByName(dc, atLineStart("setMemberDelay"));
  check(
    "setMemberDelay 取值必经 clampGroupDelayMs(绕过即把越界值写进内存+DB)",
    setB !== null &&
      count(setB, "clampGroupDelayMs(") >= 1,
    setB === null
      ? miss("setMemberDelay")
      : `clamp 调用 ${setB === null ? 0 : count(setB, "clampGroupDelayMs(")} 处(应 ≥1)`,
  );
  const api = code(API_GROUPS);
  const putSeg = sliceBetween(api, 'app.put("/v1/groups/:id/delays"', 'app.delete("/v1/groups/:id"');
  check(
    "PUT /v1/groups/:id/delays 经 setMemberDelay,且 AirPlay 成员值变化时重建该组桥(补偿随桥会话建立锚定,不重建=调了没反应)",
    putSeg !== null && putSeg.includes("setMemberDelay(") && putSeg.includes("rebuildBridgeRoutes("),
    putSeg === null
      ? miss('app.put("/v1/groups/:id/delays")')
      : `setMemberDelay=${putSeg.includes("setMemberDelay(")} rebuildBridgeRoutes=${putSeg.includes("rebuildBridgeRoutes(")}`,
  );
}

// ===========================================================================
// G11 延迟只在读视图
// ===========================================================================
console.log("===== G11 延迟只在读视图,不得进 PlayerGroup 实体 / persist =====");
{
  const gi = code(GROUP_INDEX);
  const entB = bodyByHead(gi, /(?:^|\n)export\s+interface\s+PlayerGroup\b/);
  check(
    "PlayerGroup 实体接口不得含 airplayDelayMs / airplay2DelayMs / sendspinDelayMs / trackSwitchLeadMs",
    entB !== null &&
      count(entB, "airplayDelayMs") === 0 &&
      count(entB, "airplay2DelayMs") === 0 &&
      count(entB, "sendspinDelayMs") === 0 &&
      count(entB, "memberDelays") === 0 &&
      count(entB, "trackSwitchLeadMs") === 0,
    entB === null
      ? miss("interface PlayerGroup")
      : "实体带上延迟字段 ⇒ 任何 persist/emit 都会拿内存里的旧值覆盖 DB 值",
  );
  const viewB = bodyByHead(gi, /(?:^|\n)export\s+interface\s+PlayerGroupWithMembers\b/);
  check(
    "读视图 PlayerGroupWithMembers 必须带按成员延迟表与切歌垫片(前端回显不能丢)",
    viewB !== null &&
      viewB.includes("memberDelays") &&
      viewB.includes("trackSwitchLeadMs") &&
      count(viewB, "airplayDelayMs") === 0 &&
      count(viewB, "airplay2DelayMs") === 0 &&
      count(viewB, "sendspinDelayMs") === 0,
    viewB === null
      ? miss("interface PlayerGroupWithMembers")
      : "读视图缺延迟字段 ⇒ 弹窗回显恒 0,用户以为没保存",
  );
  const perB = bodyByName(gi, atLineStart("persist"));
  check(
    "persist 不得写延迟字段(否则改名/调音量会把 DB 里的延迟冲掉)",
    perB !== null &&
      count(perB, "airplayDelayMs") === 0 &&
      count(perB, "airplay2DelayMs") === 0 &&
      count(perB, "sendspinDelayMs") === 0 &&
      count(perB, "memberDelays") === 0 &&
      count(perB, "trackSwitchLeadMs") === 0,
    perB === null ? miss("persist") : "persist 写了延迟字段 ⇒ 组改名/调音量后延迟被整行 upsert 冲回默认值",
  );
}

// ===========================================================================
// G13 延迟补偿按成员(v4.8.0 起,取代旧的按协议三格)
// ===========================================================================
console.log("===== G13 延迟补偿按成员(取值口按成员 id 查表,不再按协议分格) =====");
{
  const dc = code(DELAY_CALIB);
  const bshB = bodyByName(dc, atLineStart("bridgeAnchorShiftUsOf"));
  check(
    "bridgeAnchorShiftUsOf 按设备的成员格子取值(airplay:<deviceId> ⇒ 每台桥独立补偿)",
    bshB !== null && bshB.includes("getMemberDelayMs(") && bshB.includes("`airplay:${airplayDeviceId}`"),
    bshB === null ? miss("bridgeAnchorShiftUsOf") : "桥位移不按成员取值 ⇒ 每设备补偿退化为按协议一刀切",
  );
  const sscB = bodyByName(dc, atLineStart("sendspinDelayUsOfClient"));
  check(
    "sendspinDelayUsOfClient 按客户端的成员格子取值(sendspin:<clientId>)",
    sscB !== null && sscB.includes("getMemberDelayMs(") && sscB.includes("`sendspin:${clientId}`"),
    sscB === null ? miss("sendspinDelayUsOfClient") : "Sendspin 偏移不按成员取值 ⇒ 每设备补偿退化为组级一格",
  );
  const getB = bodyByName(dc, atLineStart("getMemberDelays"));
  check(
    "getMemberDelays 的 select 必须列 memberDelaysJson(漏列 ⇒ 成员补偿恒读 0)",
    getB !== null && getB.includes("playerGroups.memberDelaysJson"),
    getB === null ? miss("getMemberDelays") : "读路径没列新列 ⇒ 保存成功但读回 0,用户以为没存上",
  );
  const setB = bodyByName(dc, atLineStart("setMemberDelay"));
  check(
    "setMemberDelay 必须把 memberDelaysJson 落库(只改内存 ⇒ 重启即回 0)",
    setB !== null && setB.includes("memberDelaysJson:"),
    setB === null ? miss("setMemberDelay") : "写路径漏写新列 ⇒ 重启后成员补偿丢失",
  );
  const basB = bodyByName(code(SPIN_SERVER), atLineStart("bridgeAnchorShiftUs"));
  check(
    "sendspin server bridgeAnchorShiftUs 按桥设备直传取值(协议分格逻辑退役)",
    basB !== null && basB.includes("bridgeAnchorShiftUsOf(this.name, deviceId)") && count(basB, "protocol") === 0,
    basB === null ? miss("bridgeAnchorShiftUs") : "桥位移仍在读协议格 ⇒ 每设备补偿回归",
  );
  const ctl = code(AIRPLAY_CONTROL);
  // bodyByName 在本签名上会误判:返回类型是对象字面量 `Promise<{ ... }>`,
  // 而它的 body 查找规则「遇 `{` 看前一个非空格是不是 `:`」正好被这个类型命中,
  // 于是取回来的是返回类型而不是函数体。这里显式跳过 `<...>` 再取第一个 `{`。
  const headAt = ctl.search(/(?:^|\n)[ \t]*export\s+async\s+function\s+bridgePrepareDevice\b/);
  const gtAt = headAt === -1 ? -1 : ctl.indexOf(">", headAt);
  const openAt = gtAt === -1 ? -1 : ctl.indexOf("{", gtAt);
  const prepB = openAt === -1 ? null : sliceBraces(ctl, openAt);
  check(
    "bridgePrepareDevice 的 anchorShiftUs 必须恒 0(延迟补偿唯一落点 = 投递时戳;锚点再平移 = 双加,对齐器裁内容)",
    prepB !== null &&
      count(prepB, "airplay2DelayUsOf(") === 0 &&
      count(prepB, "airplayDelayUsOf(") === 0 &&
      /anchorShiftUs:\s*0,/.test(prepB),
    prepB === null
      ? miss("bridgePrepareDevice")
      : `锚点复取组值(双加)= 对齐器把补偿整段裁掉;anchorShiftUs 必须恒 0`,
  );
  // AP2 侧同样是把锚点在会话建立时算死 ⇒ 第三格变了不重建桥 = 「只改 AP2」调了没反应。
  const genB = bodyByName(code(SPIN_SERVER), atLineStart("notifyBridgeGeneration"));
  check(
    "切歌垫片动态 lead(A 方案):max(组值, 冷/暖动态) —— track 冷启才用冷 lead",
    genB !== null
      && genB.includes("trackSwitchLeadUsOf(")
      && genB.includes("BRIDGE_TRACK_LEAD_COLD_US")
      && genB.includes("BRIDGE_TRACK_LEAD_WARM_US")
      && genB.includes('reason === "track"')
      && genB.includes("bridgeWarmAttach")
      && count(genB, "BRIDGE_TRACK_SWITCH_LEAD_US") === 0,
    genB === null ? miss("notifyBridgeGeneration") : "垫片必须是动态 lead 声明(固定值贴下限真机不稳定)",
  );
  // B 方案(对齐 MA warm reuse):路由暖复用三件套 —— 复用判据把守拆桥 / token 沿用 /
  // 子进程暖 prepare + 暖挂载信号回灌 lead 选择。
  const gppCode = code(GROUP_PROTOCOL_PLAYER);
  check(
    "桥路由暖复用:playMedia 复用判据把守拆桥(每首拆桥 = 恒冷启,切歌吞音根因)",
    gppCode.includes("const routeReusable =")
      && gppCode.includes("if (!routeReusable) await teardownBridgeRoute();")
      && gppCode.includes("prepareBridgeRoute(apOnline, routeReusable ? prevRoute : undefined)"),
    "playMedia 必须按 routeReusable 决定是否拆桥",
  );
  const pbrB = bodyByName(gppCode, atLineStart("prepareBridgeRoute"));
  check(
    "prepareBridgeRoute 沿用旧 token(同设备同协议 ⇒ 子进程暖复用会话)",
    pbrB !== null && pbrB.includes("reuse?.find") && pbrB.includes("prevSpec ? prevSpec.token :"),
    pbrB === null ? miss("prepareBridgeRoute") : "token 恒随机 ⇒ 暖复用永远不成立",
  );
  const bsmB = bodyByName(code(BRIDGE_SESSION), atLineStart("prepare"));
  check(
    "桥会话 prepare 暖复用分支(同 token 同协议同目标且健康 ⇒ 原样续用)",
    bsmB !== null && bsmB.includes("warm-reuse") && bsmB.includes("prev.warmReusable")
      && bsmB.includes("for (const [, s] of [...this.sessions])"),
    bsmB === null ? miss("BridgeSessionManager.prepare") : "prepare 恒冷启 ⇒ RAOP 握手零复用",
  );
  const sgbB = bodyByName(code(SPIN_BRIDGE_ATTACH), atLineStart("syncGroupBridges"));
  check(
    "syncGroupBridges 上报暖/冷挂载(bridgeWarmAttach ⇒ track 边界选暖/冷 lead)",
    sgbB !== null && sgbB.includes("g.bridgeWarmAttach = nextSpecs.length > 0 && !rebuilt"),
    sgbB === null ? miss("syncGroupBridges") : "暖挂载信号丢失 ⇒ track 边界恒按冷启垫",
  );
  const api = code(API_GROUPS);
  const putSeg2 = sliceBetween(api, 'app.put("/v1/groups/:id/delays"', 'app.delete("/v1/groups/:id"');
  check(
    "PUT delays 必须校验成员属组(memberId ∉ memberIds 拒绝)+ 仅 AirPlay 成员值变化才重建桥",
    putSeg2 !== null && putSeg2.includes("members.includes(memberId)") && putSeg2.includes('memberId.startsWith("airplay:")'),
    putSeg2 === null ? miss('app.put("/v1/groups/:id/delays")') : "重建条件漏 airplay 成员判据 ⇒ Sendspin 值变化也白白重建桥",
  );
}

// ===========================================================================
// G12 重复成员的两种语义(刻意不同,别被「统一」掉)
// ===========================================================================
console.log("===== G12 重复成员:全量口 throw / 增量口 no-op(语义刻意分叉) =====");
{
  const gi = code(GROUP_INDEX);
  const assertB = bodyByName(gi, atLineStart("assertMembersAvailable"));
  const deltaB = bodyByName(gi, atLineStart("applyMemberDelta"));
  const fullThrows = assertB !== null && /seen\.has\(\s*m\s*\)\s*\)\s*throw/.test(assertB);
  const deltaSkips = deltaB !== null && /has\(\s*m\s*\)\s*\)\s*continue/.test(deltaB);
  check(
    "重复成员:全量口(setMembers→校验)必须 throw,增量口(applyMemberDelta)必须 no-op 跳过",
    fullThrows && deltaSkips,
    `全量口 throw=${fullThrows} 增量口 continue=${deltaSkips}` +
      (fullThrows || deltaSkips
        ? ""
        : " —— 两端都被「统一」成同一套语义:全量口静默吞重复=用户勾了没保存也不报错;增量口抛错=移动端「已在组里」的重复 add 直接 500"),
  );
}

// G12b(O1 2026-10-26 修正引入的**第二处**重复判定):setMembers 改成「只校验 newOnes 差集」
//   之后,「提交列表自身含重复」不再由 assertMembersAvailable 顺带发现 —— 组内已有 [a] 时
//   提交 [a,a],newOnes 会把两个 a 一起滤掉 ⇒ assertMembersAvailable([]) 放行 ⇒ 重复被静默
//   持久化(刷新后成员里真有两份 a)。所以 setMembers 必须**自己**判重复,且必须判在差集过滤
//   **之前**:顺序反了等于没判(filter 已经把重复项摘走了)。
// 判据只锚结构、不锚变量名与错误文案措辞:
//   · 重复判定 = Set.has(<x>)) 之后紧跟 throw;
//   · 差集过滤 = 以 newOnes 接收集合 .filter( 的赋值;
//   · 顺序     = 前者在函数体内出现得更早。
{
  const gi = code(GROUP_INDEX);
  const setB3 = bodyByName(gi, atLineStart("setMembers"));
  const dupThrowRe = /has\(\s*\w+\s*\)\s*\)\s*\{?\s*throw/;
  const newOnesRe = /newOnes\s*=\s*[\w.]+\.filter\(/;
  const dupAt = setB3 === null ? -1 : setB3.search(dupThrowRe);
  const newOnesAt = setB3 === null ? -1 : setB3.search(newOnesRe);
  check(
    "setMembers 自带重复判定,且重复判定必须在 newOnes 差集过滤之前(只校验差集后不再被顺带完成)",
    setB3 !== null && dupAt !== -1 && newOnesAt !== -1 && dupAt < newOnesAt,
    setB3 === null
      ? miss("setMembers")
      : `重复判定@${dupAt} 差集过滤@${newOnesAt}` +
        (dupAt === -1
          ? " —— 缺重复判定:组内已有 a 时提交 [a,a] 会被差集全部滤掉后静默持久化"
          : "") +
        (newOnesAt === -1 ? " —— 未找到 newOnes 差集过滤(实现改名?请同步本条断言)" : "") +
        (dupAt !== -1 && dupAt >= newOnesAt
          ? " —— 顺序颠倒:过滤先跑完,重复项已被摘走,判定失效"
          : ""),
  );
}

// ===========================================================================
// G14 可听前 BUFFERING 瞬态(v4.8.1):切歌进度「前进~2s 又跳回 0」循环防线
// ===========================================================================
console.log("===== G14 可听前 BUFFERING 瞬态(audibleStarted ⇒ pollCore.buffering ⇒ 四处映射) =====");
{
  const STREAM_ENGINE = "backend/src/services/sendspin/streamEngine.ts";
  const SPIN_PROTO = "backend/src/services/sendspin/protocolPlayer.ts";
  const SPIN_INDEX = "backend/src/services/sendspin/index.ts";

  const srv14 = code(SPIN_SERVER);
  check(
    "SendspinGroup 必须声明 audibleStarted 标志(可听前 buffering 的唯一状态源)",
    count(srv14, "audibleStarted = false") === 1 && count(srv14, "audibleStarted = true") === 0,
    "audibleStarted 字段缺失/被改名 ⇒ pollCore.buffering 恒 false,三端回跳循环回归",
  );
  const se14 = code(STREAM_ENGINE);
  check(
    "streamEngine 必须在 play/seek/rehost 三处复位 audibleStarted(漏一处 ⇒ 该路径回跳回归)",
    count(se14, "audibleStarted = false") === 3,
    "复位点缺失 ⇒ 对应路径切歌/seek 后进度回跳循环回归",
  );
  check(
    "streamEngine 推流/排空两处首次越过下界置位 audibleStarted(漏置位 ⇒ 永远 BUFFERING 不出声)",
    count(se14, "audibleStarted = true") === 2,
    "置位点缺失 ⇒ 进度条永远停在下界,看门狗也等不到 PLAYING",
  );
  const core14 = code(SPIN_CORE);
  check(
    "pollCore 必须返回 buffering(签名 + 返回字段;stub 组 undefined 退化 false)",
    core14.includes("durationMs: number; buffering: boolean }")
      && core14.includes("buffering: !!g.current && !g.paused && (g as any).audibleStarted === false,"),
    "pollCore 丢了 buffering 字段 ⇒ 三端恢复本地插值,回跳循环回归",
  );
  check(
    "playerCore cast 起播两处必须复位 audibleStarted(漏复位 ⇒ 上一首遗留 true,新曲直接误报 PLAYING)",
    count(core14, "g.audibleStarted = false") === 2,
    "cast 起播复位缺失 ⇒ 切歌后立即误报 PLAYING,进度回跳回归",
  );
  const spp14 = code(SPIN_PROTO);
  check(
    "sendspin protocolPlayer 三处 pollState 必须把 buffering 映射成 BUFFERING",
    count(spp14, "(st as any).buffering ? PlaybackState.BUFFERING") === 3,
    "映射缺失 ⇒ 可听前报 PLAYING,客户端插值与轮询打架",
  );
  check(
    "sendspin protocolPlayer 两处 catch 兜底必须带 buffering:false(探不到 ≠ buffering)",
    count(spp14, "buffering: false") === 2,
    "兜底缺 buffering ⇒ 不可达时误报 BUFFERING,tracker 瞬态屏蔽被滥用",
  );
  const gpp14 = code(GROUP_PROTOCOL_PLAYER);
  check(
    "getGroupStatus 两处 sendspin 分支必须把 buffering 映射成 \"BUFFERING\" 字符串",
    count(gpp14, 'buffering ? \"BUFFERING\" : \"PLAYING\"') === 2 && count(gpp14, "buffering: false") === 2,
    "组状态缺 BUFFERING ⇒ /status 消费方(HA/前端)恢复插值,回跳循环回归",
  );
  const sidx14 = code(SPIN_INDEX);
  check(
    "sendspinGroupPoll 签名带 buffering 且 fork 未跑兜底带 buffering:false(RPC 透传契约)",
    sidx14.includes("durationMs: number; buffering: boolean }") && count(sidx14, "buffering: false") === 1,
    "签名/兜底缺 buffering ⇒ fork 模式下 buffering 丢失,组状态恒 PLAYING",
  );
}

// ===========================================================================
// G15 预取完整性三闸(v4.8.3):上游截断对账 + too-small 硬下界
// 《纵身一跃》事故:上游(汽水 VIP 源)提前断流,attemptOnce 把残缺字节当 ok:true
// 交回,判官只能按 too-small 弱信号放行(不记负缓存),坏源永远建立不起「无源」
// 结论 —— 播 60s 断一次,每次重蹈。两道闸把「残缺」从弱信号升级成硬结论。
// ===========================================================================
console.log("===== G15 预取完整性:上游截断对账 + too-small 硬下界 =====");
{
  const bf = code(BFETCH);
  const tolDecl = /const\s+TRUNCATION_TOLERANCE\s*=\s*0\.9\s*;/.test(bf);
  const truncChk = /downloaded < cl \* TRUNCATION_TOLERANCE/.test(bf);
  check(
    "attemptOnce 收尾对账 content-length(实收 < 90% ⇒ stalled,上游提前 EOF 不得以 ok:true 交回残缺字节)",
    tolDecl && truncChk && count(bf, "upstream truncated") === 1,
    `容差声明=${tolDecl} 对账判断=${truncChk} 截断错误串 ${count(bf, "upstream truncated")} 处 ⇒ 缺任一 = 回到假成功`,
  );
  const pf = code(PREFETCH);
  const hardDecl = /export\s+const\s+PREFETCH_HARD_MIN_BYTES_PER_SEC\s*=\s*4000\s*;/.test(pf);
  const hardN = countInSrc("PREFETCH_HARD_MIN_BYTES_PER_SEC =");
  check(
    "PREFETCH_HARD_MIN_BYTES_PER_SEC = 4000(32kbps 地板)且只声明一次",
    hardDecl && hardN.n === 1,
    `prefetchCache 声明=${hardDecl} 全仓声明 ${hardN.n} 处(${hardN.where})`,
  );
  const hardChk = /expectedSec \* PREFETCH_HARD_MIN_BYTES_PER_SEC/.test(pf);
  const hardReason = count(pf, '"too-small-hard"') === 1;
  check(
    "判官 too-small 先过硬算术下界(装不下期望时长 ⇒ too-small-hard 判死记负缓存,不走弱信号宽待)",
    hardChk && hardReason,
    `下界判断=${hardChk} too-small-hard 判死=${hardReason} ⇒ 缺任一 = chunked 截断仍被当弱信号放行`,
  );
}

// ===========================================================================
// G16 正缓存不得盖住负缓存(v4.8.4 第四刀):《纵身一跃》最终防线
// VIP 试听源的直链是活的(200/206 可解析),错的是内容只有 60s。于是队列预解析
// 每次都顺利写下「可播」正缓存(1h),而 getCachedPlayability 先读正缓存 ⇒
// 判官刚写的负缓存被盖掉,跳过永远不生效,照播 60s。契约:负缓存鲜活期内
// 不许并存正缓存;过期后自动解禁(源恢复即复活,不永久拉黑)。
// ===========================================================================
console.log("===== G16 正缓存不得盖住未过期负缓存(判跳才看得见) =====");
{
  const fb = code(FALLBACK);
  const declN = countInSrc("function isNegativeFresh(");
  const callN = countInSrc("isNegativeFresh(songId)");
  check(
    "isNegativeFresh 单一声明(负缓存鲜活性判定口,不许散落多处各判一套)",
    declN.n === 1 && /function isNegativeFresh\(songId: string\): boolean \{/.test(fb),
    `全仓声明 ${declN.n} 处(${declN.where}) 签名命中=${/function isNegativeFresh\(songId: string\): boolean \{/.test(fb)}`,
  );
  const addBody = bodyByName(fb, /function addPlayable\(songId: string/);
  check(
    "addPlayable 写正缓存前先判负缓存未过期 ⇒ 拒绝写(源解析成功也不许翻回 playable)",
    !!addBody && /if \(isNegativeFresh\(songId\)\) return;/.test(addBody) && callN.n >= 1,
    `addPlayable 体命中=${!!addBody} 拦截行=${addBody ? /if \(isNegativeFresh\(songId\)\) return;/.test(addBody) : "找不到函数体"} 调用点 ${callN.n} 处 ⇒ 缺拦截 = VIP 60s 假歌照播`,
  );
  const mkBody = bodyByName(fb, /function markUnplayable\(songId: string/);
  check(
    "markUnplayable 立即清掉该歌正缓存(判死与可播不得并存两条矛盾结论)",
    !!mkBody && /playableCache\.delete\(songId\);/.test(mkBody),
    `markUnplayable 体命中=${!!mkBody} 清正缓存行=${mkBody ? /playableCache\.delete\(songId\);/.test(mkBody) : "找不到函数体"}`,
  );
}

// ===========================================================================
// G17 判官中段缓冲兜底(v4.8.4 第三刀):minAudioKB 调大后不许漏判
// 《纵身一跃》972KB 在 minAudioKB=2048 的实例上落进 too-small 分支,而 32kbps 地板
// (217s×4KB=868KB)装得下它 ⇒ 硬下界不命中,按弱信号放行 ⇒ 照播 60s。
// 「太小」的判据值是可调的,跟着它调就会漏掉所有「够小但内容仍不完整」的源,
// 故 too-small 分支内必须再按 music-metadata 的真实时长判一次死(与主路径同尺子)。
// ===========================================================================
console.log("===== G17 判官中段缓冲兜底:够小也不许凭体积蒙混过关 =====");
{
  const pf = code(PREFETCH);
  const iHard = pf.indexOf("expectedSec * PREFETCH_HARD_MIN_BYTES_PER_SEC");
  const iMid = pf.indexOf("buf.length >= PREFETCH_MIN_AUDIO_BYTES && expectedSec > 0");
  const iWeak = pf.lastIndexOf('return { ...base, dead: true, reason: "too-small" };');
  check(
    "too-small 分支内顺序 = 硬下界 → 中段兜底 → 才落弱信号(顺序颠倒 = 兜底永不执行)",
    iHard >= 0 && iMid > iHard && iWeak > iMid,
    `硬下界@${iHard} 中段兜底@${iMid} 弱信号@${iWeak}`,
  );
  const seg = iMid >= 0 && iWeak > iMid ? pf.slice(iMid, iWeak) : "";
  const sameRule = /expectedSec - d > icfg\.deltaSec/.test(seg);
  const deadRet = count(pf, 'return { ...base, dead: true, reason: "preview", actualSec: d, via: "metadata" };') === 1;
  check(
    "中段兜底按真实时长判死(与主路径同一把尺子 icfg.deltaSec,不是另立一套阈值)",
    sameRule && deadRet,
    `同尺子=${sameRule} 判死返回唯一=${deadRet} ⇒ 尺子不一致 = 同一首歌两处结论相反`,
  );
  check(
    "解析失败走 catch 保守放行(冷门容器/怪 tag 不得被误判成试听)",
    /catch \{/.test(seg) && /parseBuffer\(buf/.test(seg),
    `catch 兜底=${/catch \{/.test(seg)} 解析调用=${/parseBuffer\(buf/.test(seg)} ⇒ 无 catch = 解析抛异常直接炸预取`,
  );
}

// ===========================================================================
// G18 试听片段跨进程判死回传 + 起播前第六闸(v4.8.5):《等你飞奔而来》事故
// 子进程(streamEngine)判死只写子进程内 streamFallback 的 module-local Map,
// 主进程 QueueController 判跳读的是自己那份 ⇒ 「已判死却还能重播」。
// 且 judgePlayable 在 unknown 时只看 URL 能否探测、不判内容 ⇒ 首次必播出。
// ===========================================================================
console.log("===== G18 跨进程判死回传 + 起播前完整性预检(第六闸) =====");
{
  const se = code(SPIN_STREAM_ENGINE);
  const pc = code(SPIN_CORE);
  const ipc = code(SPIN_IPC);
  const sup = code(SPIN_SUPERVISOR);
  const qc = code(QUEUE_CTL);
  const pfG18 = code(PREFETCH);
  const childMainTxt = code(SPIN_CHILD_MAIN);
  const spinIdx = code(SPIN_INDEX);
  // --- a) 判死回传口 ---
  const sinkDecl = /export type SongUnplayableSink = \(songId: string, reason: string\) => void;/.test(se);
  const fieldDecl = /onUnplayable: SongUnplayableSink \| null = null;/.test(se);
  const callSite = /this\.onUnplayable\?\.\(\s*this\.songId,/.test(se);
  check(
    "GroupPump 判死回传口:SongUnplayableSink 类型 + onUnplayable 字段 + stream-truncated 判死拍回传",
    sinkDecl && fieldDecl && callSite,
    `类型=${sinkDecl} 字段=${fieldDecl} 回传调用=${callSite} ⇒ 缺任一 = 子进程判死主进程永远不知道`,
  );
  const pumpFill = /if \(onUnplayable\) p\.onUnplayable = onUnplayable;/.test(se);
  check(
    "pumpFor 装填语义 = 不传则沿用已有(seek 重建/泵复用不得把回传口抹掉)",
    pumpFill,
    `装填判断=${pumpFill} ⇒ 改成无条件赋 null = seek 一次回传口就丢`,
  );
  const noSinkWarn = count(se, "判死回传口未装填") === 1 && /warnedNoSink/.test(se);
  check(
    "回传口未装填不得静默(必须打告警且去重) —— 静默 = bug 无声复现",
    noSinkWarn,
    `告警串=${count(se, "判死回传口未装填")} 处(应恰 1) + 去重=${/warnedNoSink/.test(se)}`,
  );
  // --- b) IPC 事件 + 主进程落地 ---
  const evDecl = /\{ t: "songUnplayable"; clientId: string; songId: string; reason: string \}/.test(ipc);
  const supCase = /case "songUnplayable":/.test(sup);
  const mainFn = /export function markSongUnplayableInMain\(songId: string\): void \{/.test(sup)
    && /markUnplayable\(songId\);/.test(sup);
  const hookCall = /onSongUnplayable: \(songId, reason\) => \{/.test(spinIdx)
    && /markSongUnplayableInMain\(songId\);/.test(spinIdx);
  check(
    "IPC songUnplayable 事件 + supervisor 分发 + 主进程 markSongUnplayableInMain ⇒ markUnplayable",
    evDecl && supCase && mainFn && hookCall,
    `事件=${evDecl} 分发=${supCase} 主进程函数=${mainFn} index hook 接线=${hookCall}`,
  );
  const childSinkN = count(childMainTxt, 't: "songUnplayable"');
  check(
    "childMain 两个分支(playMedia/groupPlay)都装填 sink(漏一条 = 该路径判死不回传)",
    childSinkN >= 2,
    `childMain 回传 ${childSinkN} 处(应 ≥2)`,
  );
  // --- c) 起播前第六闸(保守四条 + 有界等待) ---
  const preBody = bodyByName(qc, /private async precheckIntegrity\(songId: string, songRow: any/);
  const gateCond = !!preBody
    && /known === "unplayable"/.test(preBody)
    && /known !== "unknown" && known !== "transient"/.test(preBody)
    && /!\(dur > 0\)/.test(preBody)
    && /startsWith\("web:"\)/.test(preBody);
  const bounded = !!preBody
    && /withTimeout\(prefetchSong\(songId\), waitMs/.test(preBody)
    && /Math\.min\(9000, Number\(cfg\.precheckWaitMs\)/.test(preBody)
    && /catch \{/.test(preBody);
  check(
    "第六闸四条保守条件齐(已有结论不重复/无基准不杀/仅网络源/判官开)且等待有界(≤9000 < 10s 外层)",
    gateCond && bounded,
    `四条=${gateCond} 有界+兜底=${bounded} ⇒ 缺保守条件 = 误杀正常歌;无上界 = playCurrent 被永久占用(2026-10-21 事故)`,
  );
  const iPre = qc.indexOf("this.precheckIntegrity(item.songId, songRow)");
  const iRes = qc.indexOf("resolvePlayableRow(item.songId)");
  check(
    "第六闸挂在 judgePlayable 内且先于 resolvePlayableRow(判死就不必再走换源探测)",
    iPre >= 0 && iRes > iPre,
    `预检@${iPre} 换源@${iRes}`,
  );
  // --- d) 预取闸门 0:已判死不下字节 ---
  const g0Sync = /if \(playabilityReader\?\.\(songId\) === "unplayable"\) return Promise\.resolve\(\);/.test(pfG18);
  const g0Auth = /playabilityReader = sf0\.getCachedPlayability;/.test(pfG18)
    && count(pfG18, "已判死(unplayable),跳过预取") >= 1;
  check(
    "预取闸门 0:已判死 ⇒ 一个字节都不下(同步入口 + doPrefetch 权威版双闸)",
    g0Sync && g0Auth,
    `同步闸=${g0Sync} 权威闸=${g0Auth} ⇒ 缺闸 = 已知死歌每次轮到重下一遍字节`,
  );
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n[群组不变量守卫] FAIL:${failures.length} 项(通过 ${passed} 项)`);
  for (const f of failures) console.error("  · " + f);
  if (todos.length) {
    console.error(`  另有 ${todos.length} 项 TODO 缺口(不阻断,见上方逐条说明):`);
    for (const t of todos) console.error("  ⚠ " + t);
  }
  if (exceptions.length) {
    console.error(`  另有 ${exceptions.length} 项已裁定例外(2026-10-26,勿当 bug 修):`);
    for (const t of exceptions) console.error("  ⊘ " + t);
  }
  process.exit(1);
}
console.log(
  `\n[群组不变量守卫] ${passed} 条断言全部通过` +
    (todos.length ? `;${todos.length} 项 TODO 缺口已登记(不阻断 CI,见上)` : ";无 TODO 缺口") +
    (exceptions.length ? `;${exceptions.length} 项已裁定例外(2026-10-26 裁定,勿当 bug 修)` : ""),
);
