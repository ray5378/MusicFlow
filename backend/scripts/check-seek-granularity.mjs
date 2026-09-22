#!/usr/bin/env node
// ==================== 拖动 seek 精度守卫（最小粒度 1 秒） ====================
//
// 契约:凡是「把用户拖动落点发往播放引擎」的 seek 目标,一律先对齐到**整秒**。
//
// 为什么是 1 秒(事故沉淀 2026-09-22):
//   服务端 sendspin 流式引擎 `GroupPump.pushLoop` 按 **25ms 帧栅格**取帧
//   (`lo = floor(pos / FRAME_MS) * frameSamples`),而滑动窗口的基准是「毫秒 → 样本」
//   换算(`PcmWindow.baseSample = floor(pos / 1000 * SR * CH)`)。**只有目标落在
//   25ms 整数倍上两者才严格相等**;否则 `lo < baseSample` → `slice()` 抛
//   `WindowEvictedError` → 主循环 `continue` 用同一游标重算 → 再抛 → **纯微任务自旋**
//   (不 await I/O) → 事件循环饿死 → 心跳/`poll` RPC 全排不上队 → 65s 看门狗 SIGKILL。
//   现场:HA 卡片 / 网页拖动进度条后播放静默死掉,而客户端正常 —— 因为客户端下发的是
//   `Duration.inSeconds`(整秒),1000 / 25 = 40,整秒必然是 25ms 的整数倍。
//
// 静默退化体质:不报错,只是「拖完没声音 / 进度条冻住」,手测极易当成网络问题 ——
// 故在 CI 钉死。这类守卫只查「函数在不在」不够,必须查**调用点接线**。
//
// 六条规则:
//   R1 后端粒度实现:backend/src/utils/seekGranularity.ts 导出 alignSeekSeconds,
//      且实现为**向下取整**(Math.floor)——与客户端 Duration.inSeconds 同语义。
//   R2 前端粒度实现:frontend/src/utils/seekGranularity.ts 同语义(两个构建根无法共享
//      源码,故各持一份;粒度常量必须同为 1 秒)。
//   R3 后端唯一入口兜底:`POST /v1/peers/:peerId/seek`(所有客户端 seek 的唯一入口)
//      必须经 alignSeekSeconds 后再下发 —— 保证任何来源都进不了非整秒目标。
//   R4 前端下发接线:每个把目标发往 `/seek` 的 POST 站点,seconds 实参必须「调用点包裹
//      alignSeekSeconds(...)」或「传入由 alignSeekSeconds 产出的局部变量(同文件可查初始化)」。
//   R5 无未识别下发形态:frontend/src 里出现的每一处 `"/seek"` 字面量都必须落在 R4
//      识别出的调用形态内 —— 手写 fetch / 换 API 封装后遗漏对齐会在这里转红。
//   R6 引擎侧帧栅格兜底仍在:streamEngine.ts 的 alignFrameMs 定义 + 四处应用
//      (play 源起点、play 游标、seek 发布位置与记忆、armSeek 装填)一处都不能少。
//
// 有意豁免(不要往这里加):前端本地播放的 `timeOffset` 重拉路径
//   (frontend/src/utils/transcodedSeek.ts)—— 它不是 seek 命令而是流重拉,走 ffmpeg -ss,
//   不经过 PcmWindow 帧栅格;0.1s 粒度是**刻意设计**(整秒 floor 会系统性丢掉 <1s 零头
//   →「定位恒偏小」),由 backend/tests/services/transcodedSeek.test.ts 锁定。
//
// 零依赖 node 脚本(与 check-renderer-host.mjs 同款),挂 ci.yml 的守卫 job。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rel = (p) => relative(root, p).replace(/\\/g, "/");

const BACKEND_UTIL = "backend/src/utils/seekGranularity.ts";
const FRONTEND_UTIL = "frontend/src/utils/seekGranularity.ts";
const BACKEND_ROUTE = "backend/src/routes/api/index.ts";
const FRONTEND_STORE = "frontend/src/stores/player.ts";
const STREAM_ENGINE = "backend/src/services/sendspin/streamEngine.ts";

const ALIGN_CALL_RE = /alignSeekSeconds\s*\(/;
// 只锚到 body 对象的左花括号,并**把右花括号一起收进捕获组**:POST 后面常跟
// `.catch(...)`,若把 `)` 写进正则会漏判;而右花括号不收进来,下游识别
// `seconds: <标识符>` 时会因为缺少结束定界符而判不出来(2026-09-22 两次实测踩到)。
const SEEK_POST_RE =
  /api\.post\(\s*peerApi\([^)]*,\s*"\/seek"\s*\)\s*,\s*\{([\s\S]{0,240}?\})/g;

const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "");
/** 剥掉注释:只审「代码里真的这么写」，注释里的示例/说明不拦。 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const violations = [];
const fail = (rule, msg) => violations.push(`${rule} ${msg}`);

/** 递归收集 frontend/src 下的 .ts/.vue(排除 util 自身与测试)。 */
function frontendSources(dir) {
  const abs = join(root, dir);
  const out = [];
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const p = join(abs, name);
    if (statSync(p).isDirectory()) out.push(...frontendSources(join(dir, name)));
    else if ([".ts", ".vue"].includes(extname(p))) out.push(p);
  }
  return out;
}

// —— R1 / R2:粒度实现必须在,且必须是向下取整的整秒 ——
for (const [rule, p] of [["R1", BACKEND_UTIL], ["R2", FRONTEND_UTIL]]) {
  const code = stripComments(read(p));
  if (!code) {
    fail(rule, `${p} 不存在（拖动 seek 目标的对齐实现被删了）`);
    continue;
  }
  if (!/export\s+function\s+alignSeekSeconds\s*\(/.test(code)) {
    fail(rule, `${p} 未导出 alignSeekSeconds`);
  }
  if (!/Math\.floor\s*\(/.test(code)) {
    fail(rule, `${p} 的 alignSeekSeconds 不是向下取整(需 Math.floor,与客户端 Duration.inSeconds 同语义)`);
  }
  if (!/SEEK_GRANULARITY_SEC\s*=\s*1\b/.test(code)) {
    fail(rule, `${p} 的粒度常量不是 1 秒(见 SEEK_GRANULARITY_SEC)`);
  }
}

// —— R3:后端 seek 唯一入口必须兜底对齐 ——
{
  const code = stripComments(read(BACKEND_ROUTE));
  const routeAt = code.indexOf('"/v1/peers/:peerId/seek"');
  if (routeAt < 0) {
    fail("R3", `${BACKEND_ROUTE} 找不到 /v1/peers/:peerId/seek 路由（被改名或搬走？）`);
  } else {
    // 取路由体（到下一个 apiRoutes.<verb>( 之前），确认下发值经对齐。
    const rest = code.slice(routeAt);
    const next = rest.slice(1).search(/apiRoutes\.(post|get|put|delete|patch)\(/);
    const body = next < 0 ? rest : rest.slice(0, next + 1);
    if (!ALIGN_CALL_RE.test(body)) {
      fail("R3", `${BACKEND_ROUTE} 的 /v1/peers/:peerId/seek 未用 alignSeekSeconds 兜底（唯一入口必须拦截非整秒目标）`);
    }
  }
}

// —— R4 / R5:前端每个下发站点都要对齐,且不允许存在未识别的下发形态 ——
{
  const files = frontendSources("frontend/src").filter((f) => rel(f) !== FRONTEND_UTIL);
  let matched = 0;
  let literals = 0;
  for (const f of files) {
    const raw = readFileSync(f, "utf8");
    const code = stripComments(raw);
    literals += (code.match(/"\/seek"/g) || []).length;
    SEEK_POST_RE.lastIndex = 0;
    let m;
    while ((m = SEEK_POST_RE.exec(code)) !== null) {
      matched += 1;
      const args = m[1];
      // 判定仍需锚定在**调用点**,但允许两种等价接线:
      //   ① 调用点直接包裹:`{ seconds: alignSeekSeconds(x) }`
      //   ② 传入由 aligner 产出的局部变量:`const t = alignSeekSeconds(x)` … `{ seconds: t }`
      //      —— 此时必须能在同文件里找到该变量的初始化点(否则就是「某处对齐过」的假象)。
      let ok = ALIGN_CALL_RE.test(args);
      if (!ok) {
        const ident = /seconds\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(args);
        if (ident) {
          const bind = new RegExp(
            `\\b(?:const|let|var)\\s+${ident[1]}\\s*=\\s*alignSeekSeconds\\s*\\(`,
          );
          ok = bind.test(code);
        }
      }
      if (!ok) {
        fail("R4", `${rel(f)} 的 /seek POST 未对齐:把目标原样发出去会让子进程微任务自旋被强杀`
          + `（实参需经 alignSeekSeconds 包裹,或传入由它产出的变量）`);
      }
    }
  }
  if (matched === 0) {
    fail("R4", "frontend/src 下未识别到任何 /seek 下发站点（路由封装被改？守卫正则需同步）");
  }
  if (literals > matched) {
    fail("R5", `frontend/src 下有 ${literals} 处 "/seek" 字面量,但只识别出 ${matched} 处已知下发形态`
      + ` —— 存在未对齐的新下发路径（或守卫正则已过期）`);
  }
}

// —— R6:引擎侧帧栅格兜底（25ms）一处都不能少 ——
{
  const code = stripComments(read(STREAM_ENGINE));
  if (!/export\s+function\s+alignFrameMs\s*\(/.test(code)) {
    fail("R6", `${STREAM_ENGINE} 的 alignFrameMs 帧栅格对齐被删（它是亚帧错位的最后一道兜底）`);
  } else if ((code.match(/alignFrameMs\s*\(/g) || []).length < 5) {
    // 1 处定义 + 4 处应用（play 源起点 / play 游标 / seek 发布+记忆 / armSeek 装填）
    fail("R6", `${STREAM_ENGINE} 的 alignFrameMs 应用点少于 4 处（有路径绕过了帧栅格对齐）`);
  }
  if (!/WindowEvictedError/.test(code)) {
    fail("R6", `${STREAM_ENGINE} 的 WindowEvictedError 淘汰护栏被删（缺了它自旋会复发）`);
  }
}

if (violations.length) {
  console.error("❌ 拖动 seek 精度守卫失败（最小粒度 1 秒）:");
  for (const v of violations) console.error(`   - ${v}`);
  console.error(
    "背景:非整秒目标会让 sendspin 子进程按 25ms 帧栅格取帧时与窗口毫秒基准错位\n" +
      "      → 纯微任务自旋 → 事件循环饿死 → 65s 看门狗 SIGKILL（拖完进度条播放静默死掉）。\n" +
      "      整秒必然是 25ms 整数倍(1000 / 25 = 40)，故所有拖拽 seek 目标一律整秒。\n" +
      "      实现见 backend/src/utils/seekGranularity.ts 与 frontend/src/utils/seekGranularity.ts。",
  );
  process.exit(1);
}
console.log(
  "✓ 拖动 seek 精度守卫:后端唯一入口兜底 + 前端下发站点全部整秒对齐,"
    + "引擎侧 alignFrameMs 帧栅格与淘汰护栏俱在",
);
