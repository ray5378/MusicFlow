// ==================== 结构化日志(零依赖) ====================
//
// 用途:统一日志前缀 / 级别 / 结构化字段,SPEC 第八章可观测性规范的基础设施。
// 新代码一律用本模块,不再裸 console.log/console.error。
//
// 用法:
//   const log = createLogger("ORPHAN-PRUNE");
//   log.info("首轮清理完成", { deviceCount: 3, groupCount: 1 });
//   log.error("清理出错", { err: e?.message, userId });
//
// 级别控制(优先级从高到低,2026-09-21 起支持运行期切换):
//   1) **运行期覆盖** —— 前端「设置 → 日志等级」写入 settings 表 `log.level`,
//      启动时与每次保存后经 setLogLevel() 注入本模块(见 services/logSettings.ts)。
//      排障时无需重启容器,切到 debug 即出全链路明细,用完切回 info 即可。
//   2) **环境变量** LOG_LEVEL(debug|info|warn|error)—— 未设置运行期覆盖时的取值。
//   3) 默认 info。
// 输出格式:[PREFIX] LEVEL message key=value key=value ...
// 请求级追踪:debug 行会自动带上当前请求的 `tid=`(见下方 runWithTrace),
//   一次拖动/一次投屏打出的多条日志可用同一个 tid 串成一条链路。
// 关键约定(SPEC 第八章):所有 catch 必须打 error 且含关键入参,禁止吞异常。
import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 合法级别全集(升序严重度),供管理端枚举与校验共用。 */
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL: LogLevel = "info";

/** 运行期覆盖级别。null = 未设置(回落到 LOG_LEVEL 环境变量,再回落默认)。 */
let runtimeLevel: LogLevel | null = null;

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === "string" && LEVEL_RANK[v as LogLevel] !== undefined;
}

/** 设置运行期覆盖级别;传 null 撤销覆盖(回到 env/默认)。 */
export function setLogLevel(level: LogLevel | null): void {
  runtimeLevel = level;
}

/** 当前生效级别。每次调用重新解析(测试可直接改 process.env 注入)。 */
export function getLogLevel(): LogLevel {
  if (runtimeLevel) return runtimeLevel;
  const v = (process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase();
  return isLogLevel(v) ? v : DEFAULT_LEVEL;
}

export type LogLevelSource = "setting" | "env" | "default";

/** 当前级别的来源,供设置页显示"这个值是谁定的"。 */
export function getLogLevelSource(): LogLevelSource {
  if (runtimeLevel) return "setting";
  return isLogLevel((process.env.LOG_LEVEL || "").toLowerCase()) ? "env" : "default";
}

// ==================== 请求级追踪(tid) ====================
// 每个 HTTP 请求生成一个短 id 放进 AsyncLocalStorage,debug 行自动附加 `tid=`;
// 这样「一次拖动」在 HTTP 入口 / QueueController / DLNA SOAP / sendspin 各层
// 打出的日志能被同一 tid 串起来 —— 排查并发重投风暴时是刚需。
// 注意:ALS 只沿 async 调用链传播;请求返回后由定时器(5s 轮询等)触发的日志
// 没有 tid 属正常(那不是这次拖动的一部分)。
const traceStore = new AsyncLocalStorage<string>();

/** 在指定 tid 上下文中执行(HTTP 中间件用;测试亦可手动包裹)。 */
export function runWithTrace<T>(tid: string, fn: () => T): T {
  return traceStore.run(tid, fn);
}

/** 当前上下文 tid(无则 undefined)。 */
export function currentTrace(): string | undefined {
  return traceStore.getStore();
}

function fmtFields(fields?: Record<string, unknown>): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "object") {
      try { parts.push(`${k}=${JSON.stringify(v)}`); } catch { parts.push(`${k}=[object]`); }
    } else {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.length ? " " + parts.join(" ") : "";
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** 创建一个带前缀的 logger。prefix 沿用既有日志标签习惯(如 "ORPHAN-PRUNE")。 */
export function createLogger(prefix: string): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[getLogLevel()]) return;
    let line = `[${prefix}] ${level.toUpperCase()} ${msg}${fmtFields(fields)}`;
    // tid 只挂在 debug 行上:info/warn/error 是给人看的关键事件,不该被 trace 噪音污染。
    if (level === "debug") {
      const tid = traceStore.getStore();
      if (tid) line += ` tid=${tid}`;
    }
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
