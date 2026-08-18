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
// 级别控制:LOG_LEVEL 环境变量(debug|info|warn|error),默认 info。
// 输出格式:[PREFIX] LEVEL message key=value key=value ...
// 关键约定(SPEC 第八章):所有 catch 必须打 error 且含关键入参,禁止吞异常。
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL: LogLevel = "info";

/** 当前生效级别:每次调用读 env(运行期可调,测试可注入)。 */
function currentLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase() as LogLevel;
  return LEVEL_RANK[v] !== undefined ? v : DEFAULT_LEVEL;
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
    if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel()]) return;
    const line = `[${prefix}] ${level.toUpperCase()} ${msg}${fmtFields(fields)}`;
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
