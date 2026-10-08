/**
 * 插件 action 调用(扫码登录等)的请求契约与响应归一化(T05 §14)。
 *
 * `POST /v1/plugins/:id/action` 的语义:配置页 type:"action" 按钮点击 →
 * 调用插件声明的 action 方法(如 startBind)→ 把插件返回的 QrPayload 归一化
 * (追加 imageDataUrl)后透传给前端通用扫码弹窗——弹窗零编码逻辑,只直显
 * `<img :src="imageDataUrl">`。
 *
 * 归一化规则(§14.3,后端一次分支):
 *   - kind === "image":value 本身就是 data URL,透传为 imageDataUrl;
 *   - kind === "url" | "text":用自研 qrToSvg(ecc "M" + border 4 模块静区)
 *     生成二维码 SVG 再 base64 包成 data URL;编码失败(非法/超长/版本越界)
 *     → imageDataUrl = null,**value 原样保留**,前端降级为可点击链接/文本;
 *   - 其余(value 非字符串 / 未知 kind)→ imageDataUrl = null,原样透传。
 */
import { qrToSvg } from "../utils/qrcode.js";

/** 插件 action 方法返回的 QrPayload(宽松形,manifest 不可信,运行时逐键判型)。 */
export interface QrPayloadLike {
  kind?: unknown;
  value?: unknown;
  ttlSec?: unknown;
  pollIntervalMs?: unknown;
  sessionKey?: unknown;
  [k: string]: unknown;
}

/** action 端点允许调用的方法白名单(与 sandbox.ts CAP_METHODS.qrLogin 对齐;
 *  门禁唯一真源在此,端点与测试共用,不另立第二套白名单)。 */
export const QR_ACTION_METHODS = ["startBind", "pollBind", "cancelBind"] as const;
export type QrActionMethod = (typeof QR_ACTION_METHODS)[number];

/** method 是否在 action 白名单内。 */
export function isQrActionMethod(m: unknown): m is QrActionMethod {
  return typeof m === "string" && (QR_ACTION_METHODS as readonly string[]).includes(m);
}

/** qrToSvg 参数:border 给足 ≥4 模块静区(扫码识别率),ecc "M"(默认纠错档)。 */
const QR_SVG_OPTS = { ecc: "M", border: 4 } as const;

/** 把插件返回的 QrPayload 归一化:追加 imageDataUrl 字段,其余键原样保留。 */
export function withImageDataUrl(payload: QrPayloadLike): Record<string, unknown> {
  const kind = payload?.kind;
  const value = payload?.value;
  let imageDataUrl: string | null = null;
  if (kind === "image" && typeof value === "string" && value.length > 0) {
    // 插件自己给了图片(如 QQ 官方二维码图 URL/data URL):透传,不重绘。
    imageDataUrl = value;
  } else if ((kind === "url" || kind === "text") && typeof value === "string" && value.length > 0) {
    // url / text:自研 qrToSvg 生成二维码 SVG data URL;失败不吞 value。
    try {
      imageDataUrl =
        "data:image/svg+xml;base64," +
        Buffer.from(qrToSvg(value, { ecc: QR_SVG_OPTS.ecc, border: QR_SVG_OPTS.border })).toString("base64");
    } catch {
      imageDataUrl = null; // 非法/超长 value → null 且保留 value,前端降级链接/文本
    }
  }
  return { ...payload, imageDataUrl };
}
