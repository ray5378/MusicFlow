// 覆盖率长尾补充:services/coverImage.ts —— 源图本身就是 webp 且客户端**未**协商 webp。
// 此时既不能原样直出(客户端要 jpeg/png 系),也不能按 png/jpeg 分支走:
// 必须走"重新编码为 webp(保持格式)"这一支。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { loadAndRenderCover, clearRenderedCovers } from "../../src/services/coverImage.js";

const TMP = path.join(os.tmpdir(), `cover-webp-tail-${Date.now()}`);
let webpPath = "";

beforeAll(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  webpPath = path.join(TMP, "src.webp");
  const buf = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 10, g: 200, b: 90 } },
  })
    .webp()
    .toBuffer();
  fs.writeFileSync(webpPath, buf);
  clearRenderedCovers();
});

afterAll(() => {
  clearRenderedCovers();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("loadAndRenderCover: webp 源 + 未协商 webp", () => {
  it("按源格式重新编码为 webp(不落到 jpeg 兜底分支)", async () => {
    const out = await loadAndRenderCover(webpPath, 128, false);
    expect(out).not.toBeNull();
    expect(out!.contentType).toBe("image/webp");
    const meta = await sharp(Buffer.from(out!.data)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(128);
  });

  it("同一 webp 源二次调用命中缓存(etag 相同、字节一致)", async () => {
    const a = await loadAndRenderCover(webpPath, 64, false);
    const b = await loadAndRenderCover(webpPath, 64, false);
    expect(b!.etag).toBe(a!.etag);
    expect(Buffer.from(b!.data).equals(Buffer.from(a!.data))).toBe(true);
  });
});
