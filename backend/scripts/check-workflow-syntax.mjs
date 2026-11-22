#!/usr/bin/env node
// ==================== workflow 结构守卫（重复键 / 悬挂 step 属性） ====================
//
// 2026-11-22 实际事故：给 job 插新 step 时把「- name: …」和它的「run: …」拆开了，
// 结果同一个 step 里出现**两个 run 键**：
//
//   - name: 校验 workflow 与守卫脚本引用的仓库内路径均存在
//   # 注释…
//   - name: 校验运行身份契约(…)
//     run: node …check-runtime-identity.mjs
//     run: node …check-workflow-paths.mjs        ← 悬挂在上一个 step 里，重复键
//
// PyYAML 这类宽松解析器会「后者覆盖前者」静默通过，GitHub 则直接判
// 「This run likely failed because of a workflow file issue」——整个 workflow 的
// **所有** job 一起不跑（比某条断言红严重得多，而且本地脚本根本发现不了）。
//
// 本守卫用零依赖的行扫描抓这一类：同一个 step 块里 `run:` / `name:` / `uses:`
// 不得出现两次。不做通用 YAML 校验（那是 GitHub 的事），只钉「插入新 step 时最常见的
// 手误」，命中即红并打印行号。
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WF_DIR = join(root, ".github/workflows");

const failures = [];
let files = 0;

for (const f of readdirSync(WF_DIR).filter((x) => x.endsWith(".yml") || x.endsWith(".yaml"))) {
  files += 1;
  const lines = readFileSync(join(WF_DIR, f), "utf8").split("\n");
  let stepIndent = -1;
  let stepStart = 0;
  let stepKeys = new Map(); // key -> 首次出现行号

  const flush = () => {
    for (const [k, first] of stepKeys) {
      if (k.startsWith("__dup__")) {
        const [key, secondLine] = k.slice(7).split("@");
        failures.push(
          `${f}:${secondLine} 同一 step 内重复键 \`${key}\`（首次出现在第 ${first} 行）—— ` +
            `GitHub 会判定整个 workflow 文件无效`,
        );
      }
    }
    stepKeys = new Map();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^(\s*)- /.exec(line);
    if (m) {
      const indent = m[1].length;
      // steps 列表项：与当前 step 同缩进的 `- ` 开启新 step；更深的是嵌套列表（如 args），不动。
      if (stepIndent === -1 || indent <= stepIndent) {
        flush();
        stepIndent = indent;
        stepStart = i + 1;
      }
      continue;
    }
    if (stepIndent === -1) continue;
    // step 块内的属性行：缩进 = stepIndent + 2
    const keyM = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):/.exec(line);
    if (!keyM) continue;
    if (keyM[1].length !== stepIndent + 2) continue;
    const key = keyM[2];
    if (key === "name" || key === "run" || key === "uses" || key === "with" || key === "env") {
      const isSingleton = key === "name" || key === "run" || key === "uses";
      if (isSingleton && stepKeys.has(key)) {
        stepKeys.set(`__dup__${key}@${i + 1}`, stepKeys.get(key));
      } else if (!stepKeys.has(key)) {
        stepKeys.set(key, i + 1);
      }
    }
  }
  flush();
}

if (failures.length > 0) {
  console.log(`[workflow 结构守卫] FAIL:${failures.length} 项 —— 这些文件在 GitHub 上会整体失效`);
  for (const x of failures) console.log("  · " + x);
  process.exit(1);
}
console.log(`[workflow 结构守卫] ${files} 个 workflow 文件无重复 step 键（run/name/uses 各至多一次）`);
