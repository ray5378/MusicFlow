// 群组 A/V 延迟补偿的读写与缓存(按 groupId)。
//
// 语义(两侧一致):**正数 = 该侧更晚出声,负数 = 该侧更早出声**。单位 ms,范围 ±30000(常量见下 :20-21)。
// 只有「两侧差值」影响 A/V 同步;分开存是为了纯 AirPlay 组 / 纯 Sendspin 组也能各自微调。
//
// 两个消费点:
//   airplay  → airplayDelayUsOf(groupId)  → bridgePrepare 的 anchorShiftUs
//              (锚点整体平移;锚点在桥会话建立时算死 ⇒ 改完要重建该组桥才生效)
//   sendspin → sendspinDelayUsOfGroupName("ug:<gid>") → pushFrame 下发戳偏移
//              (帧级,**真·实时**,约 0.5~1s 后听到,取决于设备 send_ahead 缓冲)
//
// 缓存策略:懒加载 + 写时更新(无 TTL)。延迟值只经 setGroupDelays 变更,
// 因此不需要失效轮询;组删除由 invalidateGroupDelays 清缓存。
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { playerGroups } from "../../db/schema.js";

/** 补偿范围(ms)。超出即钳制。用户定稿 ±30s:大偏移主要用于「排查/示波」而非日常听感,
 *  两侧的物理后果不对称(见文件头注释),前端文案已提示。 */
export const GROUP_DELAY_MIN_MS = -30000;
export const GROUP_DELAY_MAX_MS = 30000;
/** 前端步进(ms)。 */
export const GROUP_DELAY_STEP_MS = 10;

export interface GroupDelays {
  /** 正数 = AirPlay 更晚出声,负数 = 更早。 */
  airplayMs: number;
  /** 正数 = Sendspin 更晚出声,负数 = 更早。 */
  sendspinMs: number;
}

const cache = new Map<string, GroupDelays>();

/** 全新的「全 0」补偿值。**必须每次新建对象**:调用方拿到的就是它,若复用同一个模块级
 *  常量(或把它塞进 cache),任一调用方改写返回值就会污染「全局默认 + 所有无行组」的读值
 *  —— 表现为别处莫名多出补偿,且刷新页面也复现不一致。 */
function zeroDelays(): GroupDelays {
  return { airplayMs: 0, sendspinMs: 0 };
}

/** 钳制到 ±30000ms 的整数;非数字 → 0。 */
export function clampGroupDelayMs(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(GROUP_DELAY_MAX_MS, Math.max(GROUP_DELAY_MIN_MS, Math.round(n)));
}

/** 读某组的补偿(懒加载 + 缓存)。groupId 缺失 → 0。库异常 → 0(绝不阻断播放)。
 *  返回值是**新建对象**(缓存命中也另建一份),调用方改写它不会污染缓存或其他组。 */
export function getGroupDelays(groupId: string | null | undefined): GroupDelays {
  if (!groupId) return zeroDelays();
  const hit = cache.get(groupId);
  if (hit) return { airplayMs: hit.airplayMs, sendspinMs: hit.sendspinMs };
  let v: GroupDelays = zeroDelays();
  try {
    const row = db
      .select({ a: playerGroups.airplayDelayMs, s: playerGroups.sendspinDelayMs })
      .from(playerGroups)
      .where(eq(playerGroups.id, groupId))
      .get();
    if (row) v = { airplayMs: clampGroupDelayMs(row.a), sendspinMs: clampGroupDelayMs(row.s) };
  } catch { /* 库不可用 → 0 */ }
  cache.set(groupId, v);
  return { airplayMs: v.airplayMs, sendspinMs: v.sendspinMs };
}

/** 写某组的补偿(缺省字段保持原值):**内存先更新(立即生效),再落库**。
 *  @returns 实际生效值(已钳制)。 */
export function setGroupDelays(
  groupId: string,
  patch: { airplayMs?: unknown; sendspinMs?: unknown },
): GroupDelays {
  const cur = getGroupDelays(groupId);
  const next: GroupDelays = {
    airplayMs: patch.airplayMs === undefined ? cur.airplayMs : clampGroupDelayMs(patch.airplayMs),
    sendspinMs: patch.sendspinMs === undefined ? cur.sendspinMs : clampGroupDelayMs(patch.sendspinMs),
  };
  cache.set(groupId, next);
  try {
    db.update(playerGroups)
      .set({
        airplayDelayMs: next.airplayMs,
        sendspinDelayMs: next.sendspinMs,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(playerGroups.id, groupId))
      .run();
  } catch { /* 落库失败不回滚内存:播放正确性优先,下次启动回到旧值 */ }
  return next;
}

/** 组删除/重建时清缓存,避免同名 id 复用读到陈旧值。 */
export function invalidateGroupDelays(groupId: string): void {
  cache.delete(groupId);
}

/** AirPlay 侧补偿(µs,给 planBridgeAnchor.anchorShiftUs)。
 *  正数 = 桥内容落点整体后移 = AirPlay 更晚出声。 */
export function airplayDelayUsOf(groupId: string | null | undefined): number {
  return getGroupDelays(groupId).airplayMs * 1000;
}

/** 从 sendspin 组名取用户组 id:`ug:<gid>` → gid;设备组(裸 clientId)→ null。 */
export function parseUserGroupId(groupName: string): string | null {
  if (typeof groupName !== "string" || !groupName.startsWith("ug:")) return null;
  const id = groupName.slice("ug:".length);
  return id || null;
}

/** Sendspin 侧补偿(µs,bigint 给 pushAudio/sendAudio 的戳偏移)。
 *  正数 = 下发戳后移 = 该组 Sendspin 成员更晚出声。 */
export function sendspinDelayUsOfGroupName(groupName: string): bigint {
  const id = parseUserGroupId(groupName);
  if (!id) return 0n;
  return BigInt(getGroupDelays(id).sendspinMs * 1000);
}
