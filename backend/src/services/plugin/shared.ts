// ==================== 推荐插件共享工具 ====================
//
// 内置推荐插件(daily-recommend / local-recommend / daily-roam)与插件宿主层
// (discovery)反复使用的同构工具,收敛于此,避免多份逐字相同的实现漂移。

import { sqlite } from "../../db/index.js";

/** 当天日期字符串(YYYY-MM-DD),用于歌单当天幂等标记。 */
export function todayStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 系统归属用户 id(首个 admin):插件歌单 / 系统任务写入的 owner。 */
export function systemOwnerId(): string {
  const admin = sqlite.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as any;
  return admin?.id || "";
}
