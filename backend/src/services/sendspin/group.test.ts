import { describe, it, expect, beforeEach } from "vitest";
import { distributeGroupVolume, SendspinGroup } from "./group.js";

describe("distributeGroupVolume", () => {
  it("两成员音量 50/100 → 有效 50/100", () => {
    const r = distributeGroupVolume([
      { volume: 50, muted: false },
      { volume: 100, muted: false },
    ]);
    expect(r.members.map((m) => m.effective)).toEqual([50, 100]);
  });

  it("静音成员有效音量归 0", () => {
    const r = distributeGroupVolume([
      { volume: 100, muted: true },
      { volume: 0, muted: false },
    ]);
    expect(r.members[0].effective).toBe(0);
  });

  it("空组 scale=1", () => {
    expect(distributeGroupVolume([]).scale).toBe(1);
  });
});

describe("SendspinGroup", () => {
  let g: SendspinGroup;
  beforeEach(() => {
    g = new SendspinGroup("g1");
  });
  it("默认组音量/位置", () => {
    expect(g.props.volume).toBe(100);
    expect(g.props.muted).toBe(false);
  });
});