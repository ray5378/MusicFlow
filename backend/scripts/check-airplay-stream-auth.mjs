#!/usr/bin/env node
// ==================== `/rest/*` 鉴权豁免 + AirPlay 取流守卫 ====================
//
// 契约:AirPlay 出流端 `/rest/airplay/stream/:token` 必须与 DLNA 端同款三条,缺一条就是
// 「AirPlay 连不上设备」这个**静默故障**:
//   ① 被 `/rest/*` 全局鉴权豁免 —— 调用方是**本机 ffmpeg 解码器**,结构上带不上任何凭据;
//   ② 豁免的合法性来自 handler 内**自校验 token**(失败 403),不是来自网络位置;
//   ③ 出流族的两处分类(慢请求预算 SLOW_MS_BY_ROUTE + 探针避让闸 isStreamRequest)同步认它,
//      否则告警噪音与探针抢带宽两件事都会复现。
//
// 为什么必须在 CI 钉死(2026-10-20 实测事故):
//   AirPlay1 投屏到 HiVi H5MKII(192.168.10.30:4515)全程 **0 字节 / 设备收不到 RTP**,
//   设备侧 mDNS/RTSP 一切正常(4515 OPTIONS 200),真正的断点却在自家:ffmpeg 回环拉
//   `/rest/airplay/stream/<token>` 吃了 `/rest/*` 鉴权中间件的 401 —— 豁免清单当时只写了
//   `/dlna/stream/` 与 `/membuf/`,漏了 airplay。破坏完全是静默的:不报错、不崩溃,
//   只是「连不上 / 没声音」,手测极易误判为设备或网络问题。
//
// 零依赖 node 脚本,挂 ci.yml 的守卫 job(与 check-* 系列同款)。
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const INDEX = "backend/src/index.ts";
const METRICS = "backend/src/middleware/metrics.ts";
const EXEMPT = "backend/src/middleware/restExempt.ts";
const REST_ROUTES = "backend/src/routes/rest/index.ts";

const EXPECTED_MARKERS = ["/dlna/stream/", "/airplay/stream/", "/membuf/"];

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}

console.log("===== R1 豁免清单单一真源(middleware/restExempt.ts) =====");
const exemptSrc = read(EXEMPT);
const arrMatch = exemptSrc.match(/REST_AUTH_EXEMPT_MARKERS\s*=\s*\[([\s\S]*?)\]/);
const markers = arrMatch ? [...arrMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
check(
  "清单恰好是三条取流端且逐字一致(新增/改名必须同步改守卫与本行)",
  JSON.stringify(markers) === JSON.stringify(EXPECTED_MARKERS),
  "实际 = " + JSON.stringify(markers),
);
check(
  "单源导出 isRestAuthExemptPath(判定只能有一处实现)",
  /export\s+function\s+isRestAuthExemptPath\s*\(/.test(exemptSrc),
);
check(
  "判定基于 includes(与既有 dlna/membuf 同一口径,不引入语义分叉)",
  /marker\s*\)\s*=>\s*path\.includes\(marker\)|path\.includes\(marker\)/.test(exemptSrc),
  "未找到 `path.includes(marker)`",
);

console.log("===== R2 index.ts 的 `/rest/*` 门禁接线 =====");
const indexCode = stripComments(read(INDEX));
const gateStart = indexCode.indexOf('app.use("/rest/*"');
const gateEnd = indexCode.indexOf('app.route("/rest", restRoutes)');
const gate = gateStart >= 0 && gateEnd > gateStart ? indexCode.slice(gateStart, gateEnd) : "";
check("能定位到 `/rest/*` 门禁块", gate.length > 0, "未找到 app.use(\"/rest/*\") … app.route(\"/rest\", restRoutes)");
check(
  "门禁走单一真源判定 isRestAuthExemptPath(c.req.path)",
  /isRestAuthExemptPath\(\s*c\.req\.path\s*\)/.test(gate),
  "门禁里未调用 isRestAuthExemptPath(c.req.path)",
);
check(
  "门禁仍以 authMiddleware 兜底(豁免之外一律鉴权)",
  /return\s+authMiddleware\(c,\s*next\)/.test(gate),
  "门禁里未见 `return authMiddleware(c, next)`",
);
check(
  "**常量断言**:旧的内联判定(裸 includes('/dlna/stream/'))已彻底移除,不得两套并存",
  !/p\.includes\("\/dlna\/stream\/"\)/.test(gate),
  "门禁里仍残留硬编码 includes('/dlna/stream/')",
);
check(
  "第二道独立门禁仍在:/rest/api/* 之上另挂 authMiddleware(豁免放松不透穿到 API 面)",
  /app\.use\("\/rest\/api\/\*",\s*authMiddleware\)/.test(indexCode),
  "缺少 app.use(\"/rest/api/*\", authMiddleware)",
);

console.log("===== R3 AirPlay 取流 handler 的自校验(token 即凭证) =====");
const restCode = stripComments(read(REST_ROUTES));
const hStart = restCode.indexOf('restRoutes.get("/airplay/stream/:token"');
const nextRoute = hStart >= 0 ? restCode.indexOf("restRoutes.get(", hStart + 10) : -1;
const handler = hStart >= 0 ? restCode.slice(hStart, nextRoute > hStart ? nextRoute : hStart + 1500) : "";
check("能定位到 /airplay/stream/:token handler", handler.length > 0);
check(
  "handler 校验自己的 token(resolveAirPlaySession)",
  /resolveAirPlaySession\s*\(/.test(handler),
  "handler 未调用 resolveAirPlaySession",
);
check(
  "token 无效/过期必须拒绝(403),不得静默出流",
  /403/.test(handler),
  "handler 未对无效 token 返回 403",
);
check(
  "出流复用共用核心 serveCastStream(kind: \"airplay\")(不复制出流逻辑)",
  /serveCastStream/.test(handler) && /kind:\s*"airplay"/.test(handler),
  "handler 未按 kind: \"airplay\" 复用 serveCastStream",
);
// 反向锚点:DLNA 端同款三件套仍在(防止只改 airplay 侧而把对照实现改坏)。
const dStart = restCode.indexOf('restRoutes.get("/dlna/stream/:token"');
const dNext = dStart >= 0 ? restCode.indexOf("restRoutes.get(", dStart + 10) : -1;
const dHandler = dStart >= 0 ? restCode.slice(dStart, dNext > dStart ? dNext : dStart + 1500) : "";
check(
  "对照实现 DLNA 端仍是「自校验 + 403」",
  /resolveCastSession\s*\(/.test(dHandler) && /403/.test(dHandler),
);

console.log("===== R4 出流族两处分类必须同步认 AirPlay =====");
const metricsCode = stripComments(read(METRICS));
check(
  "慢请求预算表含 GET /rest/airplay/stream/:token → SLOW_MS_STREAM(与 DLNA 同级)",
  /"GET \/rest\/airplay\/stream\/:token"\s*:\s*SLOW_MS_STREAM/.test(metricsCode),
);
check(
  "探针避让闸 isStreamRequest 认 /rest/airplay/stream/ 前缀",
  /p\.startsWith\("\/rest\/airplay\/stream\/"\)/.test(metricsCode),
);
check(
  "对照:DLNA 档仍在(防止改坏对照实现)",
  /"GET \/rest\/dlna\/stream\/:token"\s*:\s*SLOW_MS_STREAM/.test(metricsCode) &&
    /p\.startsWith\("\/rest\/dlna\/stream\/"\)/.test(metricsCode),
);
// 反向:不得把裸 /rest/stream 之外的东西误放进出流族(误判会静默关掉探针)。
check(
  "无泛化误判:isStreamRequest 未出现 startsWith(\"/rest/\") 这类整面放行",
  !/p\.startsWith\("\/rest\/"\)/.test(metricsCode) && !/p\.includes\("\/rest\/"\)/.test(metricsCode),
);

console.log("===== R5 用例在册(行为锁不能只靠静态断言) =====");
const exemptTest = read("backend/tests/middleware/restExempt.test.ts");
check(
  "restExempt 行为单测在册(穷举放行/拒绝两面)",
  /isRestAuthExemptPath/.test(exemptTest) && /describe\(/.test(exemptTest),
);
const metricsTest = read("backend/tests/middleware/metrics.test.ts");
check(
  "metrics 用例已覆盖 AirPlay 出流端(预算 + 避让闸)",
  /isStreamRequest\(/.test(metricsTest) && /\/rest\/airplay\/stream\//.test(metricsTest),
);

console.log("");
if (failures.length) {
  console.error("✗ `/rest/*` 鉴权豁免 + AirPlay 取流守卫失败(" + failures.length + " 条)");
  for (const f of failures) console.error("  ✗ " + f);
  console.error(
    "  → 这三条同时缺位就是「AirPlay 连不上设备」(2026-10-20 HiVi H5MKII 实测):" +
      "取流端没被豁免 → ffmpeg 吃自家 401 → 0 字节 → 设备全程收不到 RTP。",
  );
  process.exit(1);
}
console.log("✅ `/rest/*` 鉴权豁免 + AirPlay 取流守卫通过:豁免三条单一真源 / handler 自校验 403 / 出流族两处分类同步");
