// ==================== 播放上下文 v2(阶段 5.3) ====================
//
// 背景:playMedia 曾是 6 个位置参数(item, baseUrl, startMs?, bridge?, opts?),
// 其中 bridge.sockets / opts.manual / opts.nextSongId / opts.resolvedRowId 只有
// sendspin / AirPlay 消费,新协议只能"忽略"。阶段 5.3 把这些协议私有提示收进
// 一个上下文对象,协议实现按需取用,**核心不读 hints**。
//
// 兼容策略(契约 v1 → v2,**只增不删**):
//   - v1 调用方仍可传 `playMedia(item, baseUrl, startMs, bridge, opts)`(字符串);
//   - v2 调用方可传 `playMedia(item, ctx)`(PlayContext);
//   - 本文件的 normalizePlayContext 即 v1 适配器,两者都归一成同一份四元组,
//     协议实现体无需感知调用方用的是哪一版。

export const PLAYER_CONTRACT_VERSION = 2;

/** 桥接 socket 规格(结构同 services/sendspin/bridgeAttach.ts 的 BridgeSocketSpec,
 *  这里用 string 协议以保持播放器契约与协议实现解耦)。 */
export interface PlayBridgeSocket {
  deviceId: string;
  socketPath: string;
  token: string;
  protocol: string;
}

export interface PlayBridge {
  sockets: PlayBridgeSocket[];
}

/** v1 的 opts 形状(保留,并作为 v2 flags/hints 的落地形态)。 */
export interface PlayMediaOptions {
  /** 仅用户手动 next/prev(airplay 桥用)。 */
  manual?: boolean;
  /** 队列下一首 songId(仅提示,sendspin 泵曲末预解码用)。 */
  nextSongId?: string;
  /** 主进程已裁决的可播源行 id(sendspin 泵跳过二次探测)。 */
  resolvedRowId?: string;
  /** 倍速(0.75~2)。缺省 = 各协议读自己的注册表。 */
  speed?: number;
}

/** 播放上下文 v2。除 `baseUrl` 外全部可选;`hints` 仅供**协议插件自己**读取,
 *  核心不得读取(避免变成协议私有逃生门的垃圾桶)。 */
export interface PlayContext {
  baseUrl?: string;
  /** 起播起点(毫秒)。 */
  startMs?: number;
  /** 本次显式倍速(优先于协议注册表)。 */
  speed?: number;
  bridge?: PlayBridge;
  flags?: { manual?: boolean };
  /** 协议私有提示:键名由协议自定义(如 `{ sendspin: { nextSongId } }`)。 */
  hints?: Record<string, unknown>;
  /** v1 兼容位:老调用方把协议私有参数装在这里一起传。 */
  opts?: PlayMediaOptions;
}

export interface NormalizedPlayArgs {
  baseUrl: string;
  startMs: number;
  speed?: number;
  bridge?: PlayBridge;
  opts?: PlayMediaOptions;
}

/**
 * v1 适配器:把「字符串 baseUrl + 位置参数」或「PlayContext」统一归一成
 * 实现侧使用的四元组。协议实现只需在 playMedia 顶部调用一次。
 */
export function normalizePlayContext(
  baseUrlOrCtx: string | PlayContext | undefined,
  startMs?: number,
  bridge?: PlayBridge,
  opts?: PlayMediaOptions,
): NormalizedPlayArgs {
  const ctx = typeof baseUrlOrCtx === "string" ? undefined : baseUrlOrCtx;
  const baseUrl = typeof baseUrlOrCtx === "string" ? baseUrlOrCtx : (ctx?.baseUrl ?? "");
  const merged: PlayMediaOptions = { ...(ctx?.opts ?? {}), ...(opts ?? {}) };
  if (ctx?.flags?.manual !== undefined) merged.manual = ctx.flags.manual;
  const speed = ctx?.speed ?? merged.speed;
  return {
    baseUrl,
    startMs: ctx?.startMs ?? startMs ?? 0,
    ...(speed !== undefined ? { speed } : {}),
    bridge: ctx?.bridge ?? bridge,
    ...(Object.keys(merged).length ? { opts: merged } : {}),
  };
}
