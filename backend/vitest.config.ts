import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/services/sendspin/**/*.test.ts"],
    environment: "node",
    globals: false,
    // 覆盖率报告: npm run test:coverage。阈值仅提示不阻断(存量代码未全覆盖)。
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/db/*.ts", "src/plugins/sandbox.ts", "src/routes/rest/index.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
    // 每个测试文件通过 tests/setup.ts 分配独立的 DATA_DIR(独立 SQLite 库),
    // 文件之间不再共享任何数据,故可安全并行提速。此前共享一个库必须串行,
    // 并行会互相改写 plugins / device_queues 等共享行导致偶发失败;且共享库的
    // 残留数据会让测试依赖"运气"(运行顺序/历史运行次数),CI 全新环境才暴露。
    // pool 必须是 "forks":默认 threads 池下反复加载 better-sqlite3 原生模块,
    // 跑完在进程退出阶段段错误(exit 139);forks 每个文件独立子进程,无此问题。
    fileParallelism: false,
    pool: "forks",
    // singleFork: 单个 fork 进程串行跑完全部测试文件。多 worker 并行时,forks 池在
    // 文件派发阶段会偶发死锁(多个各自加载 better-sqlite3 的原生 worker 已完成一批文件,
    // 调度器却不再派发新文件,worker 空转零输出直至 timeout)。该现象与并发 worker 数无关
    // (3→2 均复现),与具体文件无关(单文件本地均通过),只能靠单进程串行从根上规避。
    // 配套: setup.ts 的每文件独立 DATA_DIR 改用纯 uuid 区分(pid 在单进程下会恒定)。
    poolOptions: {
      forks: { singleFork: true },
    },
    setupFiles: ["tests/setup.ts"],
    // 打乱测试(文件内)顺序,让任何隐藏的顺序/共享状态依赖显式暴露,而不是被
    // 固定顺序掩盖后偶发放炮。
    sequence: {
      shuffle: true,
    },
  },
});
