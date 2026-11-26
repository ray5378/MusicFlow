import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/services/sendspin/**/*.test.ts"],
    environment: "node",
    globals: false,
    // 【2026-10-18 CI 稳定】全量门禁跑在 CI 上会与同 run 的镜像构建争抢算力,
    // tagProvider 的 QQ 请求限流用例(真实等待 1.2s + 300~800ms 抖动)在负载下会超出
    // vitest 默认 5000ms 单测超时被误判失败(同一 commit 的 ci 作业同命令全绿、build
    // 作业全红即为佐证,见 v4.6.31 的 build-and-push 失败)。此处仅抬高上限,不改变
    // 任何用例的执行语义(该等待是用例刻意为之,不能靠缩短等待绕过)。
    testTimeout: 20000,
    // 【CI 稳定性】Sendspin Guard 作业(见 .github/workflows/sendspin-guard.yml)置位
    // MUSICFLOW_GUARD_NO_CONSOLE_INTERCEPT=1 时关闭 console 截获。原因:sendspin 测试文件
    // 在 afterAll 停服务后仍有异步收尾**迟到**输出 —— 推流主循环(GroupPump.pushLoop 是
    // fire-and-forget,要等下一个 await 边界才退出)、ws 关闭回调触发的 group 收尾、FLAC
    // 编码退避(encoding.ts 的 console.warn)等自有通道,以及 bonjour-service 的名称冲突
    // 探测(registry.js:32)这条**第三方**通道。Vitest 5 的 onUserConsoleLog 是
    // worker→主进程 RPC,worker teardown 时若仍有 pending 就抛 EnvironmentTeardownError
    // 并被记为 1 个 unhandled error —— 于是「98/98 全过」也 exit 1。迟到输出横跨自有代码
    // 与第三方,无法逐一静音;关掉截获后日志直接走进程 stdout(仍完整落在 CI 日志与失败
    // artifact 里),不经 RPC,竞态从结构上消除。仅本作业置位,其它作业保持原行为。
    disableConsoleIntercept: process.env.MUSICFLOW_GUARD_NO_CONSOLE_INTERCEPT === "1",
    // 覆盖率报告: npm run test:coverage。阈值仅提示不阻断(存量代码未全覆盖)。
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
      "src/index.ts",
      "src/db/*.ts",
      "src/plugins/sandbox.ts",
      "src/routes/rest/index.ts",
      "src/batch/child.ts",
      "src/services/airplay/childMain.ts",
      "src/services/airplay/child.ts",
      "src/services/sendspin/child.ts",
      "src/plugins/sandboxWorker.ts",
      "src/plugins/hotReload.ts",
      "src/services/rendererHost/childBootstrap.ts",
    ],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
    // 每个测试文件通过 tests/setup.ts 分配独立的 DATA_DIR(独立 SQLite 库),
    // 文件之间不再共享任何数据,故可安全并行提速。此前共享一个库必须串行,
    // 并行会互相改写 plugins / device_queues 等共享行导致偶发失败;且共享库的
    // 残留数据会让测试依赖"运气"(运行顺序/历史运行次数),CI 全新环境才暴露。
    // pool 必须是 "forks":默认 threads 池下反复加载 better-sqlite3 原生模块,
    // 跑完在进程退出阶段段错误(exit 139);forks 每个文件独立子进程,无此问题。
    fileParallelism: true,
    pool: "forks",
    // 8 worker 并行(2026-11-27 GitHub CI 同口径实验): forks 池「每个测试文件跑在独立 fork
    // 子进程」的进程级隔离保持不变(避免 singleFork 下 sendspin 服务单例 / ffmpeg / 沙箱
    // 等模块级全局跨文件残留),只是派发到 8 个子进程。历史实测(230 nproc=8,同一份 674
    // 文件全集,均 674/674 PASS 无死锁):1→1151s / 2→602s / 4→332s;
    // GitHub ubuntu-latest 上 maxWorkers=4 的 ci/build test job 分别 339s / 365s。
    // 本档 8 worker 直接在 CI 上测墙钟,若更慢或 OOM 则退回 4 并在此记录实测数据。
    // 旧结论「多 worker 派发死锁」是早期 Vitest 遗留,当前 5.0.3 已证实稳定。
    maxWorkers: 8,
    minWorkers: 1,
    poolOptions: {
      forks: { singleFork: false },
    },
    setupFiles: ["tests/setup.ts"],
    // 打乱测试(文件内)顺序,让任何隐藏的顺序/共享状态依赖显式暴露,而不是被
    // 固定顺序掩盖后偶发放炮。
    sequence: {
      shuffle: true,
    },
  },
});
