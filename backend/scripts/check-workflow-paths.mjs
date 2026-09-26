#!/usr/bin/env node
// ==================== 工作流/守卫脚本「路径引用」元守卫 ====================
//
// 守卫盯的是源码内容,却没人盯「内容还在不在它以为的那个文件里」。本脚本补上这一层。
//
// 为什么需要它(2026-09-27 缺陷沉淀 D13):
//   后端路由按业务域拆分(index.ts 5048 行 → 70 行装配层)后,7 处路径耦合的静态守卫
//   全部静默失同步,而它们**自己都不出声**:
//     · 假红 3 处:check-dlna-realtime.mjs、check-seek-granularity.mjs、
//       playback-chain-guard.yml 的 409 守卫 —— 都在 backend/src/routes/api/index.ts
//       里找路由内容,内容搬走后找不到 → 直接红。
//     · 假绿 3 处:playback-chain-guard.yml 的 queue-transfer 三条 grep —— 同样盯 index.ts,
//       内容是**负向断言**(断言某个坏写法不存在),文件里早就没有路由了,
//       于是「什么都没匹配到 = 通过」,实际什么都没守。
//   关键教训:这类失同步**不能只靠「路径存在吗」发现** ——
//   index.ts 拆分后仍然存在,存在性检查一路绿灯。所以本脚本有第二条规则。
//
// 两条规则:
//   R1 存在性:workflow 与 backend/scripts/**/*.mjs 里出现的仓库内路径必须真实存在。
//      含 * ? 的 glob 只校验静态前缀目录;运行期才生成的路径写进 ALLOW_MISSING(须写原因)。
//   R2 禁引用装配层:不得把「装配层文件」当作内容来源(见 FORBIDDEN_TARGETS)。
//      这类文件本身合法存在,但里面已经没有业务内容了 —— 必须改为扫目录/扫真源文件。
//
// 覆盖范围(只做能**确定**的检查,宁少勿假):
//   · 路径必须落在「边界」上(行首 / 空白 / 引号 / = ( : , 之后),
//     如此 `tests/frontend/x.test.ts` 这类「后端 cwd 下的 tests/…」不会被误判成 frontend/…。
//   · 整行注释(# / //)不参与 R2(注释里提文件名是说明,不是引用);
//     但参与 R1 —— 注释里写错的路径同样会把后来人带沟里。
// 已知不覆盖:`cd backend` / `working-directory:` 之后以 tests/ src/ 开头的相对路径
//   (cwd 语义按 YAML 执行模型推断才能确定,为避免误判暂不纳入)。
//
// 零依赖 node 脚本,挂 ci.yml 的守卫 job(与 check-* 系列同款)。
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SELF = "check-workflow-paths.mjs";

const WF_DIR = ".github/workflows";
const SCRIPT_DIRS = ["backend/scripts", "backend/scripts/lib"];

// ---------------- R1 白名单:允许「运行前不存在」的路径(每条必须写清为什么) ----------------
const ALLOW_MISSING = new Map([
  [
    "frontend/playwright-report/",
    "playwright 运行产物目录,仅在 CI 跑完 playwright test 后才有;frontend-responsive.yml 用它上传 artifact",
  ],
]);

// ---------------- R2 禁止当作「内容来源」的文件 ----------------
// 这些文件**存在且合法**,但已经不是业务内容的家了;对它们做内容匹配必然失同步。
const FORBIDDEN_TARGETS = new Map([
  [
    "backend/src/routes/api/index.ts",
    "它是路由装配层(70 行),路由内容都在 backend/src/routes/api/*.ts。" +
      "正向断言会假红(找不到)、负向断言会假绿(断言坏写法不存在,而整文件都没有路由)。" +
      "请改为扫描目录 backend/src/routes/api/(grep -r / 目录拼接读取),不要再盯单文件。",
  ],
]);

// 路径必须始于「边界」:行首 / 空白 / 引号 / = ( : ,
const BOUNDARY = String.raw`(?:^|[\s"'` + "`" + String.raw`=(:,])`;
const PREFIX = String.raw`(?:backend|frontend)/`;
const PATH_CHARS = String.raw`[A-Za-z0-9_./@*?-]+`;
const WF_TOKEN = new RegExp(BOUNDARY + "(" + PREFIX + PATH_CHARS + ")", "g");
const SCRIPT_LITERAL = new RegExp(
  String.raw`["'` + "`" + String.raw`]` + "(" + PREFIX + PATH_CHARS + ")" + String.raw`["'` + "`" + String.raw`]`,
  "g",
);

const missing = [];
const forbidden = [];
const seen = new Set();
let refs = 0;

function checkExists(rel, where) {
  const p = rel.replace(/[.,;:]+$/, "");
  if (!p) return;
  const key = where + " " + p;
  if (seen.has(key)) return;
  seen.add(key);
  refs += 1;
  if (ALLOW_MISSING.has(p)) return;
  if (p.includes("*") || p.includes("?")) {
    const staticPart = p.split(/[*?]/)[0];
    const dir = staticPart.slice(0, staticPart.lastIndexOf("/"));
    if (dir && existsSync(join(root, dir))) return;
    missing.push(where + " :: " + p + "(glob 静态前缀目录不存在: " + (dir || "-") + ")");
    return;
  }
  if (existsSync(join(root, p))) return;
  missing.push(where + " :: " + p);
}

function checkForbidden(line, where, lineNo, isComment, inSelf) {
  if (isComment || inSelf) return;
  for (const [bad, why] of FORBIDDEN_TARGETS) {
    if (line.includes(bad)) {
      forbidden.push(where + ":" + lineNo + " 把 " + bad + " 当作内容来源 —— " + why);
    }
  }
}

// ---------------- 1) .github/workflows/*.yml ----------------
const wfAbs = join(root, WF_DIR);
let wfFiles = 0;
if (existsSync(wfAbs) && statSync(wfAbs).isDirectory()) {
  for (const name of readdirSync(wfAbs).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    wfFiles += 1;
    const where = WF_DIR + "/" + name;
    const lines = readFileSync(join(wfAbs, name), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      WF_TOKEN.lastIndex = 0;
      let m;
      while ((m = WF_TOKEN.exec(line))) checkExists(m[1], where);
      checkForbidden(line, where, i + 1, line.trimStart().startsWith("#"), false);
    }
  }
}

// ---------------- 2) backend/scripts/**/*.mjs ----------------
let scriptFiles = 0;
for (const dir of SCRIPT_DIRS) {
  const abs = join(root, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
  for (const name of readdirSync(abs).sort()) {
    if (!/\.mjs$/.test(name)) continue;
    scriptFiles += 1;
    const where = dir + "/" + name;
    const lines = readFileSync(join(abs, name), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      SCRIPT_LITERAL.lastIndex = 0;
      let m;
      while ((m = SCRIPT_LITERAL.exec(line))) checkExists(m[1], where);
      checkForbidden(line, where, i + 1, line.trimStart().startsWith("//"), name === SELF);
    }
  }
}

// ---------------- 结论 ----------------
// 守卫自身必须证明「真的扫到了东西」,否则目录改名会让它静默空转。
if (wfFiles === 0 || scriptFiles === 0 || refs === 0) {
  console.error(
    "✗ 路径引用元守卫自身失效:workflow " +
      wfFiles +
      " 个 / 守卫脚本 " +
      scriptFiles +
      " 个 / 路径引用 " +
      refs +
      " 条 —— 扫描逻辑或目录约定已变,请先修元守卫本身",
  );
  process.exit(1);
}

if (forbidden.length) {
  console.error("✗ R2 失败:把装配层/已搬空的文件当作内容来源(" + forbidden.length + " 处)");
  for (const x of forbidden) console.error("  ✗ " + x);
}

if (missing.length) {
  console.error("✗ R1 失败:以下仓库内路径不存在(" + missing.length + " 条)");
  for (const x of missing) console.error("  ✗ " + x);
  console.error("  → 路径搬家/改名后必须同步这些引用;确实是运行期产物的,加进 ALLOW_MISSING 并写明原因。");
}

if (forbidden.length || missing.length) process.exit(1);

console.log(
  "✅ 路径引用元守卫通过:" +
    wfFiles +
    " 个 workflow + " +
    scriptFiles +
    " 个守卫脚本 / " +
    refs +
    " 条仓库内路径引用全部存在;" +
    "且无人把 " +
    FORBIDDEN_TARGETS.size +
    " 个装配层文件当作内容来源",
);
