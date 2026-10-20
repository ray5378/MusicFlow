#!/usr/bin/env node
// ==================== MfIcon 图标注册表守卫(名字对不上 = 图标静默变空白) ====================
//
// 背景(2026-10-20 用户实报「AirPlay 设备在前端没有图标」):
//   `frontend/src/views/Groups/index.vue` 写的是 <MfIcon name="Airplay" />,
//   而 `frontend/src/components/MfIcon.vue` 的 ICONS 注册表里根本没有 Airplay ——
//   名字拼写完全正确,只是**没在册**。于是 resolved 返回 null → 走 <slot v-else /> →
//   页面渲染出一个**空 span**:位置占着、什么都不显示。
//   同一类缺陷在仓库里还有两处(本次一并补齐):ChevronUp(流转编辑页「上移」按钮)、
//   Pin(每日推荐「转为本地歌单」)。
//
// 为什么必须钉死:这类破坏**全静默** ——
//   · 不报错、不崩溃;
//   · vue-tsc 管不到(name 是任意字符串,v-if/v-else 的解析结果不在类型系统里);
//   · 既有单测也照样绿(没人断言"这个位置渲染出了哪个图标");
//   只在肉眼看到「那块是空的」时才被发现(用户就是这么做出来的)。
//
// 三条规则:
//   R1 注册表自洽:ICONS 里的每个名字都必须有真实 lucide 组件来源(⊆ import 清单)。
//      否则「拼错的名字」会躺进注册表,它自己也成了不出声的失效项。
//   R2 引用可解析:frontend/src 下所有 <MfIcon> 的**静态** name 必须可解析 ——
//      与运行时 resolved() 同款四条路径(direct / toPascal / ALIAS / ALIAS+toPascal)。
//   R3 反向钉死:当前实际在用的三个名字(Airplay / ChevronUp / Pin)必须在册。
//      只做 R2 的话,把注册项删掉 R2 又会绿 —— 那是「两处一起坏」的假绿。
//
// 已知不覆盖(有意为之,宁少勿假):动态拼出来的 name(:name 里 template 拼接、
//   或整段表达式传 props.icon)、以及 <MfIcon> 之外同名组件的 name 属性。
//
// 零依赖 node 脚本,挂 ci.yml 的守卫 job(与 check-* 系列同款)。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const MFICON = "frontend/src/components/MfIcon.vue";
const SRC_DIR = "frontend/src";

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}

const mf = read(MFICON);

// ---------- 解析 MfIcon 的三份真源:import 清单 / ICONS / ALIAS ----------
const importsSrc = (mf.match(/import\s*\{([^}]*)\}\s*from\s*"lucide-vue-next"/) || [])[1] || "";
const imported = new Set(importsSrc.split(",").map((s) => s.trim()).filter(Boolean));
const iconsSrc = (mf.match(/const ICONS: Record<string, any> = \{([\s\S]*?)\};/) || [])[1] || "";
const inIcons = new Set(iconsSrc.split(",").map((s) => s.trim()).filter(Boolean));
const aliasSrc = (mf.match(/const ALIAS: Record<string, string> = \{([\s\S]*?)\};/) || [])[1] || "";
const alias = new Map(
  [...aliasSrc.matchAll(/([A-Za-z0-9_]+)\s*:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
);

const toPascal = (s) =>
  s.split(/[-_\s]+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

/** 与 MfIcon.vue 里 resolved() 完全同款的四条解析路径;返回命中的路径名或 null。 */
function resolveName(n) {
  if (inIcons.has(n)) return "direct";
  if (inIcons.has(toPascal(n))) return "toPascal";
  if (alias.has(n) && inIcons.has(alias.get(n))) return "alias";
  if (alias.has(toPascal(n)) && inIcons.has(alias.get(toPascal(n)))) return "aliasPascal";
  return null;
}

console.log("===== R1 注册表自洽:ICONS 每个名字都有真实 lucide 组件来源 =====");
const orphans = [...inIcons].filter((n) => !imported.has(n));
check(
  `ICONS 全部 ${inIcons.size} 项都在 lucide-vue-next 的 import 清单里`,
  inIcons.size > 0 && imported.size > 0 && orphans.length === 0,
  orphans.length
    ? `无名可解析: ${orphans.join(", ")}`
    : `注册表/import 清单解析为空(ICONS=${inIcons.size}, import=${imported.size})`,
);
// resolved() 的收尾必须是 `|| null`:名字不在册就渲染空 span。
// 若被改成「兜底成某个默认图标」(如 || ICONS.Speaker),本守卫的 R2 就永远绿 —— 那种
// 写法会让"漏注册"从静默空白变成静默错误图标,更难看穿。故把收尾钉死。
const resolvedSrc = (mf.match(/const resolved = computed\(\(\) =>([\s\S]*?)\n\}\);/) || [])[1] || "";
const resolvedTail = resolvedSrc.replace(/[\s;)]+$/, "");
check(
  "MfIcon 解析不到已知名字时返回 null(不兜底成某个默认图标,否则本守卫没意义)",
  /\|\|\s*null$/.test(resolvedTail),
  resolvedSrc ? `resolved 的收尾不是「|| null」(实际尾: ${JSON.stringify(resolvedTail.slice(-24))})` : "未找到 const resolved = computed(...) 代码块",
);

// ---------- 扫描 frontend/src 里所有 <MfIcon> 的静态 name ----------
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (extname(full) === ".vue" || extname(full) === ".ts") out.push(full);
  }
  return out;
}

/** 从 <MfIcon …> 标签片段里取**静态**名字;比较运算符右侧的字面量('group' 在
 *  `p.kind === 'group' ? …` 里)是取值条件、不是图标名,必须剔除。 */
function staticNamesOf(seg) {
  const out = [];
  for (const m of seg.matchAll(/(?<!:)\bname="([^"]*)"/g)) if (m[1]) out.push(m[1]);
  for (const m of seg.matchAll(/:name="([^"]*)"/g)) {
    const expr = m[1];
    for (const q of expr.matchAll(/'([A-Za-z0-9_-]+)'/g)) {
      const before = expr.slice(0, q.index).trimEnd();
      if (/(===|!==|==|!=|<|>)$/.test(before)) continue; // 比较运算符右侧 = 取值条件
      out.push(q[1]);
    }
  }
  return out;
}

/** 取 `&lt;MfIcon …&gt;` 的完整标签段:必须**按引号状态**找收尾 `>`,不能用 indexOf(">") ——
 *  属性表达式里出现 `>`(如 `:size="n > 2 ? 2 : n"` / `v-if="a > b"`)时,后者会把标签
 *  从比较运算符处截断,其后的 name 被整体跳过 = 假绿。 */
function tagSegment(text, start) {
  let quote = null;
  for (let i = start + 7; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === ">") return text.slice(start, i + 1);
  }
  return text.slice(start);
}

const bad = [];
const seen = new Set();
let dynamicSkipped = 0;
for (const f of walk(join(root, SRC_DIR))) {
  const rel = f.replace(root + "/", "").replace(/\\/g, "/");
  if (rel === MFICON) continue; // 组件自身的内部实现不参与引用扫描
  const text = readFileSync(f, "utf8");
  let i = text.indexOf("<MfIcon");
  while (i !== -1) {
    const seg = tagSegment(text, i);
    const line = text.slice(0, i).split("\n").length;
    const candidates = staticNamesOf(seg);
    // 动态 name(:name 里 template 拼接 / 传变量)静态分析看不准 —— 只统计、不判定,
    // 但要在输出里如实报出「有多少处被跳过」,免得读者以为覆盖率是 100%。
    if (candidates.length === 0 && /:?\bname="/.test(seg)) dynamicSkipped++;
    for (const n of candidates) {
      seen.add(n);
      if (!resolveName(n)) bad.push(`${rel}:${line} name=${n}`);
    }
    i = text.indexOf("<MfIcon", i + seg.length);
  }
}

console.log("===== R2 引用可解析:frontend/src 里 <MfIcon> 的静态 name 必须能在册 =====");
check(
  `扫到 ${seen.size} 个不同的静态 name,全部可解析`,
  bad.length === 0,
  bad.length ? `解析不到 ${bad.length} 处:\n      ` + bad.join("\n      ") : "",
);
console.log(`  · 另有 ${dynamicSkipped} 个 <MfIcon> 标签的 name 是动态表达式,静态分析不判定(见文件头「已知不覆盖」)`);

console.log("===== R3 反向钉死:确认在用的名字不得被摘掉 =====");
for (const n of ["Airplay", "ChevronUp", "Pin"]) {
  check(`已确认在用的图标 ${n} 仍在册`, resolveName(n) !== null, `${n} 解析不到`);
}

if (failures.length) {
  console.error(`\n[MfIcon 注册表守卫] FAIL:${failures.length} 项`);
  process.exit(1);
}
console.log("\n[MfIcon 注册表守卫] 全部通过");
