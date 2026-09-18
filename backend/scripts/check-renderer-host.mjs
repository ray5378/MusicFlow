#!/usr/bin/env node
// ==================== 渲染器进程隔离守卫 ====================
//
// 契约:凡是「服务端主动推流、由墙钟节拍驱动」的渲染器(deadline-driven loop),
// 其运行时必须托管在 rendererHost 通用层的**常驻子进程**里 —— 否则主进程事件循环
// 被前端请求/后台批量任务占住时,会直接表现为掉帧、断音(reanchors 抬升)。
//
// 为什么不能一刀切要求所有渲染器:靠渲染器自己回连拉流的(DLNA 的 /rest/dlna/stream)
// 天然不占服务端节拍,进程化纯属浪费。所以本守卫只认「节拍形态」,不认目录名 ——
// 新来一个 airplay2 / cast / roon,只要写了节拍循环就自动被要求接宿主。
//
// 三条规则:
//   R1 禁止自建宿主:backend/src/services 下只允许 rendererHost/supervisor.ts 出现
//      child_process 的 fork(...);其它业务必须复用通用层,不许各写一套 supervisor。
//   R2 节拍循环必须在子进程侧:命中「deadline 循环形态」的文件,必须落在某个渲染器
//      业务的 child.ts **import 闭包**内(说明真在子进程里跑);否则要在文件里显式声明
//      豁免 `// allow-main-process-render: <理由>`(理由必填)。
//   R3 接入完整性:声明为渲染器业务的目录必须有 child.ts + supervisor.ts(用
//      RendererHostSupervisor)+ mode.ts(用 isRendererForkMode)。
//
// 零依赖 node 脚本(与 check-frontend-plugins.mjs 同款),挂 ci.yml 的守卫 job。
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, extname, resolve, dirname, relative } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICES = join(root, "backend/src/services");
const HOST_DIR_REL = "backend/src/services/rendererHost";

// 已接入通用宿主的渲染器业务(新增渲染器时在这里加一行;R3 会校验它确实接对了)。
const RENDERER_BIZ = ["sendspin", "airplay"];

// 豁免注释:必须带理由,否则无效。
const EXEMPT_RE = /\/\/\s*allow-main-process-render:\s*(\S.*)/;

// 允许出现 child_process.fork 的**唯一**位置:通用宿主自己。
const FORK_ALLOWED = [`${HOST_DIR_REL}/supervisor.ts`];

// 「deadline-driven 循环」的形态特征:三条全中才判定(避免关键词误报)。
const BEAT_SIGNS = [
  /(?:\bperformance\.now|\bDate\.now)\s*\(/, // 用墙钟裁决
  /\bsetTimeout\s*\(/, // 自己排下一拍
  /\b(?:CHUNK|FRAME|SAMPLE)[A-Z0-9_]*\b|\bsamplesPerChunk\b|\bchunkLen\b/, // 定长分块
];

const rel = (p) => relative(root, p).replace(/\\/g, "/");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (extname(p) === ".ts") out.push(p);
  }
  return out;
}

/** 剥掉注释,只审「代码里真的这么写」——注释/文档说明不拦。
 *  只删块注释与**整行**行注释:行尾 `//` 不删,免得把 `"http://…"` 这类字符串截断。 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "");

/** 文件归属的业务目录名(backend/src/services/<biz>/…),不在 services/<biz>/ 下返回 null。 */
const bizOf = (fileRel) => /^backend\/src\/services\/([^/]+)\//.exec(fileRel)?.[1] ?? null;

/** 抓模块说明符:from "x" / import("x") / import "x"。 */
function specsOf(src) {
  const out = [];
  const re = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** 把 ESM 的 `./x.js` 说明符映射回源码 `./x.ts`。 */
function toSourceFile(p) {
  const cands = [];
  if (p.endsWith(".js")) cands.push(p.slice(0, -3) + ".ts");
  cands.push(`${p}.ts`, join(p, "index.ts"));
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** 以 entry 为根的相对 import 闭包(含 entry 自身)。动态 import 一并纳入(宁可放宽不漏判)。 */
function importClosure(entry) {
  const seen = new Set();
  if (!existsSync(entry)) return seen;
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of specsOf(readFileSync(f, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const next = toSourceFile(resolve(dirname(f), spec));
      if (next) stack.push(next);
    }
  }
  return seen;
}

const violations = [];
const files = walk(SERVICES).filter((f) => !f.endsWith(".test.ts"));

// —— R1:services 下不得自建 fork(宿主独占) ——
for (const f of files) {
  if (FORK_ALLOWED.includes(rel(f))) continue;
  const code = stripComments(readFileSync(f, "utf8"));
  const importsCp = /(?:from\s+|require\()\s*["'](?:node:)?child_process["']/.test(code);
  if (importsCp && /\bfork\s*\(/.test(code)) {
    violations.push(`${rel(f)} — 自建 fork(进程宿主必须复用 rendererHost,不许各写一套)`);
  }
}

// —— R3 + 子进程闭包:每个渲染器业务都得接对通用宿主 ——
const childClosures = new Map(); // biz -> Set(files)
for (const biz of RENDERER_BIZ) {
  const dir = join(SERVICES, biz);
  const child = join(dir, "child.ts");
  const supervisor = join(dir, "supervisor.ts");
  const mode = join(dir, "mode.ts");

  if (!existsSync(child)) {
    violations.push(`backend/src/services/${biz}/child.ts — 渲染器业务缺少子进程入口(必须接 rendererHost)`);
  } else {
    childClosures.set(biz, importClosure(child));
  }
  if (!existsSync(supervisor) || !readFileSync(supervisor, "utf8").includes("RendererHostSupervisor")) {
    violations.push(`backend/src/services/${biz}/supervisor.ts — 未使用通用宿主 RendererHostSupervisor`);
  }
  if (!existsSync(mode) || !readFileSync(mode, "utf8").includes("isRendererForkMode")) {
    violations.push(`backend/src/services/${biz}/mode.ts — 未使用通用模式判定 isRendererForkMode`);
  }
}

const inSomeChildClosure = (f) => {
  for (const set of childClosures.values()) if (set.has(f)) return true;
  return false;
};

// —— R2:节拍循环必须落在**本业务自己**的子进程侧 ——
// ⚠️ 不能只判「落在任一渲染器闭包内」:各业务的模块图互相引用(实测 sendspin 的 child
// 闭包里就含 airplay/raop.ts),那样会让"谁都没接宿主"的漏判混过去。按目录归属判定。
for (const f of files) {
  const fileRel = rel(f);
  if (fileRel.startsWith(`${HOST_DIR_REL}/`)) continue; // 宿主自身不算业务负载
  const raw = readFileSync(f, "utf8");
  const code = stripComments(raw);
  if (!BEAT_SIGNS.every((re) => re.test(code))) continue; // 非节拍循环,放行

  const owner = bizOf(fileRel);
  if (owner && RENDERER_BIZ.includes(owner)) {
    if (childClosures.get(owner)?.has(f)) continue; // 已在本业务常驻子进程里跑
  } else if (inSomeChildClosure(f)) {
    continue; // 新目录但已被某个渲染器的子进程闭包吸收
  }

  const exempt = EXEMPT_RE.exec(raw);
  if (exempt && exempt[1].trim()) continue; // 显式豁免且带理由
  violations.push(
    `${fileRel} — 疑似墙钟节拍循环,但不在` +
      (owner && RENDERER_BIZ.includes(owner) ? ` ${owner} ` : "任何渲染器") +
      `子进程的 import 闭包内(要么把该运行时接进 rendererHost 的常驻子进程,` +
      `要么加豁免注释 \`// allow-main-process-render: <理由>\`)`,
  );
}

if (violations.length) {
  console.error("❌ 渲染器进程隔离守卫失败:");
  for (const v of violations) console.error(`   - ${v}`);
  console.error(
    "背景:节拍驱动的推流运行时留在主进程会被 Web 请求/批量任务阻塞 → 掉帧断音。\n" +
      "通用宿主见 backend/src/services/rendererHost/(照 sendspin 的接线抄即可)。",
  );
  process.exit(1);
}
console.log(
  `✓ 渲染器进程隔离守卫:services 无自建 fork;${RENDERER_BIZ.length} 个渲染器业务均已接入通用宿主,` +
    `节拍循环全部落在子进程侧`,
);
