// ==================== Sendspin 解码链路 Debug 日志(可选开关,保留 1 天) ====================
//
// 用途:排查「播放不稳」时,把解码/转码链路的**异常与波动**按时间线留证:
//   - ffmpeg 非正常退出(退出码 + stderr 尾巴 + 已解码时长 + 存活时长)
//   - 启动失败 / 进程错误 / 一次性解码(TTS/整包)失败
//   - 波动:滑动窗口背压暂停/恢复、开始淘汰、seek 重建、推帧中断、提前 EOF
//   - 生命周期:ffmpeg.spawn / ffmpeg.eof / play.start / play.finished 等
//   - streamEngine logSafe 的全部 warn/error(既有排障口径自动入册)
//
// 设计:
//   - 开关:插件配置 debug_log(默认**关**)。内存缓存 5s + 起播时强制刷新,
//     Web 改完 ≤5s 生效,无需重启;关闭时 record 全部 no-op(一次布尔判断,零开销)。
//   - 落盘:DATA_DIR/logs/sendspin-debug.log(JSONL,一行一条);单文件超上限轮转 .1;
//     **保留 1 天**:按 mtime 清理超 24h 的 sendspin-debug* 文件(写时每 10min 清一次)。
//   - 内存:环形缓冲 2000 条 + 24h TTL,供 REST 接口直接吐出(文件读不到也能看)。
//   - 每条含 ISO 时间 + kind + 消息 + 结构化字段(原因/位置/码率等),人可读也可机读。
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../../utils/env.js";

/** 保留时长:1 天(内存与文件同口径)。 */
export const SENDSPIN_DEBUG_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 单文件上限,超过轮转为 .1(留一份)。环境变量可覆盖(测试用)。 */
const MAX_FILE_BYTES = Number(process.env.SENDSPIN_DEBUG_MAX_FILE_BYTES) || 16 * 1024 * 1024;
const MAX_MEM_ENTRIES = 2000;
/** 文件清理间隔(写路径上做,不额外起定时器)。 */
const FILE_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const FILE_BASENAME = "sendspin-debug";
/** 开关读取缓存(与 prefillBufferMs 同口径:Web 改完 ≤5s 生效)。 */
const CONFIG_CACHE_MS = 5000;

export interface SendspinDebugEntry {
  ts: string;
  kind: string;
  msg: string;
  fields?: Record<string, unknown>;
}

let enabled = false;
const mem: SendspinDebugEntry[] = [];
let lastFilePruneAt = 0;
/** 写盘失败后停写(避免每个事件都抛一次 IO 错);内存照记。 */
let fileBroken = false;
/** 开关探测缓存:5s 内不重复读插件配置。 */
let cfgProbeAt = 0;
let cfgProbeInflight: Promise<void> | null = null;

export function isSendspinDebugEnabled(): boolean {
  return enabled;
}

export function setSendspinDebugEnabled(v: boolean): void {
  enabled = v;
}

/** 从插件配置刷新开关(动态 import 防 index↔debugLog 静态循环)。
 *  推流循环每 5s 顺带调一次;play() 起播时强制 await 一次,保证
 *  「刚打开开关就播」也能录到本曲全部事件。 */
export function refreshSendspinDebugEnabled(): Promise<void> {
  const now = Date.now();
  if (cfgProbeInflight) return cfgProbeInflight;
  if (now - cfgProbeAt < CONFIG_CACHE_MS) return Promise.resolve();
  cfgProbeAt = now;
  cfgProbeInflight = (async () => {
    try {
      const { readSendspinPluginConfig } = await import("./index.js");
      const want = readSendspinPluginConfig().debugLog === true;
      if (want !== enabled) {
        enabled = want;
        recordSendspinDebug("debug_log.state", want ? "解码调试日志已开启(事件保留 1 天)" : "解码调试日志已关闭", {});
      }
    } catch {
      /* 配置读不到(测试裸环境等)不动现状态 */
    } finally {
      cfgProbeInflight = null;
    }
  })();
  return cfgProbeInflight;
}

/** 记录一条 debug 事件(同步;开关关闭时一次布尔判断直接返回)。 */
export function recordSendspinDebug(kind: string, msg: string, fields?: Record<string, unknown>): void {
  if (!enabled) return;
  const entry: SendspinDebugEntry = {
    ts: new Date().toISOString(),
    kind,
    msg,
    ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
  };
  mem.push(entry);
  if (mem.length > MAX_MEM_ENTRIES) mem.splice(0, mem.length - MAX_MEM_ENTRIES);
  const now = Date.now();
  while (mem.length > 0 && now - Date.parse(mem[0].ts) > SENDSPIN_DEBUG_RETENTION_MS) mem.shift();
  writeDebugFile(entry, now);
}

function writeDebugFile(entry: SendspinDebugEntry, now: number): void {
  if (fileBroken) return;
  try {
    const dir = debugDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = debugFilePath();
    if (now - lastFilePruneAt > FILE_PRUNE_INTERVAL_MS) {
      lastFilePruneAt = now;
      pruneDebugFiles(dir, now);
    }
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_FILE_BYTES) {
        try { fs.rmSync(`${file}.1`, { force: true }); } catch { /* ignore */ }
        fs.renameSync(file, `${file}.1`);
      }
    } catch { /* 文件尚不存在 */ }
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    fileBroken = true;
  }
}

export function debugDir(): string {
  return path.join(getDataDir(), "logs");
}

export function debugFilePath(): string {
  return path.join(debugDir(), `${FILE_BASENAME}.log`);
}

/** 清理超 1 天的 sendspin-debug* 旧文件(按 mtime)。导出供测试直调。 */
export function pruneDebugFiles(dir: string = debugDir(), now: number = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(FILE_BASENAME)) continue;
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs > SENDSPIN_DEBUG_RETENTION_MS) fs.rmSync(p, { force: true });
    } catch { /* ignore */ }
  }
}

/** REST 接口取数:开关状态 + 文件路径/大小 + 内存环形缓冲尾部。 */
export function getSendspinDebugSnapshot(limit = 500): {
  enabled: boolean;
  file: string;
  fileBytes: number | null;
  entries: SendspinDebugEntry[];
} {
  let fileBytes: number | null = null;
  try {
    fileBytes = fs.statSync(debugFilePath()).size;
  } catch { /* 无文件 */ }
  return {
    enabled,
    file: debugFilePath(),
    fileBytes,
    entries: limit > 0 ? mem.slice(-limit) : [],
  };
}
