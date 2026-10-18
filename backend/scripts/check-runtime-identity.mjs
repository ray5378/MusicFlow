#!/usr/bin/env node
// ==================== 运行身份守卫 ====================
//
// 本脚本锁的是 2026-10-18「让 compose 模板彻底不再出现 PUID / PGID」改动的**静默失效契约**。
// 这条链坏掉**不报任何错**,只会在容器启动后悄悄改变运行身份:
//   R1 默认身份:镜像不设 user: 时 entrypoint 必须默认取「当前进程身份」($(id -u) / $(id -g)),
//      即默认 root。若把默认值改回镜像内 musicflow(100/101),容器改以非 root 启动 →
//      标签修复又退回 `ffmpeg 写标签失败(exit=243) ... Permission denied`,而这正是本改动
//      要根治的生产事故。
//   R2 chown 前置:绑定挂载错属主探测与预装插件的两处 chown -R 必须带「当前身份为 root」
//      条件 —— 非 root 启动时目标身份即当前身份、既无必要、权限也不足,chown 失败会配合
//      set -e 直接终止容器。
//   R3 降权段:必须有「目标身份 == 当前身份则直接 exec」分支,否则非 root 启动下 su-exec
//      报 `setgroups: Operation not permitted`(music-dl 同款问题的成因)。
//   R4 模板洁净:docker-compose.yml / README.md 的模板不得再出现 PUID / PGID 环境变量行
//      (出现即说明又退回「必须手写 PUID=0 才能跑」的旧形态);README 必须给出 user: 换身份写法。
//
// 判定口径:本脚本覆盖的三个文件(sh / yaml / md)**都没有 TS 注释语义**,故一律用**原样行**
// (仅去首尾空白),不引 strip-comments —— 后者会把 entrypoint 里 `data/*; do` 的 `/*`
// 当成块注释起点,一路吞到下一个 `*/`,实测会把降权段整段吃掉导致守卫**假红**
// (与 check-home-perf.mjs 的 mustCountRaw 同一条理由)。
// 零依赖 node,挂 ci.yml 的 runtime-identity-guard 作业;每条断言都做过双向变异验证(改坏必红)。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const ENTRYPOINT = "backend/entrypoint.sh";
const COMPOSE = "docker-compose.yml";
const README = "README.md";

const errors = [];
let checks = 0;

function textOf(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    errors.push(`缺少文件：${rel}`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

/** 原样行（去首尾空白、丢空行）—— 不剥注释，理由见文件头「判定口径」。 */
function rawLines(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function mustMatch(rel, re, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  if (!rawLines(text).some((l) => re.test(l))) errors.push(`${rel}: ${why}`);
}

function mustNotMatch(rel, re, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const hit = rawLines(text).find((l) => re.test(l));
  if (hit) errors.push(`${rel}: ${why} —— 命中: ${hit.slice(0, 120)}`);
}

function mustCount(rel, re, n, why) {
  checks += 1;
  const text = textOf(rel);
  if (!text) return;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const c = (text.match(g) || []).length;
  if (c !== n) errors.push(`${rel}: ${why} —— 期望 ${n} 处，实际 ${c} 处`);
}

// ---------- R1 默认身份 = 当前进程身份（默认 root） ----------
mustMatch(
  ENTRYPOINT,
  /PUID="\$\{PUID:-\$\(id -u\)\}"/,
  'PUID 默认值必须取当前进程身份 $(id -u)（镜像不设 user: 时即 root；改回镜像内 musicflow 的 100 会让容器以非 root 启动，标签修复复发 ffmpeg 写标签 Permission denied）',
);
mustMatch(
  ENTRYPOINT,
  /PGID="\$\{PGID:-\$\(id -g\)\}"/,
  "PGID 默认值必须取当前进程身份 $(id -g)（同上）",
);
mustNotMatch(ENTRYPOINT, /echo 100/, "PUID 不得退回「查不到 musicflow 用户就取值 100」的旧回退（否则默认又变成非 root）");
mustNotMatch(ENTRYPOINT, /echo 101/, "PGID 不得退回旧回退 101（同上）");

// ---------- R2 两处 chown 必须带「当前身份为 root」前置 ----------
mustMatch(
  ENTRYPOINT,
  /if \[ "\$\(id -u\)" = "0" \] && \[ "\$PUID" != "0" \] && \[ -d \/app\/backend\/data \]; then/,
  "绑定挂载错属主探测的 chown 必须带「当前身份为 root」前置（非 root 启动时 chown 因权限不足失败，会被 set -e 打死）",
);
mustMatch(
  ENTRYPOINT,
  /if \[ "\$\(id -u\)" = "0" \] && \[ "\$PUID" != "0" \]; then/,
  "预装插件的 chown 同样必须带「当前身份为 root」前置",
);
mustCount(
  ENTRYPOINT,
  /\[ "\$\(id -u\)" = "0" \] && \[ "\$PUID" != "0" \]/,
  2,
  "两处 chown -R 都必须带「当前身份为 root」前置，缺一处即非 root 启动会崩",
);

// ---------- R3 降权段：身份一致直接 exec ----------
mustMatch(ENTRYPOINT, /cur_uid="\$\(id -u\)"/, "降权段必须取当前身份 cur_uid（用于判断是否真需要 su-exec）");
mustMatch(
  ENTRYPOINT,
  /if \[ "\$PUID" = "\$cur_uid" \] && \[ "\$PGID" = "\$cur_gid" \]; then/,
  "降权段必须有「目标身份 == 当前身份则直接 exec」分支（否则非 root 启动下 su-exec 报 setgroups: Operation not permitted）",
);
mustMatch(
  ENTRYPOINT,
  /exec su-exec "\$PUID:\$PGID" node dist\/index\.js/,
  "显式指定了不同身份时仍须用 su-exec 切换（换身份能力不得丢失）",
);
mustNotMatch(
  ENTRYPOINT,
  /\$PUID" = "0" \]; then/,
  "降权段不得退回 `PUID=0 才不降权` 的旧判定（非 root 启动会走 su-exec 报错）",
);

// ---------- R4 模板洁净：compose / README 不得再出现 PUID / PGID 环境变量行 ----------
mustNotMatch(COMPOSE, /^-\s*PUID=/, "docker-compose.yml 模板不得再出现 `- PUID=...` 环境变量行（默认身份已跟随容器身份，无需显式配置）");
mustNotMatch(COMPOSE, /^-\s*PGID=/, "docker-compose.yml 模板不得再出现 `- PGID=...` 环境变量行");
mustNotMatch(README, /^-\s*PUID=/, "README 的 compose 示例不得再出现 `- PUID=...` 行");
mustNotMatch(README, /^-\s*PGID=/, "README 的 compose 示例不得再出现 `- PGID=...` 行");
mustMatch(README, /user: "1000:1000"/, 'README 必须给出换身份的正确写法 `user: "1000:1000"`（否则用户又回去写 PUID/PGID）');

if (errors.length) {
  console.error(`✗ 运行身份守卫失败：${errors.length} 项违规（共 ${checks} 条断言）`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log(
  `✅ 运行身份守卫通过：${checks} 条断言全部成立（默认身份 = 当前进程身份 / 两处 chown 需 root / 身份一致不降权 / 模板无 PUID-PGID）。`,
);
