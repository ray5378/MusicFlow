// ==================== 日志等级设置(运行时可调) ====================
//
// 生产默认只出 info(见 utils/logger.ts);排障时在「设置 → 日志等级」切到 debug,
// **无需重启容器**即可让整条播放链路的明细落到 stdout(docker logs 可见),用完切回。
//
// 真源:settings 表 `log.level`(字符串,取值 debug|info|warn|error)。
// 生效方式:本模块持有一份内存镜像并注入 logger —— 启动时 applyLogLevelFromSettings()
// 读一次,PUT 保存时 saveLogLevel() 立即再注入一次。因此改库必须走这里,
// 直接 UPDATE settings 表不会即时生效(重启后才生效)。
//
// 优先级:本设置 > 环境变量 LOG_LEVEL > 默认 info。若 env 已被显式设置而设置项为空,
// 以 env 为准(镜像里 LOG_LEVEL=debug 的部署不会被误降级)。
import { getSetting, setSetting } from "./settings.js";
import {
  getLogLevel, getLogLevelSource, isLogLevel, setLogLevel,
  LOG_LEVELS, type LogLevel, type LogLevelSource,
} from "../utils/logger.js";

export const LOG_LEVEL_SETTING_KEY = "log.level";

export interface LogLevelSnapshot {
  /** 当前真正生效的级别(日志输出按它过滤)。 */
  level: LogLevel;
  /** 该级别的来源:setting(设置页)/ env(LOG_LEVEL)/ default。 */
  source: LogLevelSource;
  /** 环境变量 LOG_LEVEL 的值(合法时给出,否则 null),供 UI 提示"env 定了个值"。 */
  envLevel: LogLevel | null;
  /** 可选级别全集,前端下拉直接用,避免前后端各写一份枚举。 */
  levels: readonly LogLevel[];
  /** 设置表里存的值(未写过为 null),用于 UI 区分"跟随 env"与"被显式设过"。 */
  settingLevel: LogLevel | null;
}

/** 读出设置表里的级别(非法/未设置 → null)。 */
export function getSettingLogLevel(): LogLevel | null {
  const raw = getSetting(LOG_LEVEL_SETTING_KEY, "").trim().toLowerCase();
  return isLogLevel(raw) ? raw : null;
}

export function logLevelSnapshot(): LogLevelSnapshot {
  const envRaw = (process.env.LOG_LEVEL || "").trim().toLowerCase();
  return {
    level: getLogLevel(),
    source: getLogLevelSource(),
    envLevel: isLogLevel(envRaw) ? envRaw : null,
    levels: LOG_LEVELS,
    settingLevel: getSettingLogLevel(),
  };
}

/** 启动时调用:把 settings 表里的级别应用到 logger。幂等。 */
export function applyLogLevelFromSettings(): LogLevel {
  const lv = getSettingLogLevel();
  setLogLevel(lv);
  // 有显式设置时同步写 env:子进程在 fork 时才读 env,读不到主进程的内存覆盖。
  // 无设置(返回 null)则保持容器原有 env 不动。
  if (lv) process.env.LOG_LEVEL = lv;
  return getLogLevel();
}

/** 保存并立即生效(写库 + 注入内存 + 同步子进程)。 */
export function saveLogLevel(level: LogLevel): LogLevelSnapshot {
  setSetting(LOG_LEVEL_SETTING_KEY, level);
  setLogLevel(level);
  // 子进程(sendspin / 插件沙箱 / 音频管线)日志经 stdio inherit 同汇 docker logs,
  // 但它们各有独立的 logger 实例,只认自己启动时的 env。两路都照顾到:
  //   ① 写 process.env.LOG_LEVEL —— 让**之后 fork** 的子进程继承新等级;
  //   ② RPC 推给**已在运行**的 sendspin 子进程(它常驻,不会重新 fork)。
  process.env.LOG_LEVEL = level;
  void pushLogLevelToRunningChildren(level);
  return logLevelSnapshot();
}

/** 把等级推给已在运行的常驻子进程(sendspin)。子进程未启用/未运行/推送失败一律忽略 ——
 *  日志等级是排障辅助,绝不能因为它没送到而影响主流程。 */
async function pushLogLevelToRunningChildren(level: LogLevel): Promise<void> {
  try {
    // 动态导入:避免 logSettings ←→ sendspin 的模块环(两侧都会被 index.ts 早期加载)。
    const { sendspinSupervisor } = await import("./sendspin/supervisor.js");
    if (sendspinSupervisor.isRunning()) {
      await sendspinSupervisor.rpc("setLogLevel", { level });
    }
  } catch { /* ignore */ }
}
