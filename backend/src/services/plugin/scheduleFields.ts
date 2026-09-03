// ==================== 歌单同步插件共用的「调度开关」配置字段 ====================
//
// 所有会自动同步/生成歌单的插件(内置与外置)都在 configSchema 里挂这两个开关,
// 宿主在跑每日定点任务与启动补拉时按配置逐个门控(见 batch/jobs.ts 的
// runSyncPipeline)——「到点全跑一遍」从此变成「谁开了才跑谁」。
//
// 默认值语义(宿主与 UI 必须一致):
//   - scheduleEnabled 默认 true :没动过就保持原有行为,升级不停更;
//   - runOnBoot       默认 false:启动补拉是新增行为,默认不打扰。
// 存量安装的插件 config 里没有这两个键,宿主按缺失即默认处理(见 jobs.ts 注释)。

import type { ConfigField } from "../../plugins/types.js";

/** 分组标识,前端会把这两项圈进「定时同步」模块框。 */
export const SCHEDULE_GROUP = "schedule";

export const SCHEDULE_FIELDS: ConfigField[] = [
  {
    key: "scheduleEnabled",
    label: "参与每日定时同步",
    type: "switch",
    group: SCHEDULE_GROUP,
    default: true,
    help: "关闭后,每天定点那次自动同步会跳过本插件(手动刷新按钮仍然可用)。",
  },
  {
    key: "runOnBoot",
    label: "容器启动时拉取一次",
    type: "switch",
    group: SCHEDULE_GROUP,
    default: false,
    help: "打开后,MusicFlow 每次启动/重启会补拉一次本插件的歌单(适合榜单类插件保持最新)。",
  },
];
