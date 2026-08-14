#!/usr/bin/env node
// ==================== 前端浮层遮挡守卫(全局静态扫描) ====================
// 背景:el-dialog 若未 :append-to-body="true",会渲染在页面滚动容器
// (.main-scroll, position:relative; z-index:1 的 stacking context)内部,
// 其 z-index 2000+ 被困在该上下文里,对外等效 z-index 1 → 被底部播放条
// (桌面 .player-bar z-index 50 / 移动 .player-bar-mobile z-index 520)或
// 全屏播放模式(.play-mode 300/700)遮挡(v1.7.45 事故,全项目 19 处已修)。
//
// 本守卫是全项目防回归:任何 .vue 新增 el-dialog/el-drawer 等浮层组件,
// 若未按约定处理(append-to-body / teleported),CI 直接失败,阻止合入。
// 零依赖 node 脚本(无 npm install),与 check-frontend-plugins.mjs 同形态。
//
// 规则:
//   R1 el-dialog 必须显式 :append-to-body="true"(el-dialog 默认 appendToBody=false)
//   R2 el-drawer 若显式 :append-to-body="false" / :teleported="false" 则违规
//      (el-drawer 默认 appendToBody=true,显式关闭即制造同样的遮挡风险)
//   R3 el-popover/el-tooltip/el-dropdown 若显式 :teleported="false" 则违规
//      (默认 teleported=true 挂 body,关闭后同样可能被播放控件盖住)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../frontend/src");
const violations = [];

function scanFile(file) {
  const s = fs.readFileSync(file, "utf8");
  const tags = [
    { name: "el-dialog", rule: "R1" },
    { name: "el-drawer", rule: "R2" },
    { name: "el-popover", rule: "R3" },
    { name: "el-tooltip", rule: "R3" },
    { name: "el-dropdown", rule: "R3" },
  ];
  for (const { name, rule } of tags) {
    const re = new RegExp("<" + name + "[\\s\\S]*?>", "g");
    let m;
    while ((m = re.exec(s)) !== null) {
      const tag = m[0];
      const hasAppend = /append-to-body|appendToBody/.test(tag);
      const hasTeleported = /:teleported/.test(tag) || /teleported=/.test(tag);
      if (rule === "R1" && !hasAppend) {
        violations.push(`${file}: <${name}> 缺 :append-to-body="true"(R1: 渲染在页面滚动容器 stacking context 内会被播放控件遮挡)`);
      } else if (rule === "R2" && hasAppend && /append-to-body="false"|appendToBody="false"|:append-to-body="false"|:appendToBody="false"/.test(tag)) {
        violations.push(`${file}: <${name}> 显式关闭 append-to-body(R2: 会落入页面滚动容器 stacking context 被播放控件遮挡)`);
      } else if ((rule === "R2" || rule === "R3") && hasTeleported && /:teleported="false"|teleported="false"|:teleported='false'|teleported='false'/.test(tag)) {
        violations.push(`${file}: <${name}> 显式 :teleported="false"(R2/R3: 浮层不挂 body,可能被播放控件遮挡)`);
      }
    }
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith(".vue")) scanFile(full);
  }
}

walk(ROOT);

if (violations.length > 0) {
  console.error("❌ 前端浮层遮挡守卫:发现违规(任何浮层组件都必须 append-to-body/teleported,否则被播放控件遮挡):\n");
  for (const v of violations) console.error("  " + v);
  console.error(`\n共 ${violations.length} 处违规。修复方式:el-dialog 加 :append-to-body="true";el-drawer/popover/tooltip/dropdown 不要显式关闭 teleported。`);
  process.exit(1);
} else {
  console.log("✓ 前端浮层遮挡守卫:全部浮层组件均按约定处理(append-to-body / teleported 默认挂 body),无遮挡风险");
}
