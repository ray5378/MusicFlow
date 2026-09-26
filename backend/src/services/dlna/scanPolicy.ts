/**
 * DLNA 发现节奏策略 —— **单一真源**。
 *
 * 为什么单独抽一个文件: 这两个数值是「设备上线后要多久出现在播放器列表」的**决定性参数**,
 * 且分布在不同层 ——
 *   · `DLNA_SCAN_INTERVAL_MS` 被入口的常驻定时器消费(`backend/src/index.ts`);
 *   · `DISCOVERY_CACHE_TTL_MS` 被「客户端拉 `/v1/peers` 时要不要后台补扫」消费
 *     (`backend/src/routes/api/index.ts` -> `shouldRefreshDevices()`)。
 * 若各自写死字面量, 改一处漏一处就会悄悄退化。抽出来后两边都引用同一常量,
 * 且没有副作用(可被单测直接 import 而不触发 SSDP 绑定)。
 *
 * 数值依据(2026-09-26 v4.0.32, 用户报「主卧已经放很久了却不显示」):
 *   旧周期扫描是 **5 分钟**, 而且设备刚上电时 SSDP 栈往往**先于**内嵌 HTTP 就绪 ——
 *   此刻抓 description 必然失败, 旧实现单次失败即放弃并白白用掉 60s 去抖窗口,
 *   于是「这次上线」被彻底错过, 只能等下一轮 5 分钟扫描(实测 230 模拟器: 恢复后还要 85s)。
 *   收紧到 90s 后, 即使设备完全不发通告, 最坏等待也从 5 分钟降到 90 秒级。
 */

/** 主动发现(周期扫描)间隔:家宽 LAN 上一轮 M-SEARCH + 每设备一次 description 抓取的代价可忽略。 */
export const DLNA_SCAN_INTERVAL_MS = 90 * 1000;

/** 发现时间戳的缓存 TTL:距上次成功发现超过它, 就允许「拉列表」顺带后台补扫一轮。 */
export const DISCOVERY_CACHE_TTL_MS = 60 * 1000;
