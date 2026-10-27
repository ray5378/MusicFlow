// 群组 A/V 延迟补偿的读写与缓存(按 groupId)。
//
// 语义(三侧一致):**正数 = 该侧更晚出声,负数 = 该侧更早出声**。单位 ms,范围 ±30000(常量见下)。
// 只有「两两差值」影响听感是否对齐;分开存是因为三条路的抵达延迟不是同一个物理量:
// 同一个「延迟」概念在 AirPlay 1(44.1k 重采样 + 明文 RTSP)与 AirPlay 2(48k 直通 + 加密链路)
// 上数值不同,共用一格等于强迫用户在两种设备之间来回凑,谁都调不准。
//
// 三个消费点:
//   airplay  → airplayDelayUsOf(groupId)  → bridgePrepare 的 anchorShiftUs(**仅 AP1 成员**)
//              (锚点整体平移;锚点在桥会话建立时算死 ⇒ 改完要重建该组桥才生效)
//   airplay2 → airplay2DelayUsOf(groupId) → 同一个 anchorShiftUs(**仅 AP2 realtime 成员**)
//              取值在 control.ts::bridgePrepareDevice 里按成员协议二选一 —— 不是组级开关,
//              混合组里 AP1 成员与 AP2 成员各读各的格子。
//   sendspin → sendspinDelayUsOfGroupName("ug:<gid>") → pushFrame 下发戳偏移
//              (帧级,**真·实时**,约 0.5~1s 后听到,取决于设备 send_ahead 缓冲)
//
// 缓存策略:懒加载 + 写时更新(无 TTL)。延迟值只经 setGroupDelays 变更,
// 因此不需要失效轮询;组删除由 invalidateGroupDelays 清缓存。
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { playerGroups } from "../../db/schema.js";

/** 补偿范围(ms)。超出即钳制。用户定稿 ±30s:大偏移主要用于「排查/示波」而非日常听感,
 *  三侧的物理后果不对称(见文件头注释),前端文案已提示。 */
export const GROUP_DELAY_MIN_MS = -30000;
export const GROUP_DELAY_MAX_MS = 30000;
/** 前端步进(ms)。 */
export const GROUP_DELAY_STEP_MS = 10;

export interface GroupDelays {
  /** 正数 = AirPlay 1(RAOP)成员更晚出声,负数 = 更早。 */
  airplayMs: number;
  /** 正数 = AirPlay 2(realtime)成员更晚出声,负数 = 更早。
   *  与 airplayMs 是**两个独立格子**:成员走哪条协议就只读哪一格(见 airplay2DelayUsOf)。 */
  airplay2Ms: number;
  /** 正数 = Sendspin 更晚出声,负数 = 更早。 */
  sendspinMs: number;
}

const cache = new Map<string, GroupDelays>();

/** 全新的「全 0」补偿值。**必须每次新建对象**:调用方拿到的就是它,若复用同一个模块级
 *  常量(或把它塞进 cache),任一调用方改写返回值就会污染「全局默认 + 所有无行组」的读值
 *  —— 表现为别处莫名多出补偿,且刷新页面也复现不一致。 */
function zeroDelays(): GroupDelays {
  return { airplayMs: 0, airplay2Ms: 0, sendspinMs: 0 };
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
  if (hit) return { airplayMs: hit.airplayMs, airplay2Ms: hit.airplay2Ms, sendspinMs: hit.sendspinMs };
  let v: GroupDelays = zeroDelays();
  try {
    const row = db
      .select({
        a: playerGroups.airplayDelayMs,
        a2: playerGroups.airplay2DelayMs,
        s: playerGroups.sendspinDelayMs,
      })
      .from(playerGroups)
      .where(eq(playerGroups.id, groupId))
      .get();
    if (row) {
      v = {
        airplayMs: clampGroupDelayMs(row.a),
        airplay2Ms: clampGroupDelayMs(row.a2),
        sendspinMs: clampGroupDelayMs(row.s),
      };
    }
  } catch { /* 库不可用 → 0 */ }
  cache.set(groupId, v);
  return { airplayMs: v.airplayMs, airplay2Ms: v.airplay2Ms, sendspinMs: v.sendspinMs };
}

/** 写某组的补偿(缺省字段保持原值):**内存先更新(立即生效),再落库**。
 *  @returns 实际生效值(已钳制)。 */
export function setGroupDelays(
  groupId: string,
  patch: { airplayMs?: unknown; airplay2Ms?: unknown; sendspinMs?: unknown },
): GroupDelays {
  const cur = getGroupDelays(groupId);
  const next: GroupDelays = {
    airplayMs: patch.airplayMs === undefined ? cur.airplayMs : clampGroupDelayMs(patch.airplayMs),
    airplay2Ms: patch.airplay2Ms === undefined ? cur.airplay2Ms : clampGroupDelayMs(patch.airplay2Ms),
    sendspinMs: patch.sendspinMs === undefined ? cur.sendspinMs : clampGroupDelayMs(patch.sendspinMs),
  };
  cache.set(groupId, next);
  try {
    db.update(playerGroups)
      .set({
        airplayDelayMs: next.airplayMs,
        airplay2DelayMs: next.airplay2Ms,
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

/** AirPlay 1(RAOP)侧补偿(µs,给 planBridgeAnchor.anchorShiftUs)。
 *  正数 = 桥内容落点整体后移 = 该 AP1 成员更晚出声。 */
export function airplayDelayUsOf(groupId: string | null | undefined): number {
  return getGroupDelays(groupId).airplayMs * 1000;
}

/** AirPlay 2(realtime)侧补偿(µs,落点与 AP1 完全相同的 anchorShiftUs)。
 *  **这是第三格的取入口**:只给 member 协议确为 AP2 的成员用,AP1 成员绝不读它。
 *  迁移时该列从 airplay_delay_ms 继承(见 db/index.ts),因此老组升级后 AP2 成员
 *  不会凭空丢掉既有标定 —— 继承值与 AP2 实际链路有偏差属于预期,用户在 UI 里各调一格即可。 */
export function airplay2DelayUsOf(groupId: string | null | undefined): number {
  return getGroupDelays(groupId).airplay2Ms * 1000;
}

/** 桥投递窗口用的锚点位移(µs):按**该桥协议**读对应格子(raop → airplay 格,
 *  ap2-* → airplay2 格)。组名非 ug: ⇒ 0n(历史行为)。
 *  正数 = 桥侧更晚出声(与 planBridgeAnchor.anchorShiftUs 同向)。
 *  投递窗口必须含它:桥侧可听时刻 = 组时间线 + shift;窗口不跟随 ⇒ shift 会被
 *  桥内对齐器当「帧提前到达」drop/skip 出清(2026-10-27 真机实锤),补偿整体失效。 */
export function bridgeAnchorShiftUsOf(groupName: string, protocol: string): bigint {
  const id = parseUserGroupId(groupName);
  if (!id) return 0n;
  const d = getGroupDelays(id);
  return BigInt((protocol.startsWith("ap2-") ? d.airplay2Ms : d.airplayMs) * 1000);
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
