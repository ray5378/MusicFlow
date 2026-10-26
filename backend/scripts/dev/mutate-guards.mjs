#!/usr/bin/env node
// ============ 守卫「可失败性」反证工具(开发件,**非 CI 件**) ============
//
// 为什么需要它:
//   静态守卫最大的风险不是漏检,而是**恒真断言** —— 正则锚错了对象、判据写成了永真式,
//   于是脚本永远打印 ✓、CI 永远绿,而真正的退化无人拦。本工具用「最小违规变异」证明
//   每条断言**确实能被打红**:对源码副本打一处针对性补丁 → 跑守卫 → 校验「exit=1 且
//   报错的正是预期那一条」→ 还原。
//
// 用法(在仓库根目录,或任意 cwd —— 路径按脚本自身位置解析):
//   node backend/scripts/dev/mutate-guards.mjs            # 跑全部用例(约 40s)
//   node backend/scripts/dev/mutate-guards.mjs --only G2  # 只跑 id 含 "G2" 的用例
//   node backend/scripts/dev/mutate-guards.mjs --list     # 只列用例清单
//
// 覆盖面:
//   · group       → backend/scripts/check-group-invariants.mjs (G1–G12)
//   · bridge      → backend/scripts/check-airplay-bridge.mjs  (⑮⑯⑰ 等)
//   · decode-af   → backend/scripts/check-airplay-decode-af.mjs (R6 等)
//
// 约定:
//   1) **只写系统临时目录**(默认 <tmp>/mf-guard-mutation),绝不改动工作树里的 src ——
//      本工具会先把 backend/src、backend/scripts、frontend/src/views/Groups/index.vue
//      复制到临时目录,再在副本上做文本替身;结束时恢复副本。
//   2) 每条用例都必须给出「期望红的中文断言前缀」,只比 exit code 不算通过 ——
//      否则「红在别处」也会被误判为断言有效。
//   3) 判据是 `exit===1 && out.includes("✗") && out.includes(expect)`。
//   4) 新增守卫断言时,请同步在本文件 CASES 里加一条对应违规手法(并在 PR 说明里附输出)。
//
// ⚠️ 非 CI 件:不进 ci.yml。它要复制整个 backend/src 并跑 ~30 次守卫,耗时与噪声都不适合
//    CI;定位是「改完守卫、提 PR 前手工跑一遍」的开发闸门。
import { readFileSync, writeFileSync, cpSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WORK = join(tmpdir(), "mf-guard-mutation");
const PRISTINE = join(WORK, ".pristine");

const GUARDS = {
  group: "check-group-invariants.mjs",
  bridge: "check-airplay-bridge.mjs",
  "decode-af": "check-airplay-decode-af.mjs",
};

// ---------------- 源码文件简写 ----------------
const GI = "backend/src/services/group/index.ts";
const VUE = "frontend/src/views/Groups/index.vue";
const QC = "backend/src/services/player/QueueController.ts";
const SV = "backend/src/services/sendspin/server.ts";
const PC = "backend/src/services/sendspin/playerCore.ts";
const BS = "backend/src/services/airplay/bridgeSession.ts";
const BSRC = "backend/src/services/airplay/bridgeSource.ts";
const RATES = "backend/src/services/airplay/rates.ts";
const RES = "backend/src/services/airplay/resampler.ts";
const PF = "backend/src/services/source/prefetchCache.ts";
const WD = "backend/src/services/group/watchdog.ts";
const DC = "backend/src/services/group/delayCalib.ts";
const API = "backend/src/routes/api/groups.ts";

/**
 * 每条 = 一处违规手法。
 *   guard  守卫脚本
 *   why    这个违规在真实开发中长什么样(为什么值得钉)
 *   append 追加到文件尾(用于「多出一个定义/引用」类违规)
 *   last   from 命中多处时取最后一处
 */
const CASES = [
  // ===== check-group-invariants.mjs =====
  {
    id: "G1-a",
    guard: "group",
    why: "setMembers 顺手「规范化」成员 id",
    file: GI,
    from: "g.memberIds = [...memberIds];",
    to: "g.memberIds = memberIds.map((m) => m.slice(0));",
    expect: "setMembers 把成员 id 原样写回",
  },
  {
    id: "G1-b",
    guard: "group",
    why: "增量口改写成员 id",
    file: GI,
    from: "kept.push(m);",
    to: "kept.push(m.slice(0));",
    expect: "applyMemberDelta 同样原样透传成员 id",
  },
  {
    id: "G1-c",
    guard: "group",
    why: "删掉「裸 id ≡ DLNA」历史回退(老组全体成员失联)",
    file: GI,
    from: 'return { kind: "dlna", id: m };',
    to: "return null;",
    expect: "splitMemberId 仍解析",
  },
  {
    id: "G1-d",
    guard: "group",
    why: "未知命名空间落进裸 id 兜底(报错误导成「DLNA 设备不支持入组」)",
    file: GI,
    from: 'if (m.includes(":")) return null;',
    to: "",
    expect: "含冒号的未知前缀",
  },
  {
    id: "G2-a",
    guard: "group",
    why: "allowlist 被改坏(sendspin 分支判定失效)",
    file: GI,
    from: 'if (split.kind === "sendspin") {',
    to: 'if (split.kind === "sendspinX") {',
    expect: "服务端成员校验有 kind allowlist",
  },
  {
    id: "G2-a2",
    guard: "group",
    why: "DLNA 拒收降级成 return(防线变告警)",
    file: GI,
    from: "throw new Error(`DLNA 设备不支持加入群组(请先从成员中移除 ${m})`);",
    to: "return;",
    expect: "DLNA 分支是 throw 拒收",
  },
  {
    id: "G2-b2",
    guard: "group",
    why: "增量入口漏掉成员校验(POST members {add:[dlna:x]} 后门)",
    file: GI,
    from: "this.assertMembersAvailable(added);",
    to: "void added;",
    expect: "两个写入口",
  },
  {
    id: "G2-c",
    guard: "group",
    why: "前端候选把 DLNA 拼进来",
    file: VUE,
    from: "`airplay:${d.id}`",
    to: "`dlna:${d.id}`",
    expect: "前端候选只由 airplay:/sendspin: 两个数据源拼装",
  },
  {
    id: "G3-a",
    guard: "group",
    why: "AirPlay 新成员 cast 不再编起点(回到「先起播再追」)",
    file: QC,
    from: "await p.playMedia(fullItem, baseUrl, startMs);",
    to: "await p.playMedia(fullItem, baseUrl);",
    expect: "起点经 startMs 一次性编进本次 cast",
  },
  {
    id: "G3-b",
    guard: "group",
    why: "AirPlay 路径又加回事后校准 seek(单会话设备永久等待)",
    file: QC,
    from: "const p = createAirPlayProtocolPlayer(deviceId);",
    to: "const p = createAirPlayProtocolPlayer(deviceId); await alignDeviceToPosition(deviceId, 0);",
    expect: "同一路径不得事后校准 seek",
  },
  {
    id: "G4-a",
    guard: "group",
    why: "AirPlay 新成员位置不再取组状态(改成拍脑袋常量)",
    file: QC,
    from: "const st = await getGroupStatus(groupId);",
    to: "const st = { position: 0, state: undefined } as any;",
    last: true, // 只改 rejoinMembersAirplay 那处;DLNA 路径的 getTargetSec 里还有一处
    expect: "两条「新增成员对齐」路径的位置都取自 getGroupStatus",
  },
  {
    id: "G5-a",
    guard: "group",
    why: "出现第二条出流泵(第二个 pushFrame 定义)",
    file: PC,
    append: "\nasync pushFrame(x: bigint) { return 0; }\n",
    expect: "pushFrame 全仓只有一处定义",
  },
  {
    id: "G5-b",
    guard: "group",
    why: "桥侧自建选歌/判死分支",
    file: BS,
    append: "\nconst qaLeak = resolvePreferredSong;\n",
    expect: "桥侧不得自建第二条选歌/判死路径",
  },
  {
    id: "G6-a",
    guard: "group",
    why: "组内换源上限被放大(3→5,坏源上无限换)",
    file: PF,
    from: "export const PREFETCH_MAX_ALT_SOURCES = 3;",
    to: "export const PREFETCH_MAX_ALT_SOURCES = 5;",
    expect: "PREFETCH_MAX_ALT_SOURCES = 3",
  },
  {
    id: "G7-a",
    guard: "group",
    why: "延迟补偿被加进 ring 的 tsUs(桥窗口/水位/late-join 一起偏)",
    file: SV,
    from: "ring.push({ tsUs: ts, durUs:",
    to: "ring.push({ tsUs: ts + dspDelayUs, durUs:",
    expect: "ring 写入行",
  },
  {
    id: "G8-a",
    guard: "group",
    why: "watchdog 绕过统一入口自己起播",
    file: WD,
    from: "await qc.resumeActive(g.id, getEffectiveBaseUrl());",
    to: "await qc.playCurrent(g.id, getEffectiveBaseUrl());",
    expect: "组 watchdog 的恢复入口是 qc.resumeActive",
  },
  {
    id: "G9-a",
    guard: "group",
    why: "同步判据字段被改名(deltaP95Us 丢失 → 回盲调)",
    file: BS,
    from: "deltaP95Us: p95,",
    to: "deltaP95: p95,",
    expect: "tick 仍带全部内容同步判据",
  },
  {
    id: "G10-a",
    guard: "group",
    why: "延迟上限与前端约定漂移(30000→2000)",
    file: DC,
    from: "export const GROUP_DELAY_MAX_MS = 30000;",
    to: "export const GROUP_DELAY_MAX_MS = 2000;",
    expect: "GROUP_DELAY_MAX_MS = 30000",
  },
  {
    id: "G10-b",
    guard: "group",
    why: "PUT 改了 AirPlay 延迟却不重建桥(调了没反应)",
    file: API,
    from: "rebuilt = await rebuildBridgeRoutes(id);",
    to: "rebuilt = 0;",
    expect: "PUT /v1/groups/:id/delays",
  },
  {
    id: "G11-a",
    guard: "group",
    why: "延迟字段被塞进 PlayerGroup 实体(被 persist 用旧值覆盖)",
    file: GI,
    from: "  memberIds: string[]; // 命名空间 id:airplay:<deviceId> / sendspin:<clientId>(裸 id 仅历史数据)",
    to: "  memberIds: string[]; // 命名空间 id:airplay:<deviceId> / sendspin:<clientId>(裸 id 仅历史数据)\n  airplayDelayMs: number;",
    expect: "PlayerGroup 实体接口不得含",
  },
  {
    id: "G11-b",
    guard: "group",
    why: "persist 把延迟写进库(改名/调音量冲掉 DB 值)",
    file: GI,
    from: "        memberIds: JSON.stringify(g.memberIds),",
    to: "        airplayDelayMs: 0,\n        memberIds: JSON.stringify(g.memberIds),",
    expect: "persist 不得写延迟字段",
  },
  {
    id: "G12-a",
    guard: "group",
    why: "把增量口「重复跳过」统一成抛错(移动端重复 add 直接 500)",
    file: GI,
    from: 'if (typeof m !== "string" || keptSet.has(m)) continue;',
    to: 'if (typeof m !== "string") continue;',
    expect: "重复成员:全量口",
  },

  // G12-b(O1 修正引入的**第二处**重复判定):setMembers 改成只校验 newOnes 差集后,
  //   「提交列表自身有重复」不再由 assertMembersAvailable 顺带发现 —— 必须自己判,
  //   且必须判在差集过滤之前(顺序反了等于没判)。变异手法:把 throw 降级成 continue。
  {
    id: "G12-b",
    guard: "group",
    why: "setMembers 不再自己判重复(组内已有 a 时提交 [a,a] 被差集滤光 ⇒ 重复静默持久化)",
    file: GI,
    from:
      '      if (seen.has(m)) throw new Error("成员列表不能重复");\n      seen.add(m);\n    }\n    const newOnes',
    to:
      '      if (seen.has(m)) continue;\n      seen.add(m);\n    }\n    const newOnes',
    expect: "重复判定必须在 newOnes 差集过滤之前",
  },

  // G12-c(G12b 的第二个失效分支:**顺序颠倒**)。判据要求「重复判定早于差集过滤」,
  //   若只删 throw(G12-b)只覆盖了一个分支。这里把重复判定整体挪到 newOnes 过滤**之后**,
  //   断言必须因「顺序颠倒」变红 —— 否则那条顺序判据就是没被验证过的判断。
  //   注:本工具只做静态文本判定,变异体无需可编译,故直接交换两段位置即可。
  {
    id: "G12-c",
    guard: "group",
    why: "重复判定被挪到 newOnes 差集过滤之后(过滤先跑完,重复项已被摘走 ⇒ 判定失效)",
    file: GI,
    from:
      '      if (seen.has(m)) throw new Error("成员列表不能重复");\n      seen.add(m);\n    }\n    const newOnes = memberIds.filter(m => !g.memberIds.includes(m));',
    to:
      '      seen.add(m);\n    }\n    const newOnes = memberIds.filter(m => !g.memberIds.includes(m));\n      if (seen.has(m)) throw new Error("成员列表不能重复");',
    expect: "顺序颠倒",
  },

  // ===== check-airplay-bridge.mjs(⑮⑯⑰) =====
  {
    id: "A15-a",
    guard: "bridge",
    why: "删掉锚点一次性早退(可热改锚点却没清 aligner)",
    file: BS,
    from: "    if (this.aligner !== null) return;\n",
    to: "",
    expect: "maybeBeginStream 保留锚点一次性守卫",
  },
  {
    id: "A15-b",
    guard: "bridge",
    why: "出现第二套对齐器 = 第二处锚点",
    file: BSRC,
    append: "\nexport const qaSecondAligner = new BridgeTimelineAligner(0n, 48000);\n",
    expect: "BridgeTimelineAligner 全仓只在一处被创建",
  },
  {
    id: "A16-a",
    guard: "bridge",
    why: "补偿落点被摘掉(anchorShiftUs 不再进锚点)",
    file: BS,
    from: "let anchorUs = opts.firstFrameTsUs + BigInt(opts.anchorShiftUs ?? 0);",
    to: "let anchorUs = opts.firstFrameTsUs;",
    expect: "planBridgeAnchor 内锚点",
  },
  {
    id: "A16-b",
    guard: "bridge",
    why: "同一偏移两头各加一次(双倍补偿)",
    file: SV,
    append: "\nconst anchorShiftProbe = 0;\n",
    expect: "同一偏移不得两头各加一次",
  },
  {
    id: "A17-a",
    guard: "bridge",
    why: "退避指数项不封顶(间隔指数爆炸 = 永不重连)",
    file: BSRC,
    from: "const exp = Math.min(maxMs, baseMs * 2 ** (n - 1));",
    to: "const exp = baseMs * 2 ** (n - 1);",
    expect: "退避 = min(maxMs",
  },
  {
    id: "A17-b",
    guard: "bridge",
    why: "退避上限与约定漂移(30s→60s)",
    file: RATES,
    from: "export const BRIDGE_BACKOFF_MAX_MS = 30_000;",
    to: "export const BRIDGE_BACKOFF_MAX_MS = 60_000;",
    expect: "BRIDGE_BACKOFF_MAX_MS = 30_000",
  },

  // ===== check-airplay-decode-af.mjs(R6) =====
  {
    id: "D6-a",
    guard: "decode-af",
    why: "重采样器里补一段响度归一(二次压缩 + 绕开唯一发生地)",
    file: RES,
    append: '\nconst qaNorm = "loudnorm";\n',
    expect: "resampler.ts 剥注释后无 loudnorm",
  },
  {
    id: "D6-b",
    guard: "decode-af",
    why: "重采样器引用归一/DSP 符号",
    file: RES,
    append: "\nconst qaNorm2 = resolveLoudnessAf;\n",
    expect: "resampler.ts 不引用归一/DSP 符号",
  },
];

// ---------------- 临时副本 ----------------
function seed() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(join(REPO, "backend/src"), join(WORK, "backend/src"), { recursive: true });
  cpSync(join(REPO, "backend/scripts"), join(WORK, "backend/scripts"), { recursive: true });
  const vueDir = join(WORK, "frontend/src/views/Groups");
  mkdirSync(vueDir, { recursive: true });
  cpSync(join(REPO, "frontend/src/views/Groups/index.vue"), join(vueDir, "index.vue"));
  cpSync(join(WORK, "backend/src"), join(PRISTINE, "src"), { recursive: true });
  cpSync(join(WORK, "backend/scripts"), join(PRISTINE, "scripts"), { recursive: true });
  cpSync(join(vueDir, "index.vue"), join(PRISTINE, "vue.vue"));
}
function restore() {
  rmSync(join(WORK, "backend/src"), { recursive: true, force: true });
  rmSync(join(WORK, "backend/scripts"), { recursive: true, force: true });
  cpSync(join(PRISTINE, "src"), join(WORK, "backend/src"), { recursive: true });
  cpSync(join(PRISTINE, "scripts"), join(WORK, "backend/scripts"), { recursive: true });
  cpSync(join(PRISTINE, "vue.vue"), join(WORK, "frontend/src/views/Groups/index.vue"));
}
function runGuard(key) {
  const r = spawnSync("node", [join(WORK, "backend/scripts", GUARDS[key])], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// ---------------- main ----------------
const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] || "" : "";
const cases = only ? CASES.filter((c) => c.id.includes(only)) : CASES;

if (argv.includes("--list")) {
  for (const c of CASES) console.log(`${c.id}\t[${c.guard}] ${c.why}`);
  process.exit(0);
}
if (cases.length === 0) {
  console.error(`没有匹配 --only "${only}" 的用例`);
  process.exit(2);
}

console.log(`仓库:${REPO}\n副本:${WORK}\n用例:${cases.length} 条${only ? `(过滤:${only})` : ""}\n`);
seed();

console.log("== 0) 基线:源码未变异时三个守卫都必须绿 ==");
let baseBad = 0;
for (const key of Object.keys(GUARDS)) {
  const r = runGuard(key);
  const ok = r.status === 0;
  if (!ok) baseBad += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${GUARDS[key]} exit=${r.status}`);
}
if (baseBad > 0) {
  console.error("\n基线不绿,后续反证无意义 —— 先修守卫本身。");
  process.exit(1);
}

console.log("\n== 1) 逐条变异:每次只打一处违规,只允许预期那条变红 ==");
let bad = 0;
for (const c of cases) {
  restore();
  const p = join(WORK, c.file);
  if (!existsSync(p)) {
    console.log(`  !! ${c.id} 文件不存在:${c.file}`);
    bad += 1;
    continue;
  }
  const src = readFileSync(p, "utf8");
  if (c.append) {
    writeFileSync(p, src + c.append);
  } else {
    const at = c.last ? src.lastIndexOf(c.from) : src.indexOf(c.from);
    if (at === -1) {
      console.log(`  !! ${c.id} 变异锚点未命中(${c.file}):${JSON.stringify(c.from)}`);
      bad += 1;
      continue;
    }
    writeFileSync(p, src.slice(0, at) + c.to + src.slice(at + c.from.length));
  }
  const r = runGuard(c.guard);
  const hit = r.status === 1 && r.out.includes("✗") && r.out.includes(c.expect);
  if (!hit) bad += 1;
  console.log(`  ${hit ? "✓" : "✗"} ${c.id} exit=${r.status} 期望红「${c.expect}」 —— ${c.why}`);
}
restore();

const total = cases.length;
console.log(`\n结果:${total - bad}/${total} 条断言「能被真实违规打红」`);
if (bad > 0) {
  console.error("→ 有断言打不红:要么锚错了对象(恒真),要么守卫没覆盖这处退化。修守卫,别放宽用例。");
  process.exit(1);
}
console.log("→ 全部通过。新增/修改守卫断言后请重跑本工具,并在 PR 说明里附上本输出。");
