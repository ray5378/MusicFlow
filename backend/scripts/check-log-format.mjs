#!/usr/bin/env node
// ==================== 日志格式 + 分级回归守卫 L1–L9 ====================
//
// 背景（2026-11-27 全后端日志重写）：此前日志格式是 `[PREFIX] LEVEL message`，
// 等级夹在中间，grep/告警规则无法按行首过滤；另有大量裸 console 与「失败打 info」
// 的错级。本次统一为 `[LEVEL] [PREFIX] message` —— 等级永远在第一段，前缀只标识来源。
//
// 这类约定**没有任何编译期/运行时报错**：写错格式照样输出、照样能看，只是告警规则
// 静默失灵。故用零依赖静态守卫钉死，与 check-speed-switch.mjs 同构（只读源码文本、
// 先剥注释、不启动服务、不连设备，秒级完成）。
//
// 九条不变量：
//   L1 输出模板行首必须是 `[${level.toUpperCase()}] [${prefix}]`，等级在前缀之前；
//   L2 输出层去重旧文案自带 `[PREFIX]` 的逻辑仍在（否则出现 `[INFO] [P] [P] ...`）；
//   L3 事件分级映射仍在：error→console.error / warn→console.warn / 其余→console.log；
//   L4 裸 console 只允许在「输出层」四处（logger.ts / sandbox.ts 的 emit、
//      sandboxWorker.ts 的 stdout 桥、sniff.ts 的零依赖调试），其余一律走 createLogger；
//   L5 四处输出层自己的模板也是 `[LEVEL] [PREFIX] ...` 开头，不得回退旧顺序；
//   L6 SPEC 第八章写明行首等级铁律 + catch 按影响分级；
//   L7 等级常量按 debug<info<warn<error 升序，供枚举/过滤共用；
//   L8 专项测试钉住行首格式（正则锚 ^），格式一改测试必红；
//   L9 关键业务路径（播放/导入/同步/鉴权）不得出现「完全空的 catch」：
//      catch 体剥离空白后必须至少有一条语句（reject/push/throw/日志/return 都算）。
//      不要求每个 catch 都打日志——SPEC 豁免条款明确允许解析容错/幂等清理/轮询兜底
//      静默，那属于语义判断，静态守卫守不住，只钉「连语句都没有」这条底线。
//
// 🔴 硬性要求：只认非注释行。源码里有大量「旧格式说明」注释，直接对原文做正则会被
//    自己的注释查红，故一律先过 lib/strip-comments.mjs。
// 🔴 放行清单必须写理由：新增裸 console 出口要先在本文件 ALLOWED_BARE_CONSOLE 登记，
//    理由写清「为什么不能走 createLogger」，避免悄悄多出一个格式不受控的出口。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const body = (rel) => stripComments(read(rel));

const LOGGER = "backend/src/utils/logger.ts";
const SANDBOX = "backend/src/plugins/sandbox.ts";
const WORKER = "backend/src/plugins/sandboxWorker.ts";
const SNIFF = "backend/src/services/fetch/sniff.ts";
const SPEC = "SPEC.md";
const TEST = "backend/tests/utils/utils.test.ts";

const failures = [];
const gaps = [];
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  const line = "  " + (ok ? "✓" : "✗") + " " + name + (ok || !detail ? "" : " —— " + detail);
  console.log(line);
  if (!ok) failures.push(name + (detail ? " —— " + detail : ""));
}
function gap(name, hint) {
  gaps.push(name + (hint ? " —— " + hint : ""));
  console.log("  ! " + name + (hint ? " —— " + hint : ""));
}

// ---------------- L1–L3 统一出口：logger.ts ----------------
console.log("[L1–L3] 统一输出层");
const logger = body(LOGGER);

check(
  "L1 输出模板行首为 [LEVEL] [PREFIX]",
  /\[\$\{level\.toUpperCase\(\)\}\] \[\$\{prefix\}\] \$\{body\}/.test(logger),
  "等级必须永远在第一行首；当前模板不符 ⇒ grep/告警按行首过滤全部失灵",
);
check(
  "L2 旧文案自带 [PREFIX] 时输出层去重仍在",
  logger.includes("const tag = `[${prefix}] `") && logger.includes("msg.startsWith(tag) ? msg.slice(tag.length) : msg"),
  "去掉去重 ⇒ `[INFO] [P] [P] ...` 双前缀；正文里旧 [TAG] 会污染行首判读",
);
check(
  "L3 error/warn/其余 分别走 console.error/warn/log",
  /if \(level === "error"\) console\.error\(line\)/.test(logger) &&
    /else if \(level === "warn"\) console\.warn\(line\)/.test(logger) &&
    /else console\.log\(line\)/.test(logger),
  "事件出口与等级脱钩 ⇒ warn 打成 info 或 error 打成 log，日志等级标志形同虚设",
);

// ---------------- L4 裸 console 白名单 ----------------
console.log("[L4] 裸 console 白名单");
// 每条必须写理由；只认「输出层」与「确实无法引 logger 的零依赖模块」。
const ALLOWED_BARE_CONSOLE = new Map([
  [LOGGER, "统一输出层本身：所有 console.* 只在这里发生，line 已在 L1 拼好等级前缀"],
  [SANDBOX, "沙箱运行时按 pluginId 动态建 logger，emit 内部自行分级输出（格式见 L5）"],
  [WORKER, "批量子进程 stdout 桥：插件 log() 直接映射 stdout，协议上不能走主进程 logger"],
  [SNIFF, "零依赖嗅探模块：刻意不引 logger 避免与 probe/integrity 加载顺序纠缠，仅 MF_SNIFF_DEBUG 下输出"],
]);

function walk(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = dir + "/" + name;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|js)$/.test(name) && !/\.test\./.test(name)) out.push(rel);
  }
  return out;
}

const bareHits = [];
for (const file of walk("backend/src")) {
  const src = body(file);
  const re = /console\.(log|info|warn|error|debug)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const lineNo = src.slice(0, m.index).split("\n").length;
    bareHits.push({ file: relative(ROOT, join(ROOT, file)), line: lineNo });
  }
}
const illegal = bareHits.filter((h) => !ALLOWED_BARE_CONSOLE.has(h.file.replace(/\\/g, "/")));
check(
  "L4 裸 console 仅在四处输出层（其余全部走 createLogger）",
  illegal.length === 0,
  illegal.length
    ? "越界: " + illegal.slice(0, 8).map((h) => `${h.file}:${h.line}`).join(" ") +
      (illegal.length > 8 ? ` ...共 ${illegal.length} 处` : "") +
      " —— 确需新增出口请先在本脚本登记理由"
    : "",
);
for (const [file, reason] of ALLOWED_BARE_CONSOLE) {
  check("L4 白名单文件实际存在: " + file, !!statSync(join(ROOT, file), { throwIfNoEntry: false }), reason);
}

// ---------------- L5 各输出层自己的模板顺序 ----------------
console.log("[L5] 四处输出层的模板顺序");
const sandbox = body(SANDBOX);
const worker = body(WORKER);
const sniff = body(SNIFF);
check(
  "L5a 沙箱 emit 行首为 [LEVEL] [PLUGIN:<id>]",
  /let line = `\[\$\{level\}\] \[PLUGIN:\$\{id\}\] \$\{msg\}`/.test(sandbox),
  "沙箱插件日志是插件排障唯一依据，格式与主 logger 分叉会让 grep 规则漏掉插件",
);
check(
  "L5b 子进程 stdout 桥行首为 [INFO] [PLUGIN-WORKER]",
  /console\.log\(`\[INFO\] \[PLUGIN-WORKER\] \$\{/.test(worker),
  "批量子进程日志走 stdout 采集，行首等级是分级过滤的唯一抓手",
);
check(
  "L5c 嗅探调试行首为 [DEBUG] [sniff]",
  /console\.log\(`\[DEBUG\] \[sniff\] \$\{/.test(sniff),
  " sniff 只在 MF_SNIFF_DEBUG 下出，但一旦输出仍须符合行首等级",
);

// 反向：不得出现旧顺序 `[PREFIX] LEVEL`（允许出现在 logger.ts 的兼容注释里，已剥掉）。
const oldOrder = /`\[[A-Za-z][A-Za-z0-9_:{}$.-]*\] \$\{(?:level|LEVEL)(?:\.toUpperCase\(\))?\}/;
for (const [tag, src] of [["logger", logger], ["sandbox", sandbox], ["worker", worker], ["sniff", sniff]]) {
  check("L5 反向 " + tag + " 无旧顺序 [PREFIX] LEVEL", !oldOrder.test(src), "旧顺序回流 ⇒ 该出口不受 L1 保护");
}

// ---------------- L6 文档 ----------------
console.log("[L6] 规范文档");
const spec = read(SPEC);
check(
  "L6a SPEC 写明等级永远在行首",
  /等级永远在行首/.test(spec) && /\[ERROR\] \[PLUGIN-JOB\]/.test(spec),
  "文档是唯一权威口径；示例退回旧顺序会把后来人带回坑里",
);
check(
  "L6b SPEC 写明 catch 按影响分级（可恢复 warn / 失败 error）",
  /可恢复降级用 `warn`/ .test(spec) && /失败\/不可恢复用 `error`/ .test(spec),
  "删掉分级条款 ⇒ 失败又被打成 info，告警与日志等级过滤都失效",
);

// ---------------- L7 等级常量 ----------------
console.log("[L7] 等级常量");
check(
  "L7 LOG_LEVELS 按 debug<info<warn<error 升序",
  /LOG_LEVELS: readonly LogLevel\[\] = \["debug", "info", "warn", "error"\]/.test(logger),
  "顺序被改 ⇒ 过滤阈值(LEVEL_RANK)与枚举不一致，运行期等级切换选错档",
);

// ---------------- L8 专项测试 ----------------
console.log("[L8] 专项测试");
const testSrc = body(TEST);
check(
  "L8 单测用 ^ 锚定 [LEVEL] [PREFIX] 行首格式",
  /\^\\\[INFO\\\] \\\[TEST-PREFIX\\\]/.test(testSrc) || /\^\[INFO\] \[TEST-PREFIX\]/.test(testSrc),
  "只 toContain 不锚行首 ⇒ 等级挪到中间仍绿，格式漂移无人拦",
);

// ---------------- L9 catch 不得静默吞异常 ----------------
console.log("[L9] catch 块不吞异常");
// 只查「关键业务路径」目录：播放/导入/同步/鉴权。这些路径静默吞异常的代价最大。
// 判据：catch 体剥离空白后必须至少有一条语句。reject(e)/results.push(失败)/continue
// 这些都是正当的异常处理（上报调用方或转下一步），不算吞；只有空块才算。
const CRITICAL_DIRS = [
  "backend/src/services/player",
  "backend/src/services/fetch",
  "backend/src/services/source",
  "backend/src/routes/api",
  "backend/src/middleware",
];
const emptyCatches = [];
for (const dir of CRITICAL_DIRS) {
  for (const file of walk(dir)) {
    const src = body(file);
    const re = /catch\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      // 花括号配平取 catch 体（只看非注释文本）
      let depth = 1;
      let i = re.lastIndex;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth += 1;
        else if (src[i] === "}") depth -= 1;
        i += 1;
      }
      const block = src.slice(re.lastIndex, i - 1);
      // 空块判定：剥离所有空白后没有任何语句。注释已被 stripComments 去掉，
      // 「只有注释的 catch」在此也会变成空块被抓出——正是我们要钉的静默吞。
      if (block.replace(/\s/g, "") === "") {
        const lineNo = src.slice(0, m.index).split("\n").length;
        emptyCatches.push(`${file}:${lineNo}`);
      }
    }
  }
}
check(
  "L9 关键业务路径 catch 不空吞（有日志/抛出/错误返回）",
  emptyCatches.length === 0,
  emptyCatches.length ? "空 catch: " + emptyCatches.slice(0, 10).join(" ") : "",
);

// ---------------------------------------------------------------------------
if (gaps.length > 0) {
  console.log(`\n! 已知缺口 ${gaps.length} 条(不阻断 CI):`);
  for (const g of gaps) console.log("  - " + g);
}
if (failures.length > 0) {
  console.error(`\n✗ check-log-format: ${failures.length}/${checks} 项不通过:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`\n✓ check-log-format: ${checks} 项全部通过`);
