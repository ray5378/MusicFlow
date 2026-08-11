import { defineConfig } from "vitest/config";
import path from "path";
import os from "os";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    // 测试必须使用独立数据库:src/db/index.ts 按 DATA_DIR 选路径。
    // 否则 persist/loadFromDb 等操作会写进开发/生产库(data/musicflow.db),
    // 污染真实队列与群组数据。
    env: {
      DATA_DIR: path.join(os.tmpdir(), "musicflow-test-data"),
    },
  },
});
