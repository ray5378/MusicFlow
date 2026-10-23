// ==================== cliairplay 二进制定位与自检 ====================
//
// AP2 发送端不自研:配对(SRP/HAP)、加密 RTSP、AAC/ALAC 帧封装、PTP 引擎全部交给
// Music Assistant 的 `cliairplay` 二进制(与 MA 完全同一条路),我们只做**编排**。
// 因此「二进制在不在、版本对不对」是整条 AP2 链路的总开关:
//   - 不可用 ⇒ discovery 不把 AP2-only 设备写进设备表(否则 UI 里多出点了就报错的死设备),
//     组成员也一律回落 AP1 RAOP,行为与本次改造前**逐字一致**(零回归)。
//   - 可用   ⇒ AP2-only 设备入表,`supportsAp2` 成员走 cli 通道。
//
// 为什么路径要多个候选:`/app/backend/bin` 是镜像内约定的安装位(entrypoint 拷进去),
// `bin/cliairplay` 是本地开发与 230 直跑的仓库位;env 最高优先,便于真机换版本 A/B。
import { existsSync, statSync } from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("AIRPLAY-AP2");

/** 自检结果缓存时长:二进制可能在运行中被换(热升级),不必每次投屏都 spawn 一次。 */
const CHECK_CACHE_MS = 60_000;

function candidates(): string[] {
  const out: string[] = [];
  const env = process.env.AIRPLAY_CLI_PATH?.trim();
  if (env) out.push(env);
  out.push("/app/backend/bin/cliairplay");
  // 本地开发:node 从 backend/ 或仓库根启动都有可能出现,两个都试。
  out.push(path.resolve(process.cwd(), "bin", "cliairplay"));
  out.push(path.resolve(process.cwd(), "backend", "bin", "cliairplay"));
  return [...new Set(out)];
}

function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    // Windows 上没有 unix 权限位,这里只做「存在且非目录」判定(生产全在 Linux 容器)。
    return true;
  } catch {
    return false;
  }
}

/** 找到可用的 cliairplay 路径(未找到返回 null)。不做自检,调用 `checkCliBinary`。 */
export function findCliBinary(): string | null {
  for (const p of candidates()) if (isExecutableFile(p)) return p;
  return null;
}

let checkCache: { key: string; version: string | null; at: number } | null = null;

/** 跑 `--check` 拿版本号;不可执行/输出异常返回 null。结果缓存 60s。 */
export function checkCliBinary(binPath?: string): { path: string; version: string } | null {
  const p = binPath || findCliBinary();
  if (!p) return null;
  const now = Date.now();
  if (checkCache && checkCache.key === p && now - checkCache.at < CHECK_CACHE_MS) {
    return checkCache.version ? { path: p, version: checkCache.version } : null;
  }
  let version: string | null = null;
  try {
    // `--check` 输出形如 `cliairplay v0.5.9 check`(README 明确这是官方校验入口)。
    const out = execFileSync(p, ["--check"], { timeout: 5_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const m = /cliairplay\s+(v?[\w.\-+]+)/i.exec(out);
    if (m && /\bcheck\b/i.test(out)) version = m[1];
  } catch (e: any) {
    log.warn(`cliairplay 自检失败(${p}): ${e?.message || e}`);
  }
  checkCache = { key: p, version, at: now };
  return version ? { path: p, version } : null;
}

/** AP2 发送端是否可用(总开关)。
 *
 *  `MUSICFLOW_AP2_CLI=0` 显式关掉 —— 排查「开了 AP2 之后反而没声音」时的一键回退,
 *  关掉后所有 `supportsAp2` 设备自动回落 AP1 RAOP(与改造前一致)。 */
export function isAp2StreamingAvailable(): boolean {
  if (process.env.MUSICFLOW_AP2_CLI === "0") return false;
  return checkCliBinary() !== null;
}

/** 供日志/接口展示的 AP2 运行时信息。 */
export function ap2RuntimeInfo(): { available: boolean; path: string | null; version: string | null } {
  const bin = findCliBinary();
  if (!bin) return { available: false, path: null, version: null };
  const ok = process.env.MUSICFLOW_AP2_CLI === "0" ? null : checkCliBinary(bin);
  return { available: !!ok, path: bin, version: ok?.version ?? null };
}

/** 清自检缓存(装完二进制/热升级后让下一次判定立刻生效)。 */
export function resetAp2BinaryCache(): void {
  checkCache = null;
}

/** 该设备是否应该走 cli(AP2)通道。
 *
 *  判定只用能力标记 + 二进制可用性,**不猜 features 位**:features 只透传给 cli 做
 *  路由自动选择,真正的 native/compat 由它自己按 TXT 决定。
 *  `creds` 缺省也允许(transient 配对)—— Sonos / 绝大多数三方接收端无需预配对。 */
export function shouldUseAp2(dev: { supportsAp2?: boolean } | undefined | null): boolean {
  if (!dev?.supportsAp2) return false;
  return isAp2StreamingAvailable();
}
