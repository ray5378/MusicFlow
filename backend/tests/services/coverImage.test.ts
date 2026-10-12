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
  getActiveRenderCount,
  getQueuedRenderCount,
  getCoverPressure,
  buildCoverPressureHeaders,
  RENDER_CONCURRENCY,
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
    "连续渲染 520 个不同尺寸:内存预算生效(持有字节不突破 48MB),且不报错",
    async () => {
      clearRenderedCovers();
      for (let i = 0; i < 520; i++) {
        const size = 24 + (i % 1100);
        const out = await loadAndRenderCover(pngPath, size, false);
        expect(out).not.toBeNull();
      }
      const held = getRenderedCoverBytes();
      // 预算默认 48MB(COVER_RENDER_CACHE_MB)。evict 在每次写入后跑到预算以内。
      expect(held).toBeLessThanOrEqual(48 * 1024 * 1024);
      // 若没有 evict,520 张 300px 级 png 会远超一条 512KB 的中位大小 × 520。
      expect(held).toBeLessThan(520 * 512 * 1024);
      clearRenderedCovers();
    },
    120_000,
  );
});

// 2026-10-12 封面慢请求治理(B)新增面:单飞去重 + 并发护栏。
// 这两条是"冷缓存一屏封面并发"场景的直接防线,必须有回归锁:
//   - 单飞失效 → 同一张图被渲染多次,白占 sharp 吞吐(约 130 张/秒的天花板);
//   - 并发护栏失效 → 上百个 sharp 渲染同时在途,瞬时 native 内存可达数百 MB。
describe("loadAndRenderCover: 单飞与并发护栏", () => {
  it("同参数并发请求单飞:共享同一次渲染(同一对象、字节只登记一次)", async () => {
    clearRenderedCovers();
    const [a, b, c, d] = await Promise.all([
      loadAndRenderCover(pngPath, 233, false),
      loadAndRenderCover(pngPath, 233, false),
      loadAndRenderCover(pngPath, 233, false),
      loadAndRenderCover(pngPath, 233, false),
    ]);
    expect(a).not.toBeNull();
    // 单飞的具体表征:四个调用方拿到同一个结果对象(而不是四份各渲染一次的结果)。
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(d).toBe(a);
    // 只登记了一份字节。
    expect(getRenderedCoverBytes()).toBe(a!.data.byteLength);
  });

  it("单飞不串图:同一批并发里不同 size 仍各渲染各的(etag 互不相同)", async () => {
    clearRenderedCovers();
    const outs = await Promise.all(
      [101, 102, 103, 104, 105].map((s) => loadAndRenderCover(pngPath, s, false)),
    );
    expect(outs.every((o) => o !== null)).toBe(true);
    expect(new Set(outs.map((o) => o!.etag)).size).toBe(5);
  });

  it("不同格式(wantWebp)不共用单飞槽位", async () => {
    clearRenderedCovers();
    const [jpeg, webp] = await Promise.all([
      loadAndRenderCover(pngPath, 244, false),
      loadAndRenderCover(pngPath, 244, true),
    ]);
    expect(jpeg!.contentType).toBe("image/png");
    expect(webp!.contentType).toBe("image/webp");
    expect(jpeg!.etag).not.toBe(webp!.etag);
  });

  it("在途渲染数始终不超过 RENDER_CONCURRENCY,且一批并发全部完成", async () => {
    clearRenderedCovers();
    let peak = 0;
    let done = false;
    const sampler = (async () => {
      while (!done) {
        peak = Math.max(peak, getActiveRenderCount());
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    const outs = await Promise.all(
      Array.from({ length: 12 }, (_, i) => loadAndRenderCover(pngPath, 300 + i, false)),
    );
    done = true;
    await sampler;

    expect(outs.every((o) => o !== null)).toBe(true);
    // 上界是护栏本身的不变式:去掉信号量时这里会摸到 12。
    expect(peak).toBeLessThanOrEqual(RENDER_CONCURRENCY);
    // 下界证明采样确实观察到并发渲染(否则上界断言会退化成永真)。
    expect(peak).toBeGreaterThan(0);
    // 队列在结算后必须清空,不能泄漏等待者。
    expect(getQueuedRenderCount()).toBe(0);
    expect(getActiveRenderCount()).toBe(0);
    clearRenderedCovers();
  });

  it("渲染抛错也不会泄漏槽位(损坏图走降级分支后仍能继续渲染)", async () => {
    clearRenderedCovers();
    // 损坏图:sharp 会抛,走 catch 降级返回原始字节;槽位必须被 finally 归还,
    // 否则后续请求会永远排在队列上(表现为"封面全挂")。
    const bad = await loadAndRenderCover(corruptPath, 300, true);
    expect(bad).not.toBeNull();
    expect(getActiveRenderCount()).toBe(0);
    expect(getQueuedRenderCount()).toBe(0);
    const good = await loadAndRenderCover(pngPath, 321, false);
    expect(good).not.toBeNull();
  });
});

// 端到端背压(ADR-4):封面渲染管线压力快照 + 响应头映射。
// 服务端把渲染并发上限回传给调用方,并在管线饱和时给出 Retry-After 退避提示;
// 抽成纯函数以便确定性断言两条分支(不依赖真实渲染时序)。
describe("封面端到端背压:压力快照与响应头映射", () => {
  it("空闲时快照:无排队、未饱和,limit 为渲染并发上限", () => {
    const p = getCoverPressure();
    expect(p.queued).toBe(0);
    expect(p.limit).toBe(RENDER_CONCURRENCY);
    expect(p.saturated).toBe(false);
  });

  it("未饱和:只回传并发上限,不给 Retry-After", () => {
    const h = buildCoverPressureHeaders({
      active: 1,
      queued: 0,
      limit: 4,
      saturated: false,
    });
    expect(h["X-MusicFlow-Cover-Concurrency"]).toBe("4");
    expect(h["X-MusicFlow-Cover-Active"]).toBe("1");
    expect(h["X-MusicFlow-Cover-Queued"]).toBe("0");
    expect(h["Retry-After"]).toBeUndefined();
    expect(h["X-MusicFlow-Cover-Saturated"]).toBeUndefined();
  });

  it("饱和(有排队):回传 Retry-After 供调用方退避", () => {
    const h = buildCoverPressureHeaders({
      active: 4,
      queued: 3,
      limit: 4,
      saturated: true,
    });
    expect(h["Retry-After"]).toBe("1");
    expect(h["X-MusicFlow-Cover-Saturated"]).toBe("1");
    expect(h["X-MusicFlow-Cover-Queued"]).toBe("3");
  });

  it("饱和(槽位占满但暂无排队):同样给出退避提示", () => {
    const h = buildCoverPressureHeaders({
      active: 4,
      queued: 0,
      limit: 4,
      saturated: true,
    });
    expect(h["Retry-After"]).toBe("1");
  });
});
