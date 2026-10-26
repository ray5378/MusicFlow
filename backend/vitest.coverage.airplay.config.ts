import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

// ==================== AirPlay 桥 + 群组链路 覆盖率棘轮(ratchet)门禁 ====================
//
// 与主配置 backend/vitest.config.ts 的「阈值仅提示不阻断」不同:那份配置跑**全量**、
// 存量代码未全覆盖,一刀切卡阈值会把无关模块的红算到这两条链路上;本配置只跑
// tests/airplay + tests/group,并把测量面收窄到这两个目录,阈值破了就 CI 红。
//
// 为什么是「棘轮」而不是「拍脑袋的绝对目标」:
//   阈值取**实测值下调 4 个百分点**。它的作用不是催覆盖率上涨,而是保证**不回退** ——
//   一次重构把某个文件的分支覆盖打回 0 时,这里会立刻红。往上调阈值应当是
//   「实测涨了之后顺手把闸跟上」的动作,而不是先定一个漂亮数字再倒逼补测试
//   (那样只会产生一堆不断言的凑数用例)。
//
// 为什么不 perFile:
//   bridgeSession / control 这类集成度高的文件天然覆盖率低(真实链路要设备+子进程),
//   perFile 会让它们长期假红,逼出「为了绿而 mock 掉全部真实逻辑」的反向激励。
//   整体下限 + 逐文件报告(text 里能看见每个文件)才是可持续的组合。
//
// 为什么必须显式 enabled: 配置里写 coverage 不会自动开启采集,
//   thresholds 就永远不会被评估 —— 门禁形同虚设(vitest.coverage.config.ts 的同一坑)。
// 实测(2026-10-26, tests/airplay + tests/group, 50 文件):
//   Stmts 90.26 / Branch 79.50 / Funcs 85.58 / Lines 93.06
// ⇒ 各自下调 4 个百分点(向上取整到更松的一侧)。
const cfg = mergeConfig(
  base,
  defineConfig({
    test: {
      coverage: {
        enabled: true,
        reporter: ["text"],
        thresholds: {
          lines: 89,
          statements: 86,
          functions: 81,
          branches: 75,
          perFile: false,
        },
      },
    },
  }),
);

// mergeConfig 对数组是**拼接**语义:必须覆盖 base.test.include(全量 tests/**),
// 否则本门禁会退化成「全量测试」,既慢又会被无关目录的红牵连。
cfg.test!.include = ["tests/airplay/**/*.test.ts", "tests/group/**/*.test.ts"];

// 同理收敛报告/判定范围:base 的 src/**/*.ts 测面太宽,会对本链路之外的文件判 0% 假红。
cfg.test!.coverage!.include = [
  "src/services/airplay/**/*.ts",
  "src/services/group/**/*.ts",
];
// 沿用父配置的「子进程/特权路径」排除项(本测面内只有这两个)。
// 它们要走 fork/RPC 才能执行,单测里必须 mock 掉,永远测不到 ⇒ 不能计入分母。
cfg.test!.coverage!.exclude = [
  "src/services/airplay/childMain.ts",
  "src/services/airplay/child.ts",
];

export default cfg;
