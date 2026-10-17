import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

// ==================== 下载 + 标签修复链路的独立覆盖率门禁（CI 阻断） ====================
//
// 与主配置 backend/vitest.config.ts 的「阈值仅提示不阻断」不同：那份配置跑**全量**、
// 存量代码未全覆盖，一刀切卡阈值会把无关模块的红算到这条链路上；本配置只跑下载 +
// 标签修复相关的测试文件，并对这两条链路的源码目录设**硬阈值**，破了就 CI 红。
//
// 为什么单独一份配置、而不是直接在主配置加 glob 阈值：
//   主配置被 sendspin-guard.yml / playback-chain-guard.yml 等**子集**作业复用，
//   那些作业不会加载 fetch / tagProvider 源码；glob 阈值会对「空集合」判 0% 而假红。
//   独立配置把测量面与判定面都收在本链路内，互不干扰。
const cfg = mergeConfig(
  base,
  defineConfig({
    test: {
      coverage: {
        // 关键：配置里写了 coverage 并不会自动开启采集，必须显式 enabled。
        // 否则 thresholds 永远不会被评估 —— 门禁形同虚设（实测：阈值调到 99 也 rc=0）。
        enabled: true,
        reporter: ["text"],
        thresholds: {
          // 下载 + 标签修复核心目录（src/services/fetch/**）：整体下限。
          // 防止整条链路在一次重构后覆盖率塌方而无人察觉。
          "src/services/fetch/**/*.ts": {
            lines: 93,
            statements: 93,
            functions: 95,
            branches: 84,
          },
          // 内置标签来源（QQ 音乐 / 网易云）：链路最前端，候选与元数据都出自这里。
          "src/services/plugin/tagProvider.ts": {
            lines: 95,
            statements: 95,
            functions: 96,
            branches: 90,
          },
        },
      },
    },
  }),
);

// mergeConfig 对数组是**拼接**语义：必须把 base.test.include（全量 tests/**/*.test.ts）
// 覆盖掉，否则本门禁会退化成「全量测试」、丧失「独立、快」的初衷。
cfg.test!.include = [
  "tests/fetch/**/*.test.ts",
  "tests/plugins/tagProvider.test.ts",
];
// 同理收敛报告范围：base 的 src/**/*.ts 测面太宽，这里只报本链路（不影响 glob 阈值判定）。
// 注意：artist-info 链路暂无独立测试文件，故不纳入本门禁（其 QQ 端点仍由 check-tag-repair.mjs
// 静态钉死），避免对「无测试覆盖的文件」设阈值导致假红。
cfg.test!.coverage!.include = [
  "src/services/fetch/**/*.ts",
  "src/services/plugin/tagProvider.ts",
];

export default cfg;
