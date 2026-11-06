// ==================== 启动后一次性提醒(boot notices) ====================
//
// 数据源 = plugin_notices 表(插件经 host.notify 写入,权限 notify)。
// 核心在每次进程启动后按「提醒 id 只下发一次」:首次 Web 会话拿到当前全部提醒,
// 之后新建的提醒会在下一次页面加载时各下发一次 —— 同一提醒每次重启只弹一次,
// 不会重复打扰;插件在问题修复后调用 host.notify.clear 删除提醒。

import { listPluginNotices, type PluginNotice } from "../../plugins/notices.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("BOOT-NOTICE");

export interface BootNotice {
  id: string;
  pluginId: string;
  key: string;
  level: "info" | "warning" | "error";
  title: string;
  message: string;
  at: string;
}

/** 本次进程已下发过的提醒 id(内存态,重启后自动复位)。 */
const delivered = new Set<string>();

function toBootNotice(n: PluginNotice): BootNotice {
  return {
    id: `${n.pluginId}:${n.key}`,
    pluginId: n.pluginId,
    key: n.key,
    level: n.level,
    title: n.title,
    message: n.message,
    at: n.at,
  };
}

/**
 * 取走本次启动尚未下发过的提醒。读取失败不影响页面启动,按「无提醒」处理。
 */
export function takeBootNotices(): BootNotice[] {
  let notices: PluginNotice[];
  try {
    notices = listPluginNotices();
  } catch (e: any) {
    log.warn(`读取插件启动提醒失败: ${e?.message || e}`);
    return [];
  }
  const out: BootNotice[] = [];
  for (const n of notices) {
    const id = `${n.pluginId}:${n.key}`;
    if (delivered.has(id)) continue;
    delivered.add(id);
    out.push(toBootNotice(n));
  }
  return out;
}

/** 测试辅助:复位下发状态。 */
export function resetBootNoticesDelivered(): void {
  delivered.clear();
}
