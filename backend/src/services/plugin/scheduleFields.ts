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

import type { ConfigField, PluginManifest } from "../../plugins/types.js";

/** 分组标识,前端会把这两项圈进「定时同步」模块框。 */
export const SCHEDULE_GROUP = "schedule";

/** 参与「每日定时同步 / 容器启动补拉」门控的插件能力(见 batch/jobs.ts 的
 *  runSyncPipeline 与 maintenanceHandler)。
 *
 *  只要插件声明了下列任一能力,宿主的注册表注入器(registry.ts 的 registerPlugin)
 *  就会把 SCHEDULE_FIELDS 两个开关自动挂进它的 configSchema——内置与外置沙箱插件
 *  统一走这一条路,**不再逐个插件手写**,保证「所有歌单配置页面都接入该能力」不会
 *  漏插件。
 *
 *  覆盖范围与调度器实际遍历的能力一一对应:
 *    - 推荐器:每日推荐 / 本地推荐 / 通用推荐歌单 / 本地随机(按平台)/ 组合歌单 / 歌单清理;
 *    - 在线源:每日推荐同步(recommend)与网页歌轮换(webRotation);
 *    - 歌单再同步:playlistSync(维护管线);
 *    - 歌单导入:playlistImport / playlistFile(按需的 URL / 文件导入,纳入后配置页与
 *      其它歌单插件保持一致地出现定时开关)。 */
export const SCHEDULED_CAPS: string[] = [
  "dailyPlaylist",
  "localPlaylist",
  "recommendPlaylist",
  "localPlatformRecommend",
  "comboPlaylist",
  "playlistCleanup",
  "recommend",
  "webRotation",
  "playlistSync",
  "playlistImport",
  "playlistFile",
  // 歌手资料抓取(新歌手封面刮削):纳入后配置页同样出现定时开关,
  // 与其它歌单/抓取插件保持一致(主持人可按 scheduleEnabled 门控其后台抓取)。
  "artistInfo",
];

/** 按 manifest.schedules 声明,决定注入哪些 SCHEDULE_FIELDS。
 *  返回要注入的字段子集;空数组 = 不注入。 */
function resolveDesiredFields(manifest: PluginManifest): ConfigField[] {
  const s = manifest.schedules;
  // 缺省 → 按能力自动推断
  if (s === undefined) {
    return manifest.capabilities.some((c) => SCHEDULED_CAPS.includes(c))
      ? SCHEDULE_FIELDS
      : [];
  }
  // true → 全部注入
  if (s === true) return SCHEDULE_FIELDS;
  // false → 不注入
  if (s === false) return [];
  // 对象 → 逐项判断
  const fields: ConfigField[] = [];
  for (const f of SCHEDULE_FIELDS) {
    if ((s as any)[f.key] === true) fields.push(f);
  }
  return fields;
}

/** 幂等地把 schedule 字段注入到 manifest.configSchema(仅注入缺失的键)。
 *  由 registerPlugin 统一调用,内置与外置插件都经过它,返回同一 manifest 引用。 */
export function withScheduleFields(manifest: PluginManifest): PluginManifest {
  if (!manifest || !Array.isArray(manifest.configSchema) || !Array.isArray(manifest.capabilities)) {
    return manifest;
  }
  const desired = resolveDesiredFields(manifest);
  if (desired.length === 0) return manifest;
  const keys = new Set(manifest.configSchema.map((f) => f.key));
  for (const f of desired) {
    if (!keys.has(f.key)) manifest.configSchema.push(f);
  }
  return manifest;
}

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

// ==================== 并行执行开关(批量任务并发) ====================
//
// 与定时开关同源:开关注入按「参与歌单批量任务的能力清单」判断(见下方 SCHEDULED_CAPS,
// 或声明了 longRunning)。这样内置与外置**所有歌单/批量类插件**配置页都出现该开关,
// 不会像只判 longRunning 那样漏掉内置(内置批量插件不声明 longRunning)。
//
// 语义:宿主把所有批量任务收进全局队列,默认 batchLimit=1 串行(FIFO)执行;
// 用户在某插件上打开「允许并行执行」,该插件才被计入并发上限,可与其它的同行
// 并行执行(批量任务跑在独立子进程/worker,利用多核,更快但 CPU 占用更高)。
// 是否声明 longRunning 只影响它有没有独立 worker 线程(线程隔离),不影响本开关
// 是否出现;本开关决定的是该插件是否贡献**全局并发上限**(见 batchPacer.ts)。

/** 分组标识,前端会把这项圈进「批量执行」模块框。 */
export const BATCH_GROUP = "batch";

/** 插件配置页上的「允许并行执行」开关,默认关闭。 */
export const BATCH_PARALLEL_FIELD: ConfigField = {
  key: "batchParallel",
  label: "允许并行执行",
  type: "switch",
  group: BATCH_GROUP,
  default: false,
  help: "关闭(默认):本插件的定时/批量任务始终参与全局队列串行执行;开启:允许与其它开启此开关的插件并行执行(利用多核,更快但 CPU 占用更高)。",
};

/** 判断插件是否参与批量任务队列(会进全局闸、受并发上限约束):
 *  声明了任一 SCHEDULED_CAPS 批量能力,或声明了 longRunning 长耗时批量方法。 */
export function isBatchCapable(manifest: PluginManifest | undefined): boolean {
  if (!manifest) return false;
  if (Array.isArray(manifest.capabilities) && manifest.capabilities.some((c) => SCHEDULED_CAPS.includes(c))) {
    return true;
  }
  return !!manifest.longRunning && Object.keys(manifest.longRunning).length > 0;
}

/** 幂等地把并行开关注入到 manifest.configSchema(仅对参与批量任务的插件,
 *  且仅注入缺失的 key)。由 registerPlugin 统一调用,内置与外置插件都经过它。 */
export function withBatchParallelField(manifest: PluginManifest): PluginManifest {
  if (!manifest || !Array.isArray(manifest.configSchema)) return manifest;
  if (!isBatchCapable(manifest)) return manifest;
  const has = manifest.configSchema.some((f) => f.key === BATCH_PARALLEL_FIELD.key);
  if (!has) manifest.configSchema.push(BATCH_PARALLEL_FIELD);
  return manifest;
}
