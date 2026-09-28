// 覆盖率长尾补充:services/coverImage.ts 的**降级面**。
//   - readCoverFile 抛错(磁盘抖动 / 权限)          → 返回 null,绝不把异常抛给路由
//   - sharp 原生模块不可用(镜像缺二进制)           → 原样回传字节 + 按扩展名猜 MIME
// 两条都是"后端不能因为封面库挂了就崩"的兜底,故单独一个文件用模块替身锁定。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../plugins/_env.js";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 可切换的替身开关(vi.mock 工厂被提升,故用 vi.hoisted 承载可变状态)。
const H = vi.hoisted(() => ({ readThrows: false }));

// sharp 原生模块加载即失败 —— 模拟"部署镜像跑不了 sharp"。
vi.mock("sharp", () => {
  throw new Error("sharp native binary unavailable (test stub)");
});

vi.mock("../../src/services/coverCache.js", async (imp) => {
  const real: any = await imp();
  return {
    ...real,
    readCoverFile: async (p: string) => {
      if (H.readThrows) throw new Error("read boom");
      return real.readCoverFile(p);
    },
  };
});

import { loadAndRenderCover, clearRenderedCovers } from "../../src/services/coverImage.js";

const TMP = path.join(os.tmpdir(), `cover-fallback-tail-${Date.now()}`);
let pngPath = "";
let gifPath = "";
let webpPath = "";

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  pngPath = path.join(TMP, "raw.png");
  gifPath = path.join(TMP, "raw.gif");
  webpPath = path.join(TMP, "raw.webp");
  fs.writeFileSync(pngPath, Buffer.from("raw-png-bytes-0123456789"));
  fs.writeFileSync(gifPath, Buffer.from("raw-gif-bytes-0123456789"));
  fs.writeFileSync(webpPath, Buffer.from("raw-webp-bytes-0123456789"));
  clearRenderedCovers();
});

afterAll(() => {
  clearRenderedCovers();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("coverImage 降级面", () => {
  it("readCoverFile 抛错 → 返回 null(调用方回退 404)", async () => {
    H.readThrows = true;
    try {
      await expect(loadAndRenderCover(pngPath, 300, false)).resolves.toBeNull();
    } finally {
      H.readThrows = false;
    }
  });

  it("sharp 不可用 → 原样回传字节,按扩展名猜 MIME(png/gif/webp)", async () => {
    const a = await loadAndRenderCover(pngPath, 300, true);
    expect(a).not.toBeNull();
    expect(a!.contentType).toBe("image/png"); // 扩展名 .png → image/png
    expect(Buffer.from(a!.data).toString()).toBe("raw-png-bytes-0123456789");

    const b = await loadAndRenderCover(gifPath, 300, true);
    expect(b!.contentType).toBe("image/gif"); // 扩展名 .gif → image/gif

    // .webp 必须映射到 image/webp(而不是落到 jpeg 默认值):否则无 sharp 的部署
    // 会把 webp 字节按 jpeg 发出去,浏览器解码失败。
    const c = await loadAndRenderCover(webpPath, 300, true);
    expect(c!.contentType).toBe("image/webp"); // 扩展名 .webp → image/webp
  });

  it("sharp 不可用时仍走 etag 缓存(同参数二次命中,字节一致)", async () => {
    const a = await loadAndRenderCover(pngPath, 222, false);
    const b = await loadAndRenderCover(pngPath, 222, false);
    expect(b!.etag).toBe(a!.etag);
    expect(Buffer.from(b!.data).equals(Buffer.from(a!.data))).toBe(true);
  });
});
