// ==================== core-song-group 插件的 host 侧包装 ====================
// 只补既有 utils/songGroup 测试未覆盖的「插件层」分支:
//   groupKeyFor / findGroupForSongWithConfig / assignAllGroups —— 这三个函数
//   在 host.config 缺失或字段非法时的回落行为(端侧零改动全靠它们)。
// MUST be the first import: re-exports the isolated DATA_DIR env for this file.
import "../../plugins/_env.js";

import { describe, it, expect } from "vitest";
import {
  groupKeyFor,
  findGroupForSongWithConfig,
  assignAllGroups,
  songGroupPlugin,
} from "../../../src/services/plugin/core/songGroup.js";

/** host.config 缺省/为 undefined 是真实可能态(未启用/无配置行),必须不抛。 */
const host = (config: any) => ({ config } as any);

describe("core-song-group:groupKeyFor(host.config 分支)", () => {
  it("缺省(无 albumRequired)按「要求专辑一致」——不同专辑 → 不同 key", () => {
    // 为什么:默认规则要求专辑参与分组(版本区分靠专辑);只有显式 false 才退化。
    expect(groupKeyFor(host({}), "T", "A", "Al1")).not.toBe(groupKeyFor(host({}), "T", "A", "Al2"));
  });

  it("config 为 undefined 时不抛，等价于空配置", () => {
    // 为什么:host.config 未初始化时 `host.config || {}` 必须兜底,否则整条序列化链崩。
    expect(groupKeyFor(host(undefined), "T", "A", "Al")).toBe(groupKeyFor(host({}), "T", "A", "Al"));
  });

  it("albumRequired=false → 专辑维度被忽略(不同专辑同 key)", () => {
    // 为什么:关掉「专辑一致」是文档承诺的可配置行为,必须真的合并。
    expect(groupKeyFor(host({ albumRequired: false }), "T", "A", "Al1"))
      .toBe(groupKeyFor(host({ albumRequired: false }), "T", "A", "Al2"));
  });
});

describe("core-song-group:findGroupForSongWithConfig(容差按 host.config)", () => {
  const candidates = [{ id: "s1", groupId: "g1", duration: 200 }];

  it("容差内命中已有组；容差外不命中", () => {
    // 为什么:导入归组是否命中直接决定本地/平台副本会不会被并成一组。
    expect(findGroupForSongWithConfig(host({ durationTolerance: 2 }), candidates, 201)).toBe("g1");
    expect(findGroupForSongWithConfig(host({ durationTolerance: 2 }), candidates, 205)).toBeNull();
  });

  it("容差非法(0 / 负数 / 非数字)回落默认 1 秒", () => {
    // 为什么:`Number(cfg.durationTolerance) > 0` 的三元是防误合并的边界,不能悄悄退化成 0。
    expect(findGroupForSongWithConfig(host({ durationTolerance: 0 }), candidates, 202)).toBeNull();
    expect(findGroupForSongWithConfig(host({ durationTolerance: -3 }), candidates, 202)).toBeNull();
    expect(findGroupForSongWithConfig(host({ durationTolerance: "x" }), candidates, 201)).toBe("g1");
  });

  it("config 缺失时用默认容差(1s)", () => {
    expect(findGroupForSongWithConfig(host(undefined), candidates, 201)).toBe("g1");
    expect(findGroupForSongWithConfig(host(undefined), candidates, 202)).toBeNull();
  });
});

describe("core-song-group:assignAllGroups(存量/批量重算)", () => {
  it("按 key 分桶 + 时长容差 unions,返回 id→{groupId,groupKey}", () => {
    // 为什么:存量重算一旦错分,整库分组都会错,且不会自愈(需再触发重算)。
    const rows = [
      { id: "a", title: "Song", artist: "X", album: "Al", duration: 200 },
      { id: "b", title: "Song", artist: "X", album: "Al", duration: 200.5 },
      { id: "c", title: "Song", artist: "X", album: "Al", duration: 260 },
    ];
    const m = assignAllGroups(host({}), rows);
    expect(m.get("a")!.groupId).toBe(m.get("b")!.groupId); // 同专辑 + 时长相近 → 同组
    expect(m.get("c")!.groupId).not.toBe(m.get("a")!.groupId); // 差 60s → 不同组
    expect(m.get("a")!.groupKey).toBe(m.get("b")!.groupKey);
  });

  it("albumRequired=false 时专辑不参与分桶(同专辑差异不拆组)", () => {
    const m = assignAllGroups(host({ albumRequired: false }), [
      { id: "d", title: "T", artist: "A", album: "Al1", duration: 100 },
      { id: "e", title: "T", artist: "A", album: "Al2", duration: 100 },
    ]);
    expect(m.get("d")!.groupId).toBe(m.get("e")!.groupId);
  });

  it("config 缺失时默认要求专辑一致", () => {
    const m = assignAllGroups(host(undefined), [
      { id: "f", title: "T", artist: "A", album: "Al1", duration: 100 },
      { id: "g", title: "T", artist: "A", album: "Al2", duration: 100 },
    ]);
    expect(m.get("f")!.groupId).not.toBe(m.get("g")!.groupId);
  });
});

describe("core-song-group:songGroupPlugin 门面", () => {
  it("四个函数被转发到对应实现(转发错位会静默改行为)", () => {
    expect(songGroupPlugin.groupKey).toBe(groupKeyFor);
    expect(songGroupPlugin.findGroup).toBe(findGroupForSongWithConfig);
    expect(songGroupPlugin.assignAll).toBe(assignAllGroups);
    expect(typeof songGroupPlugin.normalize).toBe("function");
  });
});
