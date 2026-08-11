import { defineConfig } from "vitest/config";
import path from "path";
import os from "os";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    // 所有测试文件共用同一个 SQLite 文件(见下方 DATA_DIR),并行执行会互相改写
    // plugins / device_queues 等共享行,导致偶发失败。串行换确定性(全套 ~3s)。
    // 必须同时指定 pool:"forks":默认 threads 池下串行会把 better-sqlite3 原生模块
    // 在同一线程里反复加载,跑完在进程退出阶段段错误(exit 139);forks 每个文件独立
    // 子进程,无此问题。
    fileParallelism: false,
    pool: "forks",
    // 测试必须使用独立数据库:src/db/index.ts 按 DATA_DIR 选路径。
    // 否则 persist/loadFromDb 等操作会写进开发/生产库(data/musicflow.db),
    // 污染真实队列与群组数据。
    env: {
      DATA_DIR: path.join(os.tmpdir(), "musicflow-test-data"),
    },
  },
});
