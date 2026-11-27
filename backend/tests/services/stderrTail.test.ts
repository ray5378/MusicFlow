import { describe, it, expect } from "vitest";
import { StderrTail, STDERR_KEEP_BYTES } from "../../src/services/audio/stderrTail.js";

// stderr 累积必须「丢开头、留末尾」—— loudnorm 的 JSON 报告打在 stderr 最末尾，
// 冻结在开头会导致长曲目永远解析不到测量值（静默失败）。
describe("StderrTail（只保留最近字节）", () => {
  it("上限非法时抛错", () => {
    expect(() => new StderrTail(0)).toThrow();
    expect(() => new StderrTail(-1)).toThrow();
    expect(() => new StderrTail(NaN)).toThrow();
    expect(() => new StderrTail(10)).not.toThrow();
  });

  it("未超限原样保留（字符串与 Buffer 混合 push）", () => {
    const t = new StderrTail(100);
    t.push("hello ");
    t.push(Buffer.from("world"));
    expect(t.text()).toBe("hello world");
    expect(t.length).toBe(11);
  });

  it("空块忽略", () => {
    const t = new StderrTail(10);
    t.push("");
    t.push(Buffer.alloc(0));
    expect(t.length).toBe(0);
  });

  it("超限时丢开头留末尾（关键回归）", () => {
    const t = new StderrTail(10);
    t.push("0123456789ABCDEF"); // 16 字节
    expect(t.length).toBe(10);
    expect(t.text()).toBe("6789ABCDEF"); // 保留最后 10 字节
  });

  it("多次 push 后末尾仍是最新的（loudnorm JSON 在末尾）", () => {
    const t = new StderrTail(16);
    t.push("aaaabbbb");
    t.push("cccc");
    expect(t.text()).toBe("aaaabbbbcccc");
    t.push("{input_i:-23}"); // 模拟末尾的 JSON 报告（超 16 字节 → 丢开头）
    expect(t.text()).toContain("{input_i:-23}"); // 末尾 JSON 完整保留
    expect(t.text()).not.toContain("aaaa"); // 开头被丢弃
  });

  it("clear 清空", () => {
    const t = new StderrTail(100);
    t.push("data");
    t.clear();
    expect(t.length).toBe(0);
    expect(t.text()).toBe("");
  });

  it("默认上限为 64KB", () => {
    expect(STDERR_KEEP_BYTES).toBe(64 * 1024);
    expect(new StderrTail().length).toBe(0);
  });
});
