/**
 * P2-4：Web 端（Howler）实时管道流的 seek 位置换算。
 *
 * 背景：后端 P2-1/P2-2 起 `/rest/stream` 与 `/rest/dlna/stream/:token` 全通道走
 * 实时管道（D9：无直传旁路），响应不再支持字节 Range（一律全流 200）。Howler 的
 * `howl.seek(t)` 依赖 HTML5 audio 的字节 Range 请求定位 → 在实时流上失效，
 * 拖动进度会直接失败。
 * ⚠️ `/rest/stream-remote`（搜索即播的未入库远程歌）**仍是原样代理**，Range 尚可用，
 * 见 progress §5 的 P2-7；它改走管道后，本文件的换算会自动适用（前端无需再改判定——
 * 这里的 URL 重建是统一入口 `getStreamUrl()` 之后的字符串拼接）。
 *
 * 对策：与外层客户端 P2-3（`lib/providers/player/transcoded_stream_seek.dart`）
 * 同款语义 —— 不用 `howl.seek()` 跳转，而是带 `timeOffset`（整秒）重新拉流
 * （服务端 ffmpeg `-ss <timeOffset>` 前置定位），再用偏移量把「流内位置」
 * 换算回「逻辑位置」显示。不足 1 秒的零头留在流内（sourcePosition）由 Howler 消化。
 *
 * Web 端与后端同版本发布（前端资源随镜像打包），故无需客户端那样的服务端
 * 版本门控：连上的服务端必然含 P2-1 管道，一律按实时流处理。
 */

/** seek 目标：逻辑位置 → 服务端 timeOffset 重拉参数。 */
export interface StreamSeekTarget {
  /** 用户请求的逻辑位置（秒，已 clamp ≥ 0）。 */
  logicalPosition: number;
  /** 传给服务端 `timeOffset` 的整秒偏移（向下取整）。 */
  serverOffset: number;
  /** 重拉后流内的起始位置（秒，< 1）：logical - serverOffset。 */
  sourcePosition: number;
}

export function seekTargetFromLogical(positionSec: number): StreamSeekTarget {
  const logicalPosition = Number.isFinite(positionSec) && positionSec > 0 ? positionSec : 0;
  const serverOffset = Math.floor(logicalPosition);
  return { logicalPosition, serverOffset, sourcePosition: logicalPosition - serverOffset };
}

/**
 * 流内位置 + 偏移 → 逻辑位置。
 * `maximumSec` 给出时 clamp 到该值（用于进度显示不超过全曲时长）；
 * 省略或非正数则不 clamp（时长未知时不误截）。
 */
export function toLogicalPosition(
  sourcePositionSec: number,
  serverOffsetSec: number,
  maximumSec?: number,
): number {
  const src = Number.isFinite(sourcePositionSec) ? sourcePositionSec : 0;
  const offset = Number.isFinite(serverOffsetSec) ? serverOffsetSec : 0;
  let logical = src + offset;
  if (logical < 0) logical = 0;
  if (maximumSec !== undefined && maximumSec > 0 && logical > maximumSec) logical = maximumSec;
  return logical;
}

/**
 * 给流 URL 追加 `timeOffset`（整秒）。0 / 非正 / 非法值不追加（保持原 URL 形态，
 * 便于浏览器与中间层缓存未 seek 的常规请求）。
 */
export function withTimeOffset(url: string, timeOffsetSec: number): string {
  if (!Number.isFinite(timeOffsetSec) || timeOffsetSec <= 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}timeOffset=${Math.floor(timeOffsetSec)}`;
}
