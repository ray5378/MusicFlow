// 歌词解析(parseLrc)回归 —— 2026-09-26「全端歌词重复」根因。
//   症状:逐字歌词文件(每个字前带自己的 [mm:ss.xx],如 [00:00.63]天[00:00.89]地)被解析成
//        「每行 N 条重复文本」:一首 90 行的歌吐出 833 条歌词,Web / HA 卡片 / 客户端全部成片重复。
//   根因:旧实现对一行里的**每个**时间戳都推入「整行文本」,无法区分
//        「分组式多时间戳(真·一行多时间戳)」与「交错式逐字时间戳」。
// 歌词文件本身是正常的,修复只在解析侧。
import { describe, it, expect } from "vitest";
import { parseLrc, lrcToStructured } from "../../src/services/lyrics.js";

describe("parseLrc", () => {
  it("逐字(卡拉OK)行折叠成一条:字级时间戳不再各吐一条整句", () => {
    const out = parseLrc("[00:00.63]天[00:00.89]地[00:01.35]龙[00:01.63]鳞[00:01.75]");
    expect(out).toEqual([{ time: 0.63, text: "天地龙鳞" }]);
  });

  it("真实逐字歌词样本:条数 == 物理歌词行数,且没有重复文本", () => {
    // 240 上「天地龙鳞(改编版)」的 online-lyrics 原文前几行(真实数据)。
    const lrc = [
      "[ti:天地龙鳞 (改编版)]",
      "[ar:赵太阳、听潮阁]",
      "",
      "[00:00.63]天[00:00.89]地[00:01.35]龙[00:01.63]鳞[00:01.75] ([00:01.87]改[00:02.09]编[00:02.32]版[00:02.69]) - [00:02.92]赵[00:03.15]太[00:03.36]阳[00:03.57]/[00:03.57]听[00:03.78]潮[00:03.99]阁",
      "[00:04.21]词[00:04.46]：[00:04.46]方[00:04.69]文[00:04.96]山",
      "[00:05.15]曲[00:05.39]：[00:05.39]王[00:05.61]力[00:05.86]宏",
      "[00:14.63]这[00:14.99]龙[00:15.39]鳞[00:16.18]却[00:16.61]曾[00:16.93]经",
    ].join("\n");
    const out = parseLrc(lrc);
    // 4 个有词的行 -> 4 条(旧实现是 60 条)
    expect(out.length).toBe(4);
    expect(out[0]).toEqual({ time: 0.63, text: "天地龙鳞 (改编版) - 赵太阳/听潮阁" });
    expect(out[1]).toEqual({ time: 4.21, text: "词：方文山" });
    // 硬不变量:任何两条不得是同一份文本(这正是用户报的「重复显示多行」)
    expect(new Set(out.map((l) => l.text)).size).toBe(out.length);
  });

  it("分组式多时间戳(标准写法)仍然展开成多条", () => {
    expect(parseLrc("[00:10.00][00:20.00]副歌")).toEqual([
      { time: 10, text: "副歌" },
      { time: 20, text: "副歌" },
    ]);
  });

  it("enhanced LRC 行内 <mm:ss.xx> 逐字标签被剥掉,不把原始标签显示到端上", () => {
    expect(parseLrc("[00:10.00]<00:10.00>今<00:10.50>天")).toEqual([{ time: 10, text: "今天" }]);
  });

  it("同时间同文本只保留一条(分组式重复时间戳 / 跨行重复都不再吐两条)", () => {
    // 分组式重复: [00:10.00][00:10.00]词 —— 展开后是两条一模一样的行,必须收敛成一条
    expect(parseLrc("[00:10.00][00:10.00]词")).toEqual([{ time: 10, text: "词" }]);
    // 跨物理行重复
    expect(parseLrc("[00:20.00]词\n[00:20.00]词")).toEqual([{ time: 20, text: "词" }]);
    // 同时间不同文本(双语同轴)必须保留两条,不能被误去掉
    expect(parseLrc("[00:30.00]词\n[00:30.00]translation").length).toBe(2);
  });

  it("逐字行里的重复时间戳(如 [ts]/[ts])只出一条", () => {
    const out = parseLrc("[00:03.57]/[00:03.57]听");
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("/听");
    expect(out[0].time).toBeCloseTo(3.57, 6);
  });

  it("元数据行 / 空行跳过;2 位与 3 位小数都按千分之一秒补齐", () => {
    const out = parseLrc("[ti:x]\n[offset:-500]\n\n[00:12.5]词\n[01:02.345]句\n");
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ time: 12.5, text: "词" });
    expect(out[1].text).toBe("句");
    expect(out[1].time).toBeCloseTo(62.345, 6);
  });

  it("lrcToStructured 输出毫秒整数,且只包一份 line 数组", () => {
    const s = lrcToStructured(parseLrc("[00:10.00][00:20.00]副歌"));
    expect(s.synced).toBe(true);
    expect(s.line).toEqual([
      { start: 10000, value: "副歌" },
      { start: 20000, value: "副歌" },
    ]);
  });
});
