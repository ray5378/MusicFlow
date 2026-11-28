// 阶段 5.6(a):明确「渲染器插件仅内置」。
//
// 沙箱门面按 CAP_METHODS 白名单暴露方法,而 renderer 不在白名单里 —— 这不是遗漏,
// 是有意为之:渲染器 player 是活对象 + 裸 socket 会话,QuickJS 沙箱承载不了,
// 外置渲染器的正确形态是独立立项的 sidecar(见 docs/renderer-plugin-migration-plan.md §13.3 5.6)。
// 本用例把这条「结构性仅内置」钉死,防止后人误把 renderer 加进沙箱白名单。
import "./_env.js";

import { describe, it, expect } from "vitest";
import { pluginMethodNames } from "../../src/plugins/sandbox.js";

describe("渲染器仅内置(阶段 5.6a)", () => {
  it("沙箱门面不为 renderer 能力暴露任何方法(外置渲染器结构性不可用)", () => {
    expect(pluginMethodNames({ capabilities: ["renderer"], type: "renderer" })).toEqual([]);
  });

  it("其它能力仍正常暴露(白名单未被打穿)", () => {
    expect(pluginMethodNames({ capabilities: ["search"], type: "source" })).toContain("search");
  });
});
