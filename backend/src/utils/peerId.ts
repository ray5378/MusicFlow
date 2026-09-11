// 播放端(peer)ID 的编解码工具。
//
// peerId 形如:
//   local:<userId>              —— 本机播放器(旧格式:一个账号一条队列)
//   local:<userId>:<clientId>   —— 本机播放器(新格式:每个客户端实例各自一条队列)
//   dlna:<deviceId> / airplay:<deviceId> / group:<groupId>
//
// clientId 是客户端自己生成、存在本地的**临时端 ID**(网页标签页 / Flutter 安装各
// 一个)。它只用于服务端把同一账号下多个播放端的队列隔离开 —— 隔离是服务端的账本,
// 任何前端/客户端都只看得到自己那一条(过滤见 services/access.ts#filterPeersByAccess)。
//
// 本文件刻意不依赖任何服务模块(peer.ts / access.ts 都 import 它,避免循环引用)。

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
// 临时端 ID 只属于服务端:客户端既不该在响应里看到它,也不该自己拼它。
// 客户端一律只发、只收规范形式 `local:<userId>`;服务端在入口处按调用方上报的
// clientId 换算出真正的行(resolveLocalPeerId),在出口处再收敛回规范形式
// (maskLocalPeerId)。这样「一个账号多个客户端实例各占一条队列」完全在服务端
// 消化,前端/客户端代码与旧版完全一致。

/** 入口:调用方视角 peerId → 服务端真实 peerId(只对本机 peer 生效)。 */
export function resolveLocalPeerId(peerId: string, userId: string, clientId?: string | null): string {
  if (!peerId.startsWith("local:") || !userId) return peerId;
  if (userIdOfLocalPeer(peerId) !== userId) return peerId; // 别人的本机播放器:原样交给权限层拦
  return buildLocalPeerId(userId, clientId);
}

/** 出口:服务端真实 peerId → 调用方视角 peerId(本机 peer 收敛成 `local:<userId>`)。 */
export function maskLocalPeerId(peerId: string): string {
  const uid = userIdOfLocalPeer(peerId);
  return uid ? `local:${uid}` : peerId;
}
