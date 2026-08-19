// ==================== batch jobs 处理器注册契约测试 ====================
// 校验:types.ts 定义的每个 BatchJobKind 都有处理器注册、且处理器集合不包含多余键。
// 不实际执行处理器(会真实碰库/网络)。

import { describe, it, expect } from "vitest";
import { batchJobHandlers } from "../../src/batch/jobs.js";
import { jobKinds } from "../../src/batch/types.js";

describe("batch job handlers 契约", () => {
  it("每个 BatchJobKind 都有对应处理器", () => {
    for (const kind of jobKinds) {
      expect(typeof batchJobHandlers[kind], `kind=${kind} 应有处理器`).toBe("function");
    }
  });

  it("处理器集合不包含未在 jobKinds 中定义的键", () => {
    for (const k of Object.keys(batchJobHandlers)) {
      expect((jobKinds as readonly string[]).includes(k), `key=${k} 应在 jobKinds 中`).toBe(true);
    }
  });
});