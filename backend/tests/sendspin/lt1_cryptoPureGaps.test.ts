// cpace.ts + pairing.ts 覆盖率补口:密码学纯函数的**长输入/边界**与配对码生成。
//
// cpace 缺口:
//   - prependLen 的**多字节变长长度前缀**分支(载荷 ≥128B 时才走到)。sendspin 的
//     pairing PRS 正常都短,但 CPace 是通用 PAKE,长 PRS/CI 必须仍然自洽 ——
//     长度前缀写错会让两端 generator 不同 → ISK 对不上 → 配对必然失败且无提示。
//   - ladderMult 末尾的**收尾交换**(标量最低位为 1 时触发)。它是低阶点检测的
//     正确性前提:少一次交换 = [8]P 判据算错 → 要么误收小阶点(安全),要么把正常
//     设备判成低阶点(配对直接失败)。
//
// pairing 缺口:generateDynamicCode(6 位)/ generateStaticCode(8 位) 从未被断言过 ——
//   这两条是「码印机身/设备外放」的**唯一格式契约**,位数错了用户根本无法输入。
import "../plugins/_env.js";

import { describe, it, expect } from "vitest";
import { CPace, ladderMult } from "../../src/services/sendspin/cpace.js";
import { generateDynamicCode, generateStaticCode, StaticCodeGate, attemptStaticCode } from "../../src/services/sendspin/pairing.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("cpace:变长长度前缀(≥128 字节 PRS)", () => {
  it("200 字节 PRS 两端仍能互相验证标签(多字节长度前缀两端一致)", () => {
    const prs = new Uint8Array(200).fill(0x5a); // 长度 200 = 0xC8 → prependLen 需输出 2 字节
    const sid = new Uint8Array([9, 8, 7, 6]);
    const a = CPace.start({ role: "initiator", prs, sid, ad: enc("server") });
    const b = CPace.start({ role: "responder", prs, sid, ad: enc("client") });
    b.derive(a.publicShare, enc("server"));
    a.derive(b.publicShare, enc("client"));
    // 契约:同一 PRS 的两端必须派生出互认的会话密钥;长度前缀写错时这里必失败。
    expect(b.verify(a.tag())).toBe(true);
    expect(a.verify(b.tag())).toBe(true);
    expect(a.getISK()).toEqual(b.getISK());
  });
});

describe("cpace:Montgomery ladder 的收尾交换与低阶点判据", () => {
  it("标量最低位为 1(触发收尾交换)时 1·P 返回 P 自身", () => {
    const u = new Uint8Array(32);
    u[0] = 9; // 曲线基点的 u 坐标
    const scalar = new Uint8Array(32); // 全 0,只把 bit0 置 1 → 循环结束后 swap=1
    scalar[0] = 1;
    const r = ladderMult(scalar, u);
    // 契约:未钳制标量下 k=1 必须还是 P;收尾交换漏掉会得到错误的 y 分支/中间值。
    expect(Array.from(r)).toEqual(Array.from(u));
  });

  it("标量 0 → 单位元(全零坐标),这正是 [8]P==0 判据所依赖的形态", () => {
    const u = new Uint8Array(32);
    u[0] = 9;
    const r = ladderMult(new Uint8Array(32), u);
    // 契约:0·P 是单位元,编码为全零 —— isLowOrderPoint 靠这个判小阶点。
    expect(r.every((b) => b === 0)).toBe(true);
  });

  it("u=0(阶为 2 的点)对任意标量都塌成单位元", () => {
    const eight = new Uint8Array(32);
    eight[0] = 8;
    const r = ladderMult(eight, new Uint8Array(32));
    expect(r.every((b) => b === 0)).toBe(true);
  });
});

describe("pairing:配对码生成格式契约", () => {
  it("动态码恒为 6 位数字且落在 100000..999999", () => {
    for (let i = 0; i < 30; i++) {
      const c = generateDynamicCode();
      expect(c).toMatch(/^\d{6}$/);
      const n = Number(c);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
    }
  });

  it("静态码恒为 8 位数字且落在 10000000..99999999", () => {
    for (let i = 0; i < 30; i++) {
      const c = generateStaticCode();
      expect(c).toMatch(/^\d{8}$/);
      const n = Number(c);
      expect(n).toBeGreaterThanOrEqual(10000000);
      expect(n).toBeLessThanOrEqual(99999999);
    }
  });

  it("StaticCodeGate:达到上限即锁定;窗口过期后 attemptStaticCode 重置计数", () => {
    const gate = new StaticCodeGate(1000, 3);
    expect(attemptStaticCode(gate, "11111111", "00000000", 1000).locked).toBe(false);
    expect(attemptStaticCode(gate, "11111111", "00000000", 1000).locked).toBe(false);
    expect(attemptStaticCode(gate, "11111111", "00000000", 1000).locked).toBe(true);
    expect(gate.locked()).toBe(true);
    // 窗口过期 → 重新给机会(否则一次误输会永久锁死设备)
    expect(gate.expired(1000 + 1001)).toBe(true);
    expect(attemptStaticCode(gate, "11111111", "00000000", 1000 + 1001).locked).toBe(false);
    expect(gate.failures).toBe(1);
  });
});
