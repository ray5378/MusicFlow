// withImageDataUrl 归一化 + action 方法白名单(T05 §14.3)单测。
// 覆盖:image 透传 / url·text 生成二维码 data URL / 非法·超长 value → null 且 value 保留 /
// 未知 kind·非字符串 → null / 白名单枚举恰好四个方法(status 为第四方法,配置页状态块)。
import { describe, it, expect } from "vitest";
import { withImageDataUrl, isQrActionMethod, QR_ACTION_METHODS } from "../../src/plugins/qrAction.js";

describe("qrAction · withImageDataUrl 归一化", () => {
  it("kind=image:value 为图片 data URL → 原样透传为 imageDataUrl,其余键保留", () => {
    const img = "data:image/png;base64,aGVsbG8=";
    const out = withImageDataUrl({
      kind: "image", value: img, ttlSec: 120, pollIntervalMs: 1500, sessionKey: "s1",
    });
    expect(out.imageDataUrl).toBe(img);
    expect(out.kind).toBe("image");
    expect(out.value).toBe(img);
    expect(out.ttlSec).toBe(120);
    expect(out.pollIntervalMs).toBe(1500);
    expect(out.sessionKey).toBe("s1");
  });

  it("kind=url:生成二维码 data:image/svg+xml;base64 前缀,且解码后为 <svg", () => {
    const out = withImageDataUrl({ kind: "url", value: "https://example.com/qr?token=abc" });
    expect(typeof out.imageDataUrl).toBe("string");
    expect(out.imageDataUrl as string).toMatch(/^data:image\/svg\+xml;base64,/);
    const b64 = (out.imageDataUrl as string).slice("data:image/svg+xml;base64,".length);
    const svg = Buffer.from(b64, "base64").toString("utf8");
    expect(svg).toContain("<svg");
    // value 原样保留(前端降级链接需要)
    expect(out.value).toBe("https://example.com/qr?token=abc");
  });

  it("kind=text:同样生成二维码 data URL", () => {
    const out = withImageDataUrl({ kind: "text", value: "HELLO-QR" });
    expect(out.imageDataUrl as string).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(out.value).toBe("HELLO-QR");
  });

  it("超长 url(qrToSvg 版本越界)→ imageDataUrl=null 且 value 原样保留", () => {
    const longUrl = "https://example.com/" + "x".repeat(10000);
    const out = withImageDataUrl({ kind: "url", value: longUrl });
    expect(out.imageDataUrl).toBeNull();
    expect(out.value).toBe(longUrl);
  });

  it("非法 value(非字符串/空串)→ imageDataUrl=null 且原样透传", () => {
    expect(withImageDataUrl({ kind: "url", value: 123 }).imageDataUrl).toBeNull();
    expect(withImageDataUrl({ kind: "image", value: "" }).imageDataUrl).toBeNull();
    expect(withImageDataUrl({ kind: "text", value: null }).imageDataUrl).toBeNull();
  });

  it("未知 kind → imageDataUrl=null,载荷其余键不动", () => {
    const out = withImageDataUrl({ kind: "hologram", value: "x", sessionKey: "k" });
    expect(out.imageDataUrl).toBeNull();
    expect(out.kind).toBe("hologram");
    expect(out.sessionKey).toBe("k");
  });

  it("缺 kind / 空对象 → imageDataUrl=null,不抛", () => {
    expect(withImageDataUrl({}).imageDataUrl).toBeNull();
    expect(withImageDataUrl(undefined as never).imageDataUrl).toBeNull();
  });
});

describe("qrAction · 方法白名单", () => {
  it("恰好四个:startBind / pollBind / cancelBind / status", () => {
    expect([...QR_ACTION_METHODS]).toEqual(["startBind", "pollBind", "cancelBind", "status"]);
  });
  it("isQrActionMethod:四个合法 method 为 true,其余(含插件自有方法)为 false", () => {
    expect(isQrActionMethod("startBind")).toBe(true);
    expect(isQrActionMethod("pollBind")).toBe(true);
    expect(isQrActionMethod("cancelBind")).toBe(true);
    expect(isQrActionMethod("status")).toBe(true);
    expect(isQrActionMethod("runDailyJob")).toBe(false);
    expect(isQrActionMethod("search")).toBe(false);
    expect(isQrActionMethod(undefined)).toBe(false);
    expect(isQrActionMethod(42)).toBe(false);
  });
});
