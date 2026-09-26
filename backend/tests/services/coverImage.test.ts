// coverImage(封面按需缩放/转码 + 内存缓存)契约测试:
// 落点:getCoverArt 的 size 参数此前被忽略(1000×1000 原图直出),以及 webp 协商、
// 缓存命中、内存预算回收。缓存不回收会直接把后端内存顶爆,故 evict 也纳入断言。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import {
  loadAndRenderCover,
  clearRenderedCovers,
  getRenderedCoverBytes,
} from "../../src/services/coverImage.js";

const TMP = path.join(os.tmpdir(), `cover-image-test-${Date.now()}`);
let pngPath = "";
let jpegPath = "";
let corruptPath = "";

async function writeImage(name: string, format: "png" | "jpeg", size = 1200): Promise<string> {
  const buf = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    [format]()
    .toBuffer();
  const p = path.join(TMP, name);
  fs.writeFileSync(p, buf);
  return p;
}

beforeAll(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  pngPath = await writeImage("cover.png", "png");
  jpegPath = await writeImage("cover.jpg", "jpeg");
  corruptPath = path.join(TMP, "broken.jpg");
  fs.writeFileSync(corruptPath, Buffer.from("not-an-image-at-all-0123456789"));
  clearRenderedCovers();
});

afterAll(() => {
  clearRenderedCovers();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("loadAndRenderCover: 输入边界", () => {
  it("文件不存在 → null(调用方回退 404,不抛异常)", async () => {
    await expect(loadAndRenderCover(path.join(TMP, "missing.jpg"), 300, false)).resolves.toBeNull();
  });

  it("路径是目录 → null", async () => {
    await expect(loadAndRenderCover(TMP, 300, false)).resolves.toBeNull();
  });
});

describe("loadAndRenderCover: 格式与协商", () => {
  it("请求 webp 且源为 png → 输出 image/webp", async () => {
    const out = await loadAndRenderCover(pngPath, 300, true);
    expect(out).not.toBeNull();
    expect(out!.contentType).toBe("image/webp");
    const meta = await sharp(Buffer.from(out!.data)).metadata();
    expect(meta.format).toBe("webp");
  });

  it("不请求 webp 时保留原格式(png → image/png)", async () => {
    const out = await loadAndRenderCover(pngPath, 300, false);
    expect(out!.contentType).toBe("image/png");
  });

  it("jpeg 源且不要 webp → image/jpeg", async () => {
    const out = await loadAndRenderCover(jpegPath, 300, false);
    expect(out!.contentType).toBe("image/jpeg");
  });

  it("损坏/不可解码的图 → 回退原始字节 + 按扩展名猜 MIME,绝不抛错", async () => {
    const out = await loadAndRenderCover(corruptPath, 300, true);
    expect(out).not.toBeNull();
    expect(out!.contentType).toBe("image/jpeg");
    expect(Buffer.from(out!.data).toString()).toBe("not-an-image-at-all-0123456789");
  });
});

describe("loadAndRenderCover: 尺寸钳制", () => {
  it("size 上溢(5000)钳到 1200", async () => {
    const out = await loadAndRenderCover(pngPath, 5000, false);
    const meta = await sharp(Buffer.from(out!.data)).metadata();
    expect(meta.width).toBe(1200);
  });

  it("size 下溢(1)钳到 24", async () => {
    const out = await loadAndRenderCover(pngPath, 1, false);
    const meta = await sharp(Buffer.from(out!.data)).metadata();
    expect(meta.width).toBe(24);
  });

  it("size 缺失/NaN → 默认 300", async () => {
    const out = await loadAndRenderCover(pngPath, Number.NaN, false);
    const meta = await sharp(Buffer.from(out!.data)).metadata();
    expect(meta.width).toBe(300);
  });
});

describe("loadAndRenderCover: 缓存与内存预算", () => {
  it("同参数二次调用命中缓存:etag 相同且不再增加持有字节", async () => {
    clearRenderedCovers();
    const a = await loadAndRenderCover(pngPath, 256, false);
    const afterFirst = getRenderedCoverBytes();
    const b = await loadAndRenderCover(pngPath, 256, false);
    expect(b!.etag).toBe(a!.etag);
    expect(getRenderedCoverBytes()).toBe(afterFirst);
    expect(Buffer.from(b!.data).equals(Buffer.from(a!.data))).toBe(true);
  });

  it("参数变化(size/格式)必须产生不同 etag,避免串图", async () => {
    const a = await loadAndRenderCover(pngPath, 256, false);
    const b = await loadAndRenderCover(pngPath, 257, false);
    const c = await loadAndRenderCover(pngPath, 256, true);
    expect(new Set([a!.etag, b!.etag, c!.etag]).size).toBe(3);
  });

  it("clearRenderedCovers 清空缓存并归零字节计数", async () => {
    await loadAndRenderCover(pngPath, 320, false);
    expect(getRenderedCoverBytes()).toBeGreaterThan(0);
    clearRenderedCovers();
    expect(getRenderedCoverBytes()).toBe(0);
  });

  it(
    "连续渲染 520 个不同尺寸:内存预算生效(持有字节不突破 32MB),且不报错",
    async () => {
      clearRenderedCovers();
      for (let i = 0; i < 520; i++) {
        const size = 24 + (i % 1100);
        const out = await loadAndRenderCover(pngPath, size, false);
        expect(out).not.toBeNull();
      }
      const held = getRenderedCoverBytes();
      expect(held).toBeLessThanOrEqual(32 * 1024 * 1024);
      // 若没有 evict,520 张 300px 级 png 会远超一条 512KB 的中位大小 × 520。
      expect(held).toBeLessThan(520 * 512 * 1024);
      clearRenderedCovers();
    },
    120_000,
  );
});
