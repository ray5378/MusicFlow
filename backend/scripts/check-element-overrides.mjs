#!/usr/bin/env node
// ==================== Element Plus 暗色覆写守卫(全局静态扫描) ====================
// 背景:MusicFlow 走自定义暗色玻璃主题,但项目用的是 Element Plus 组件库。
// 任何 el-* 组件若没在 global.scss 显式覆写,会用 EP 默认白色/浅色样式,
// 在深色背景下面"漂浮一块白"或"半透明透出底层",用户感知不到或刺眼
// (v1.7.59 事故:el-message-box 漏覆写 → 加入库二次确认弹窗底色全透明)。
//
// 本守卫是全项目防回归:
//   - 扫描 frontend/src/**/*.{vue,ts} 列出所有用到的 el-* 组件
//   - 解析 global.scss 列出所有 .el-* 覆写
//   - 对比差集,按严重度分类(P0 弹层/遮罩 / P1 表单控件 / P2 装饰)
//   - P0 缺失 → exit 1,阻断合入
//   - P1/P2 缺失 → 警告 + 列出建议覆写片段,exit 0
// 零依赖 node 脚本(无 npm install),与 check-frontend-overlays.mjs 同形态。
//
// 用法:
//   node backend/scripts/check-element-overrides.mjs          # 全量报告
//   node backend/scripts/check-element-overrides.mjs --strict # P0/P1 都 fail
//
// CI 接入:.github/workflows/ci.yml 在"前端构建"前跑一次。

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../frontend");
const FRONT_SRC = path.join(ROOT, "src");
const GLOBAL_SCSS = path.join(FRONT_SRC, "assets/styles/global.scss");

const STRICT = process.argv.includes("--strict");

// 严重度分类 —— 新增 el-* 组件时把名字归到对应桶;严重度高的就报警。
const SEVERITY = {
  // P0: 弹层/遮罩/模态 —— 用户感知"透明度"问题的核心。漏一个直接可见。
  P0: new Set([
    "el-message-box", "el-message", "el-dialog", "el-drawer",
    "el-popover", "el-popper", "el-tooltip", "el-popconfirm",
    "el-dropdown-menu", "el-select", "el-option",
    "el-cascader", "el-date-picker", "el-time-picker", "el-time-select",
    "el-color-picker", "el-tree-select", "el-tree",
    "el-overlay", "el-overlay-dialog", "el-overlay-event",
    "el-image-viewer", "el-loading-mask", "el-loading-spinner",
  ]),
  // P1: 表单/交互控件 —— 有可见表面或对比问题,通常较隐式但能看出。
  P1: new Set([
    "el-button", "el-input", "el-input-number", "el-textarea",
    "el-checkbox", "el-radio", "el-radio-group", "el-switch",
    "el-slider", "el-segmented", "el-table", "el-table-column",
    "el-tag", "el-card", "el-form", "el-form-item",
    "el-progress", "el-alert", "el-pagination", "el-empty",
    "el-descriptions", "el-descriptions-item",
    "el-tabs", "el-tab-pane", "el-menu", "el-menu-item",
    "el-submenu", "el-badge", "el-rate", "el-upload",
  ]),
  // P2: 装饰/容器 —— 默认样式一般能用,深色下轻微违和;可忽略。
  P2: new Set([
    "el-icon", "el-divider", "el-link", "el-affix", "el-anchor",
    "el-container", "el-header", "el-main", "el-aside", "el-footer",
    "el-row", "el-col", "el-image", "el-skeleton", "el-skeleton-item",
    // el-dropdown / el-dropdown-item 是触发器容器/项,无独立表面,
    // 真正可见的面板走 el-dropdown-menu(el-popper),已覆写,故归 P2。
    "el-dropdown", "el-dropdown-item",
  ]),
};

// 已知的非样式类元素(指令/常量),扫描到就忽略,避免误报
const NOISE = new Set([
  "el-loading-directive", "el-icon--right", "el-icon--upload",
]);

// 组件名 → 实际渲染的 CSS class(若不同)。el-option 组件名跟渲染 class 不同
// (element-plus 把 <el-option> 渲染成 .el-select-dropdown__item),前者对守卫
// 不可见,所以白名单记下来。组件和渲染 class 都检查一遍才算"已覆写"。
const RENDER_AS = {
  "el-option": ["el-select-dropdown__item"],
  "el-dropdown-item": ["el-dropdown-menu__item"],
  "el-descriptions-item": ["el-descriptions__label", "el-descriptions__content"],
  "el-table-column": ["el-table__cell", "el-table__column"],
  "el-tab-pane": [], // 纯容器,无独有 class
  "el-form-item": ["el-form-item__label", "el-form-item__content"],
  "el-menu-item": ["el-menu-item"],
  "el-input-number": ["el-input-number"],
  "el-image-viewer": ["el-image-viewer__wrapper"],
};

// ---------- 1. 扫描已用组件 ----------
const used = new Set();
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      walk(p);
    } else if (/\.(vue|ts|tsx|js|mjs)$/.test(entry.name)) {
      const s = fs.readFileSync(p, "utf8");
      // <el-xxx ...> 标签
      for (const m of s.matchAll(/<el-[a-z][a-z0-9-]*\b/gi)) used.add(m[0].slice(1).toLowerCase());
      // ElXxx 组件引用 / import
      for (const m of s.matchAll(/\bEl[A-Z][A-Za-z]+\b/g)) {
        used.add("el-" + m[0].slice(2).replace(/[A-Z]/g, (c, i) => (i ? "-" : "") + c.toLowerCase()).replace(/-+/g, "-").replace(/^-/, ""));
      }
    }
  }
}
walk(FRONT_SRC);

// ---------- 2. 解析 global.scss 覆写 ----------
const styled = new Set();
{
  const s = fs.readFileSync(GLOBAL_SCSS, "utf8");
  // 支持 BEM 修饰: .el-dialog__header / .el-button--primary / .el-select-dropdown__item
  for (const m of s.matchAll(/\.el-[a-z][a-z0-9_-]*/gi)) {
    const sel = m[0].slice(1).toLowerCase();
    styled.add(sel);
    // 同时添加基名(.el-checkbox__input → .el-checkbox),覆盖带 __ 或 -- 修饰的组件
    const base = sel.split(/__|--/)[0];
    if (base && base !== sel) styled.add(base);
  }
}

// ---------- 3. 计算差集并按严重度分类 ----------
function severityOf(name) {
  if (SEVERITY.P0.has(name)) return "P0";
  if (SEVERITY.P1.has(name)) return "P1";
  if (SEVERITY.P2.has(name)) return "P2";
  return "P?"; // 未归类 —— 提醒补到桶里
}

const missing = [...used]
  .filter((n) => {
    if (styled.has(n)) return false;
    if (NOISE.has(n)) return false;
    // 组件名不同 → 渲染 class 同 → 视为已覆写
    const aliases = RENDER_AS[n];
    if (aliases && aliases.some((a) => styled.has(a))) return false;
    return true;
  })
  .sort();

const p0 = missing.filter((n) => severityOf(n) === "P0");
const p1 = missing.filter((n) => severityOf(n) === "P1");
const p2 = missing.filter((n) => severityOf(n) === "P2");
const unclassified = missing.filter((n) => severityOf(n) === "P?");

// ---------- 4. 输出 ----------
const BOLD = (s) => process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s;
const RED = (s) => process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const YEL = (s) => process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const GRY = (s) => process.stdout.isTTY ? `\x1b[90m${s}\x1b[0m` : s;

console.log(BOLD("Element Plus 暗色覆写守卫"));
console.log(`  scanned:   ${used.size} components used in ${walk.cnt ?? "frontend"}`);
console.log(`  styled:    ${styled.size} selectors in ${path.relative(ROOT, GLOBAL_SCSS)}`);
console.log(`  missing:   ${missing.length} (P0=${p0.length} P1=${p1.length} P2=${p2.length} unclassified=${unclassified.length})`);
console.log("");

function showBucket(name, list, color) {
  if (!list.length) return;
  console.log(color(BOLD(`${name} (${list.length})`)));
  for (const n of list) console.log(`  ${color("✗")} ${n} ${GRY("(used but no ." + n + " rule in global.scss)")}`);
  console.log("");
}
showBucket("P0 — 弹层/遮罩/模态(必须覆写,缺则 exit 1)", p0, RED);
showBucket("P1 — 表单/交互控件(强烈建议覆写)", p1, YEL);
showBucket("P2 — 装饰/容器(可选,默认多数可用)", p2, GRY);
showBucket("P? — 未归类(请补到 SEVERITY 桶)", unclassified, YEL);

const fail = p0.length > 0 || (STRICT && p1.length > 0);
if (fail) {
  console.log(RED(BOLD("✘ check failed")));
  if (p0.length) console.log(RED(`  P0 未覆写 ${p0.length} 个 —— 在 frontend/src/assets/styles/global.scss 加 .${p0[0]} { ... }`));
  process.exit(1);
} else {
  console.log((p1.length ? YEL : GREEN_OR_EMPTY)(BOLD(p1.length ? "✓ check passed (with P1 warnings)" : "✓ check passed — all used el-* components have dark theme overrides")));
}

function GREEN_OR_EMPTY(s) {
  if (p1.length) return s;
  return process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s;
}