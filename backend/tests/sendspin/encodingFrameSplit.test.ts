// ==================== Sendspin FLAC 帧切分(encoding.ts)补齐测试 ====================
//
// B23:encoding.ts 里真正决定「有没有声音」的 splitFlacFrames(以及它依赖的
// 子帧位流遍历)此前一行没覆盖 —— 而 2026-09-17 的五次无声事故全部出在这段:
//   1) 容器头没跳过 → 设备在期待帧同步的位置读到 "fLaC";
//   2) 一包多帧 / 一包半帧 → micro-flac 一次只解一帧,多余字节静默丢弃;
//   3) 声道码按 3bit 截 → mid/side 被判成 3 声道 → 帧长走飞,一帧都切不出;
//   4) unary 方向搞反 → 残差长度偏大 → 子帧结束位错位;
//   5) 分区样本数口径错 → 高压缩级别下首帧读爆。
// 这里**按 RFC 9639 手工造真实 FLAC 帧**(不是打桩),逐条钉死。
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { splitFlacFrames } from "../../src/services/sendspin/encoding.js";

// ---------------- 位流工具(MSB first) ----------------
class BitWriter {
  private out: number[] = [];
  private cur = 0;
  private n = 0;
  bit(b: number): void {
    this.cur = (this.cur << 1) | (b & 1);
    if (++this.n === 8) {
      this.out.push(this.cur & 0xff);
      this.cur = 0;
      this.n = 0;
    }
  }
  bits(v: number, k: number): void {
    for (let i = k - 1; i >= 0; i--) this.bit((v >> i) & 1);
  }
  zeros(k: number): void {
    for (let i = 0; i < k; i++) this.bit(0);
  }
  /** FLAC unary:数连续 0 直到出现 1(RFC 9639 §5),写反会让残差长度整体偏大。 */
  unary(v: number): void {
    this.zeros(v);
    this.bit(1);
  }
  finish(): Buffer {
    if (this.n) this.zeros(8 - this.n);
    return Buffer.from(this.out);
  }
}

const BPS_TABLE = [0, 8, 12, 0, 16, 20, 24, 32];
const BLOCK: Record<number, number> = {
  1: 192, 2: 576, 3: 1152, 4: 2304, 5: 4608,
  8: 256, 9: 512, 10: 1024, 11: 2048, 12: 4096, 13: 8192, 14: 16384, 15: 32768,
};

interface ResOpt {
  method?: number;
  partitionOrder?: number;
  params?: number[];
  escapeRawBits?: number;
}

/** 残差编码段:Rice / Rice2 分区,首个分区要减掉预测阶数。 */
function residual(w: BitWriter, blockSize: number, order: number, o: ResOpt = {}): void {
  const method = o.method ?? 0;
  const po = o.partitionOrder ?? 0;
  const paramBits = method === 0 ? 4 : 5;
  const escape = method === 0 ? 15 : 31;
  w.bits(method, 2);
  w.bits(po, 4);
  const partitions = 1 << po;
  const per = blockSize >> po;
  for (let p = 0; p < partitions; p++) {
    const n = p === 0 ? per - order : per;
    const param = o.params?.[p] ?? 0;
    w.bits(param, paramBits);
    if (n === 0) continue;
    if (param === escape) {
      const rb = o.escapeRawBits ?? 0;
      w.bits(rb, 5);
      w.zeros(n * rb);
    } else {
      for (let i = 0; i < n; i++) {
        w.unary(0);
        w.zeros(param);
      }
    }
  }
}

type Body = (w: BitWriter, effBps: number, blockSize: number) => void;

const B_CONST: Body = (w, e) => w.zeros(e);
const B_VERB: Body = (w, e, bs) => w.zeros(bs * e);
const B_FIXED = (order: number, r?: ResOpt): Body => (w, e, bs) => {
  w.zeros(order * e);
  residual(w, bs, order, r);
};
const B_LPC = (order: number, prec: number, r?: ResOpt): Body => (w, e, bs) => {
  w.zeros(order * e);
  w.bits(prec, 4);
  w.zeros(5);
  w.zeros((prec + 1) * order);
  residual(w, bs, order, r);
};

/** 写一个子帧:padding(0) + 6bit 类型 + wasted 标志 + 负载。 */
function sub(w: BitWriter, type: number, body: Body | null, bps: number, bs: number, wasted = 0): void {
  w.bit(0);
  w.bits(type, 6);
  if (wasted > 0) {
    w.bit(1);
    w.unary(wasted - 1);
  } else {
    w.bit(0);
  }
  const eff = bps - wasted;
  if (eff > 0 && body) body(w, eff, bs);
}

type Sub = (w: BitWriter, bps: number, bs: number) => void;
const subConst = (wasted = 0): Sub => (w, bps, bs) => sub(w, 0, B_CONST, bps, bs, wasted);
const subVerbatim = (): Sub => (w, bps, bs) => sub(w, 1, B_VERB, bps, bs);
const subFixed = (order: number, r?: ResOpt): Sub => (w, bps, bs) => sub(w, 8 + order, B_FIXED(order, r), bps, bs);
const subLpc = (order: number, prec: number, r?: ResOpt): Sub => (w, bps, bs) =>
  sub(w, 32 + (order - 1), B_LPC(order, prec, r), bps, bs);
const subBad = (type: number): Sub => (w, bps, bs) => sub(w, type, null, bps, bs);

function frame(o: {
  bsizeCode?: number;
  chanCode?: number;
  bpsCode?: number;
  srCode?: number;
  frameNo?: number[];
  head?: Buffer;
  subs: Sub[];
}): Buffer {
  const bsizeCode = o.bsizeCode ?? 12;
  const bps = BPS_TABLE[o.bpsCode ?? 4] || 16;
  const bs = BLOCK[bsizeCode];
  const head =
    o.head ??
    Buffer.from([
      0xff,
      0xf8,
      (bsizeCode << 4) | (o.srCode ?? 10),
      ((o.chanCode ?? 1) << 4) | ((o.bpsCode ?? 4) << 1),
      ...(o.frameNo ?? [0x00]),
      0x00, // CRC-8(本测试不校验)
    ]);
  const w = new BitWriter();
  for (const s of o.subs) s(w, bps, bs);
  return Buffer.concat([head, w.finish(), Buffer.alloc(2)]); // 尾部 CRC-16
}

/** 造「fLaC + 元数据块」容器头。 */
function flacContainer(blocks: Array<[boolean, number, number]>): Buffer {
  const parts: Buffer[] = [Buffer.from("fLaC", "ascii")];
  for (const [isLast, type, len] of blocks) {
    const hdr = Buffer.alloc(4);
    hdr[0] = (isLast ? 0x80 : 0x00) | (type & 0x7f);
    hdr[1] = (len >> 16) & 0xff;
    hdr[2] = (len >> 8) & 0xff;
    hdr[3] = len & 0xff;
    parts.push(hdr, Buffer.alloc(len));
  }
  return Buffer.concat(parts);
}

const twoConst = (): Sub[] => [subConst(), subConst()];

describe("splitFlacFrames:基础切分", () => {
  it("两帧裸流 → 每包恰好一帧(设备按「一包一帧」解码)", () => {
    const f = frame({ subs: twoConst() });
    expect(f.length).toBe(14); // 6B 帧头 + 6B 两个 CONSTANT 子帧 + 2B CRC-16
    const r = splitFlacFrames(Buffer.concat([f, f]));
    expect(r.frames.length).toBe(2);
    expect(r.frames[0].length).toBe(14);
    expect(r.frames[1].length).toBe(14);
    expect(r.rest.length).toBe(0);
    expect(r.skippedContainerBytes).toBe(0);
  });

  it("【回归 1】容器头(fLaC + STREAMINFO)整段跳过,不混进音频 chunk", () => {
    const r = splitFlacFrames(
      Buffer.concat([flacContainer([[true, 0, 34]]), frame({ subs: twoConst() }), frame({ subs: twoConst() })]),
    );
    expect(r.skippedContainerBytes).toBe(42);
    expect(r.frames.length).toBe(2);
    expect(r.frames[0].subarray(0, 2).toString("ascii")).not.toBe("fL");
  });

  it("容器头还没收全 → 一帧都不切,原样保留等下一轮", () => {
    const c = flacContainer([[false, 0, 34], [false, 4, 44]]);
    const r = splitFlacFrames(c);
    expect(r.frames.length).toBe(0);
    expect(r.rest.length).toBe(c.length);
    expect(r.skippedContainerBytes).toBe(0);
  });

  it("既非容器头也非同步字:向后重新定位到第一个合法帧头", () => {
    const r = splitFlacFrames(
      Buffer.concat([Buffer.from([0x01, 0x02, 0x03]), frame({ subs: twoConst() }), frame({ subs: twoConst() })]),
    );
    expect(r.skippedContainerBytes).toBe(3);
    expect(r.frames.length).toBe(2);
  });

  it("找不到任何合法帧头 → 原地等待,不做破坏性截断", () => {
    const r = splitFlacFrames(Buffer.alloc(64, 0x01));
    expect(r.frames.length).toBe(0);
    expect(r.rest.length).toBe(64);
  });

  it("容器头后面不是帧同步 → 只跳过容器头,余下原样保留", () => {
    const r = splitFlacFrames(Buffer.concat([flacContainer([[true, 0, 34]]), Buffer.alloc(10, 0x11)]));
    expect(r.skippedContainerBytes).toBe(42);
    expect(r.frames.length).toBe(0);
    expect(r.rest.length).toBe(10);
  });

  it("有同步字但帧头字段非法(块长码 0)→ 不切", () => {
    expect(splitFlacFrames(frame({ bsizeCode: 0, subs: [] })).frames.length).toBe(0);
  });
});

describe("splitFlacFrames:数据不足一律保留残余(绝不猜边界)", () => {
  it("帧头尚未收全(UTF-8 帧号跨字节)→ 等下一轮", () => {
    const f = frame({ frameNo: [0xc0, 0x80], subs: twoConst() });
    expect(splitFlacFrames(f.subarray(0, 6)).frames.length).toBe(0);
  });

  it("子帧数据不足 → 保留残余", () => {
    const f = frame({ subs: twoConst() });
    const r = splitFlacFrames(f.subarray(0, 10));
    expect(r.frames.length).toBe(0);
    expect(r.rest.length).toBe(10);
  });

  it("CRC-16 尚未到齐 → 不把半帧当成品下发", () => {
    const f = frame({ subs: twoConst() });
    expect(splitFlacFrames(f.subarray(0, 12)).frames.length).toBe(0);
  });

  it("残尾恰好是下一帧同步字 → 采信 aligned(不把下一帧的头吃掉)", () => {
    const f = frame({ subs: twoConst() });
    const r = splitFlacFrames(Buffer.concat([f, Buffer.from([0xff, 0xf8])]));
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].length).toBe(14);
    expect(r.rest.length).toBe(2);
  });

  it("残尾无法判定 → 回落主口径(宁可多带 1 字节,也不截断帧)", () => {
    const f = frame({ subs: twoConst() });
    const r = splitFlacFrames(Buffer.concat([f, Buffer.from([0x00])]));
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].length).toBe(15);
  });
});

describe("子帧类型:四种都要能逐位走完", () => {
  it("VERBATIM(256 样本):整块原始样本位流跳过", () => {
    const f = frame({ bsizeCode: 8, subs: [subVerbatim(), subVerbatim()] });
    expect(f.length).toBe(6 + 1026 + 2);
    const r = splitFlacFrames(f);
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].length).toBe(f.length);
  });

  it("FIXED(order 0):Rice 残差逐分区跳过", () => {
    const f = frame({ bsizeCode: 8, subs: [subFixed(0), subFixed(0)] });
    const r = splitFlacFrames(f);
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].length).toBe(f.length);
  });

  it("FIXED(order 4):warm-up 样本原样占位后再走残差", () => {
    const f = frame({ bsizeCode: 8, subs: [subFixed(4), subFixed(4)] });
    expect(splitFlacFrames(f).frames.length).toBe(1);
  });

  it("LPC(order 1 / 系数精度 0):系数区与残差区都跳过", () => {
    const f = frame({ bsizeCode: 8, subs: [subLpc(1, 0), subLpc(1, 0)] });
    expect(splitFlacFrames(f).frames.length).toBe(1);
  });

  it("LPC 系数精度 15(非法)→ 该帧判废", () => {
    expect(splitFlacFrames(frame({ bsizeCode: 8, subs: [subLpc(1, 15), subConst()] })).frames.length).toBe(0);
  });

  it("保留子帧类型 → 判废,不猜长度", () => {
    expect(splitFlacFrames(frame({ subs: [subBad(2), subConst()] })).frames.length).toBe(0);
  });
});

describe("wasted-bits 与残差分区", () => {
  it("wasted = 2 → 有效位深按 14 走,帧照样切出", () => {
    const r = splitFlacFrames(frame({ subs: [subConst(2), subConst(2)] }));
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].length).toBe(14);
  });

  it("wasted 把有效位深吃光(16)→ 判废", () => {
    expect(splitFlacFrames(frame({ subs: [subConst(16), subConst(16)] })).frames.length).toBe(0);
  });

  it("残差方法 2(保留)→ 判废", () => {
    expect(
      splitFlacFrames(frame({ bsizeCode: 8, subs: [subFixed(0, { method: 2 }), subConst()] })).frames.length,
    ).toBe(0);
  });

  it("Rice escape(参数 15)→ 走原始位宽分支", () => {
    const f = frame({
      bsizeCode: 8,
      subs: [subFixed(0, { params: [15], escapeRawBits: 8 }), subFixed(0, { params: [15], escapeRawBits: 8 })],
    });
    expect(splitFlacFrames(f).frames.length).toBe(1);
  });

  it("多分区(partitionOrder 1):首分区要减掉预测阶数", () => {
    const f = frame({ bsizeCode: 8, subs: [subFixed(1, { partitionOrder: 1 }), subFixed(1, { partitionOrder: 1 })] });
    const r = splitFlacFrames(f);
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].length).toBe(f.length); // 首分区少算 1 个样本就会整帧错位
  });

  it("首分区样本数为 0 → 跳过该分区继续(不是判废)", () => {
    const f = frame({ bsizeCode: 8, subs: [subFixed(1, { partitionOrder: 8 }), subFixed(1, { partitionOrder: 8 })] });
    expect(splitFlacFrames(f).frames.length).toBe(1);
  });

  it("首分区样本数为负(阶数超过分区)→ 判废", () => {
    expect(
      splitFlacFrames(frame({ bsizeCode: 8, subs: [subFixed(2, { partitionOrder: 8 }), subConst()] })).frames.length,
    ).toBe(0);
  });

  it("Rice2(method 1):参数位宽 5、escape 31", () => {
    const f = frame({ bsizeCode: 8, subs: [subFixed(0, { method: 1 }), subFixed(0, { method: 1 })] });
    expect(splitFlacFrames(f).frames.length).toBe(1);
  });

  it("【防御】unary 读爆(>2^20 个 0)→ 判废而不是无限循环", () => {
    const w = new BitWriter();
    w.bit(0);
    w.bits(8, 6); // FIXED order 0
    w.bit(0);
    w.bits(0, 2); // method 0
    w.bits(0, 4); // partitionOrder 0
    w.bits(0, 4); // rice param 0 → 之后每个样本一个 unary
    const buf = Buffer.concat([
      frame({ subs: [] }).subarray(0, 6), // 6B 帧头(帧体从第 6 字节起)
      w.finish(),
      Buffer.alloc(132 * 1024), // 全是 0:unary 一路吃不到 1
    ]);
    expect(splitFlacFrames(buf).frames.length).toBe(0);
  }, 30_000);
});

describe("帧头字段的缺省与扩展", () => {
  it("声道码 0(同流默认)→ 按 STREAMINFO 缺省的 2 子帧走", () => {
    const r = splitFlacFrames(frame({ chanCode: 0, subs: twoConst() }));
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].length).toBe(14); // 两个子帧都走完才是 14B
  });

  it("【回归 3 / 2026-09-17】mid/side 联合立体声(声道码 10)仍是 2 子帧", () => {
    const f = frame({ chanCode: 10, subs: twoConst() });
    const r = splitFlacFrames(f);
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].length).toBe(14);
  });

  it("mid/side 连切多帧:每包一帧", () => {
    const f = frame({ chanCode: 10, subs: twoConst() });
    expect(splitFlacFrames(Buffer.concat([f, f, f])).frames.length).toBe(3);
  });

  it("位深码 0(同流默认)→ 取 16bit", () => {
    expect(splitFlacFrames(frame({ bpsCode: 0, subs: twoConst() })).frames.length).toBe(1);
  });

  it("块长码 6 / 采样率码 12:各多读 1 字节", () => {
    const head = Buffer.from([0xff, 0xf8, (6 << 4) | 12, (1 << 4) | (4 << 1), 0x00, 0x0f, 0x00, 0x00]);
    const f = frame({ head, subs: twoConst() }); // CONSTANT 与块长无关
    const r = splitFlacFrames(f);
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].length).toBe(16); // 8B 头 + 6B 子帧 + 2B CRC
  });

  it("块长码 7 / 采样率码 13:各多读 2 字节", () => {
    const head = Buffer.from([
      0xff, 0xf8, (7 << 4) | 13, (1 << 4) | (4 << 1), 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    ]);
    const f = frame({ head, subs: twoConst() });
    const r = splitFlacFrames(f);
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].length).toBe(18); // 10B 头 + 6B 子帧 + 2B CRC
  });

  it("UTF-8 三字节帧号:按前导 1 的个数推进帧体偏移", () => {
    const f = frame({ frameNo: [0xe0, 0x80, 0x80], subs: twoConst() });
    const r = splitFlacFrames(f);
    expect(r.frames.length).toBe(1);
    expect(r.frames[0].length).toBe(16); // 8B 头 + 6B 子帧 + 2B CRC
  });
});
