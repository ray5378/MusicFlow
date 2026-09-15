// 播放端「类别标签」的唯一口径 —— 切换器行尾、切换弹窗、Flows 目标选择器共用。
//
// 规则(用户口径,别再各处各写一套):
//   - 本机实例(local)只有**与自己同一个 peerId**那台才叫「本机」;
//   - 其余本机实例显示它所属的**模块**,与侧边栏「播放器」页模块同名:
//     其余本机实例一律显示「客户端」(含 web 平台;不再单列「Web 播放器」模块);
//   - 其它 kind 恒为协议名:DLNA / AirPlay / Sendspin / 群组。
//
// 历史坑:「本机」曾被当成兜底词 —— MainLayout.localPlatformTag 在 platform 为空时
// 返回「本机」,而调用它的条件恰恰是「不是自己那条」,于是别的客户端被谎报成「本机」。
// 本函数里「本机」只可能由 isSelf 判定产生,永远不做兜底。

export interface PeerLike {
  kind?: string;
  peerId?: string;
  platform?: string;
  /** 服务端出口打的标记:该行是否就是调用方自己那台(优先于 peerId 比对)。 */
  self?: boolean;
}

/**
 * 取 peer 的类别标签。
 * @param p       peer 行(服务端 /v1/peers 或 WS 快照里的元素)
 * @param t       i18n 的 t
 * @param selfId  调用方自己那条的 peerId;行上没有 self 标记时用它兜底比对
 */
export function peerKindLabel(p: PeerLike | null | undefined, t: (k: string) => string, selfId?: string | null): string {
  const kind = p?.kind || "";
  if (kind !== "local") {
    if (kind === "airplay") return "AirPlay";
    if (kind === "group") return t("layout.groupPeer");
    if (kind === "sendspin") return "Sendspin";
    return "DLNA";
  }
  const isSelf = p?.self === true || (!!selfId && p?.peerId === selfId);
  if (isSelf) return t("layout.localPeer");
  return t("groups.clientPlayers");
}
