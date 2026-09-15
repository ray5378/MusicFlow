// 播放端(peer)ID 的编解码工具。
//
// peerId 形如:
//   local:<userId>              —— 本机播放器(旧格式:一个账号一条队列)
//   local:<userId>:<clientId>   —— 本机播放器(新格式:每个客户端实例各自一条队列)
//   dlna:<deviceId> / airplay:<deviceId> / group:<groupId>
//
// clientId 是客户端自己生成、存在本地的**临时端 ID**(网页标签页 / Flutter 安装各
// 一个)。它只用于服务端把同一账号下多个播放端的队列隔离开。隔离是服务端的账本:
// clientId 本身永不出现在任何响应里,对外一律用不可逆派生出的**实例键**代替
// (见下方 instanceKeyOfLocalPeer);「哪条是我自己」由服务端打 `self` 标记,
// 客户端无需知道自己的 clientId,更不需要自己拼 peerId。
//
// 本文件刻意不依赖任何服务模块(peer.ts / access.ts 都 import 它,避免循环引用)。

import { createHash } from "node:crypto";

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 校验并规范化客户端上报的临时端 ID。非法(含缺省)→ null,调用方退回旧格式。 */
export function sanitizeClientId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return CLIENT_ID_RE.test(v) ? v : null;
}

/** 组装本机 peerId。clientId 缺失/非法 → 旧格式 `local:<userId>`(向后兼容)。 */
export function buildLocalPeerId(userId: string, clientId?: string | null): string {
  const cid = sanitizeClientId(clientId);
  return cid ? `local:${userId}:${cid}` : `local:${userId}`;
}

/** 取本机 peerId 里的临时端 ID;旧格式或非本机 peer 返回 null。 */
export function clientIdOfLocalPeer(peerId: string): string | null {
  if (!peerId.startsWith("local:")) return null;
  const rest = peerId.slice(6);
  const idx = rest.indexOf(":");
  if (idx < 0) return null;
  return sanitizeClientId(rest.slice(idx + 1));
}

/** 取本机 peerId 里的 userId(不校验该用户是否真实存在)。非本机 peer 返回 null。 */
export function userIdOfLocalPeer(peerId: string): string | null {
  if (!peerId.startsWith("local:")) return null;
  const rest = peerId.slice(6);
  const idx = rest.indexOf(":");
  return idx < 0 ? rest : rest.slice(0, idx);
}

/** peerId 是否属于该用户的播放端(含该用户的任意客户端实例 / 旧格式)。 */
export function isOwnLocalPeer(peerId: string, userId: string): boolean {
  if (!userId) return false;
  return peerId === `local:${userId}` || peerId.startsWith(`local:${userId}:`);
}

// ==================== 对外的「打码 / 解码」 ====================
//
// 临时端 ID 只属于服务端:客户端不该看到它,也不该自己拼它。
// 但「播放器」页要把同账号的多个本机实例(客户端 / Web)各列一行,必须能区分它们
// —— 于是引入**不透明实例键** `instanceKeyOfLocalPeer`:由 userId+clientId 经
// sha1 派生、不可逆,只当行标识用。对外形式 `local:<userId>:<instanceKey>`;
// 旧格式 `local:<userId>`(无 clientId)保持不变。
//
// 「哪一条是我自己」不靠客户端比对 —— 服务端在列表里给调用方自己那行打 `self: true`
// (见 /v1/peers),客户端因此完全不需要知道自己的实例键,更不需要知道 clientId。

/** 不透明实例键:userId+clientId 的 sha1 前 12 位;旧格式(无 clientId)返回 null。 */
export function instanceKeyOfLocalPeer(peerId: string): string | null {
  const uid = userIdOfLocalPeer(peerId);
  if (!uid) return null;
  const cid = clientIdOfLocalPeer(peerId);
  if (!cid) return null; // local:<userId> 单一实例,无实例键
  return createHash("sha1").update(`${uid}\u0000${cid}`).digest("hex").slice(0, 12);
}

/** 入口:调用方视角 peerId → 服务端真实 peerId(只对本机 peer 生效)。
 *  - 带实例键(`local:<uid>:<key>`)→ 经 resolveByInstanceKey 反查真实 peerId
 *    (客户端可以对**同账号的任意实例**发指令,不只自己那条);
 *  - 不带(旧客户端只见过 `local:<userId>`)→ 退回本次请求上报的 clientId。 */
export function resolveLocalPeerId(
  peerId: string,
  userId: string,
  clientId?: string | null,
  resolveByInstanceKey?: (userId: string, instanceKey: string) => string | null,
): string {
  if (!peerId.startsWith("local:") || !userId) return peerId;
  if (userIdOfLocalPeer(peerId) !== userId) return peerId; // 别人的本机播放器:原样交给权限层拦
  // 尾段原样交给反查:它可能是实例键(新形式)也可能是 clientId(客户端自己拼的,正常不会出现)。
  // 反查命中 → 用真实行;命中不了(实例已断线 / 本来就是 clientId)→ 退回本次请求的 clientId。
  const seg = clientIdOfLocalPeer(peerId);
  if (seg && resolveByInstanceKey) {
    const hit = resolveByInstanceKey(userId, seg);
    if (hit) return hit;
  }
  return buildLocalPeerId(userId, clientId);
}

/** 出口:服务端真实 peerId → 调用方视角 peerId。
 *  带 clientId → `local:<userId>:<instanceKey>`(同账号多实例各占一行);
 *  旧格式 → `local:<userId>`(与旧版完全一致)。 */
export function maskLocalPeerId(peerId: string): string {
  const uid = userIdOfLocalPeer(peerId);
  if (!uid) return peerId;
  const key = instanceKeyOfLocalPeer(peerId);
  return key ? `local:${uid}:${key}` : `local:${uid}`;
}
