// ==================== 共享 PTP 时钟守护(单例,引用计数)====================
//
// 多机同步的两条路:
//   - **统一 `START_UNIX_MS` 锚点**(默认):墙钟即可,实测三台跨度 0.159ms,不需要特权;
//   - **共享 PTP 时钟**(`MUSICFLOW_AP2_PTP=1`):cliairplay 每进程自己也能跑 in-process
//     引擎,但多进程各自当 grandmaster 会互相抢 319/320 且时钟源不一致 —— 必须一台
//     host 只有一个 daemon,各流用 `--ptp-shared` 附着它的共享内存时钟。
//
// 本类只做「第一个 PTP 流起时拉起,最后一个结束时 SIGTERM」(与 MA 的策略一致)。
// daemon 需要 bind UDP 319/320:host 网络 + 容器 root(或 `setcap
// cap_net_bind_service=+ep`)即可,不需要额外 compose 改动。
import { spawn, type ChildProcess } from "child_process";
import { createLogger } from "../../../utils/logger.js";
import { checkCliBinary } from "./binary.js";

const log = createLogger("AIRPLAY-AP2");

class PtpDaemon {
  private proc: ChildProcess | null = null;
  private refs = 0;

  isRunning(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  /** 流开始用共享 PTP:拉起(必要时)并计数。 */
  acquire(): void {
    this.refs++;
    if (this.proc) return;
    const bin = checkCliBinary();
    if (!bin) {
      log.warn("cliairplay 不可用,PTP 守护无法启动");
      return;
    }
    const iface = process.env.MUSICFLOW_AP2_PTP_IF?.trim();
    const args = ["--ptp-daemon", ...(iface ? ["--if", iface] : [])];
    log.info(`[ap2-ptp] 启动共享 PTP 守护 ${bin.path} ${args.join(" ")}`);
    const proc = spawn(bin.path, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout?.on("data", (c: Buffer) => {
      for (const l of c.toString("utf8").split("\n")) if (l.trim()) log.debug(`[ap2-ptp] ${l.trim()}`);
    });
    proc.stderr?.on("data", (c: Buffer) => {
      for (const l of c.toString("utf8").split("\n")) {
        const t = l.trim();
        if (!t) continue;
        // 319/320 被占是**最容易踩**的部署问题,必须显式告警而不是吞掉。
        if (/bind|address already in use|permission/i.test(t)) log.warn(`[ap2-ptp] ${t}`);
        else log.debug(`[ap2-ptp] ${t}`);
      }
    });
    proc.once("exit", (code, sig) => {
      log.warn(`[ap2-ptp] 守护退出 code=${code} sig=${sig}`);
      this.proc = null;
    });
  }

  /** 流结束:计数归零时收掉守护。 */
  release(): void {
    if (this.refs > 0) this.refs--;
    if (this.refs > 0) return;
    const p = this.proc;
    this.proc = null;
    if (!p || p.killed) return;
    log.info("[ap2-ptp] 最后一个 PTP 流结束,停止守护");
    try { p.kill("SIGTERM"); } catch { /* ignore */ }
    // daemon 卡住时兜底(它只做时钟,不承载音频,强杀无副作用)。
    setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* ignore */ } }, 3_000).unref?.();
  }

  /** 进程整体关闭。 */
  stop(): void {
    this.refs = 0;
    const p = this.proc;
    this.proc = null;
    try { p?.kill("SIGKILL"); } catch { /* ignore */ }
  }
}

export const ptpDaemon = new PtpDaemon();
