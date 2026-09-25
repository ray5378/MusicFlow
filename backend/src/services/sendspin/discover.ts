// Sendspin 播放器自动发现:浏览局域网 `_sendspin._tcp`(玩家自广播,见 spec
// Server Initiated Connections),新设备出现即主动拨号,前端 peers/播放目标
// 列表自动出现,无需手工 dial。
//
// 边界:发现与拨号逻辑归本包;复用 discovery/mdns 的共享 Bonjour 实例。
// 只发现、不自动播放;拨号走 `index.ts` 的重试状态机(带窗口 + 单飞),与手工 dial
// 同口径:
//   - 设备 goodbye 拒绝过的(抑制期内)不再骚扰(noAutoRedial)
//   - 已在线(拨出**或拨入**)的不重复拨
//
// ── 2026-09-25 真机定位的两个致命缺陷(本文件即修法)──
//
// ① **发现即写**:以前 `rememberDialTarget` 写在 `dialPlayer` **成功之后** ——
//    设备开机那一瞬(IP 刚拿到、:8928 还没 listen)拨一次必然 `EHOSTUNREACH`,
//    await 直接抛错让整个函数中断 ⇒ 既不记忆也不重试 ⇒ **一次失败 = 永久失联**
//    (实测 `.245`:开机广播时拨号 → 3.075s 后 EHOSTUNREACH → 此后 38 分钟无人理它)。
//    现在改为「先记住、再让状态机接手」:失败也进 `dial_targets`,由重试状态机重试。
//
// ② **库级永久装聋**:bonjour-service 的 PTR 查询**只发一次**(`browser.js` start 里
//    那一发;全库 `setInterval` 零命中,那个 5s 定时器只刷新网卡组播成员关系)、
//    `_services` **只增不减**(`expire()` 全库无调用点)、对已知 fqdn **永久去重**
//    (第二次起只 emit `srv-update`/`txt-update`,而 `up` 我们才挂)—— 而 ESPHome
//    设备**开机只广播一次**(实测 100s 窗口 0 条 mDNS)。两端都「只说一次」⇒ 错过
//    就永远没有第二次。本文件用**周期重建 browser** 自己造节拍:新实例 `_services`
//    为空 ⇒ 新查询的响应会让所有在线设备重新走 `addService` → 重新 emit `up`。
//    ⚠️ 单纯调 `browser.update()` **无效**(响应照样落进 existingService 分支)。
import type { SendspinServer } from "./server.js";
import { getSharedBonjour } from "../discovery/mdns.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("sendspin-discover");
const BROWSER_TYPE = "sendspin";
/** 重建 browser 的周期(ms)。设备不主动重播、库也永不重查,故必须由我们造节拍。
 *  与重试状态机的「窗口内不因新信号重置」闸门配合:F 每 60s 给一次信号,
 *  但同一目标的 5 分钟重试窗口**不会**因此重置(否则 10s 阶段永远到不了)。 */
const BROWSER_REFRESH_MS = 60_000;

let browser: any = null;
let serving: SendspinServer | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** 启动播放器发现(幂等)。服务停止时必须调 stopPlayerDiscovery()。 */
export function startPlayerDiscovery(srv: SendspinServer): void {
  stopPlayerDiscovery();
  serving = srv;
  openBrowser();
  log.info("browsing _sendspin._tcp for players");
  // 周期重建(见文件头 ②)。unref:不给进程多留一个 keep-alive 句柄。
  refreshTimer = setInterval(() => {
    if (serving) openBrowser();
  }, BROWSER_REFRESH_MS);
  refreshTimer.unref?.();
}

/** 停止播放器发现(幂等)。 */
export function stopPlayerDiscovery(): void {
  serving = null;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  try {
    browser?.stop?.();
  } catch { /* 忽略 */ }
  browser = null;
}

/** 开一个全新的 Browser 实例(= 重发一次 PTR 查询)。旧实例直接丢弃:
 *  `stop()` 只摘监听、不清 `_services`,而**新实例的 `_services` 是空的** —— 这正是
 *  让在线设备重新触发 `up` 的关键。 */
function openBrowser(): void {
  const s = serving;
  try {
    browser?.stop?.();
  } catch { /* 旧实例已死 */ }
  browser = null;
  if (!s) return;
  try {
    browser = getSharedBonjour().find({ type: BROWSER_TYPE }, (svc: any) => {
      if (serving !== s) return; // 重建/停止期间的迟到回调:丢弃
      void onPlayerSeen(s, svc).catch((e) => log.warn("auto-dial failed", { err: (e as Error)?.message || e }));
    });
    // 每 60s 一行的 debug(LOG_LEVEL=debug 才可见)。不再每轮 info,免得刷屏;
    // 需要肉眼确认「周期重查在跑」时抓 240→224.0.0.251 的 PTR 查询即可。
    log.debug("rebuilt _sendspin._tcp browser(周期重查)");
  } catch (e: any) {
    log.warn("browse start failed", { err: e?.message || e });
    browser = null;
  }
}

/** mDNS 服务对象取 IPv4(导出供单测):addresses 优先取 IPv4 字面量,
 *  无则退 host(可能为 .local 名,上层直连)。 */
export function pickIPv4(svc: any): string {
  const addrs: unknown = (svc as any)?.addresses ?? (svc as any)?.referer?.address;
  const list = Array.isArray(addrs) ? addrs : typeof addrs === "string" ? [addrs] : [];
  for (const a of list) {
    if (typeof a === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(a)) return a;
  }
  for (const a of list) {
    if (typeof a === "string" && a && !a.includes(":")) return a;
  }
  const host = typeof (svc as any)?.host === "string" ? (svc as any).host : "";
  return host;
}

async function onPlayerSeen(srv: SendspinServer, svc: any): Promise<void> {
  const port = Number((svc as any)?.port);
  const host = pickIPv4(svc);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return;
  // 设备明确拒绝过(another_server 等)且仍在抑制期内:不再骚扰(与手工 dial 同口径)。
  if (srv.isRedialSuppressed(host, port)) return;
  // 已在线不重复拨:拨出的按 host:port、拨入的按 host(端口未知),两路都算在线。
  if (srv.isConnectedTo(host, port)) return;
  // ① 把发现到的设备**立即入册**并开一个重试窗口,首拨 + 2s×30 → 10s×24 的重试全部
  //    交给 index.ts 的状态机 —— 本文件不再自己 dialPlayer(避免两条拨号路径口径不一)。
  //    返回 false = 该目标已有窗口在跑(窗口内不重置进度)或已在线,无需动作。
  try {
    const { armDialTarget } = await import("./index.js");
    const armed = await armDialTarget(host, port, "discover");
    if (!armed) return;
    log.info(`discovered player ${host}:${port},已入册并开重试窗口`);
  } catch (e: any) {
    log.warn("arm dial target failed", { host, port, err: e?.message || e });
  }
}
