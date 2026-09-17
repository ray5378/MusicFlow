// Sendspin 播放器自动发现:浏览局域网 `_sendspin._tcp`(玩家自广播,见 spec
// Server Initiated Connections),新设备出现即主动拨号,前端 peers/播放目标
// 列表自动出现,无需手工 dial。
//
// 边界:发现与拨号逻辑归本包;复用 discovery/mdns 的共享 Bonjour 实例。
// 只发现、不自动播放;拨号走 dialPlayer 单飞 + 抑制表,行为与手工 dial 一致:
//   - 设备 goodbye 拒绝过的不再骚扰(noAutoRedial)
//   - 已在线的不重复拨
//   - 同一 host:port 60s 内只拨一次(浏览消息去抖)
import type { SendspinServer } from "./server.js";
import { getSharedBonjour } from "../discovery/mdns.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("sendspin-discover");
const BROWSER_TYPE = "sendspin";
const REDIAL_COOLDOWN_MS = 60_000;

let browser: any = null;
let serving: SendspinServer | null = null;
const lastDialAt = new Map<string, number>();

/** 启动播放器发现(幂等)。服务停止时必须调 stopPlayerDiscovery()。 */
export function startPlayerDiscovery(srv: SendspinServer): void {
  stopPlayerDiscovery();
  serving = srv;
  try {
    browser = getSharedBonjour().find({ type: BROWSER_TYPE }, (svc: any) => {
      const s = serving;
      if (s) void onPlayerSeen(s, svc).catch((e) => log.warn("auto-dial failed", { err: (e as Error)?.message || e }));
    });
    log.info("browsing _sendspin._tcp for players");
  } catch (e: any) {
    log.warn("browse start failed", { err: e?.message || e });
    browser = null;
  }
}

/** 停止播放器发现(幂等)。 */
export function stopPlayerDiscovery(): void {
  serving = null;
  try {
    browser?.stop?.();
  } catch { /* 忽略 */ }
  browser = null;
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
  const key = `${host}:${port}`;
  // 拒绝过的不再骚扰(与手工 dial 同口径)。
  if (srv.noAutoRedial.has(key)) return;
  // 已在线(同 host:port 的拨号连接)不重复拨。
  for (const c of srv.clients.values()) {
    if (c.dialed && c.dialHost === host && c.dialPort === port) return;
  }
  // 浏览消息去抖:同一目标 60s 内只拨一次。
  const now = Date.now();
  if (now - (lastDialAt.get(key) ?? 0) < REDIAL_COOLDOWN_MS) return;
  lastDialAt.set(key, now);
  const path =
    typeof (svc as any)?.txt?.path === "string" && (svc as any).txt.path.startsWith("/")
      ? (svc as any).txt.path
      : "/sendspin";
  log.info(`discovered player ${key}${path}, dialing`);
  const conn = await srv.dialPlayer(`ws://${host}:${port}${path}`);
  // 记住目标:重启/掉线后重拨走同一入口,前端可遗忘。
  try {
    const { rememberDialTarget } = await import("./index.js");
    await rememberDialTarget(host, port);
  } catch { /* 记住失败不影响已建连接 */ }
  log.info(`discovered player online: ${conn.clientId} (${conn.name})`);
}
