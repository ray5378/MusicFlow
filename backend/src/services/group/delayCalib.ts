// 群组 A/V 延迟补偿的读写与缓存(**按成员**存,v4.8.0 起取代旧的按协议三格)。
//
// 语义(所有成员一致):**正数 = 该设备更晚出声,负数 = 该设备更早出声**。单位 ms,
// 范围 ±30000(常量见下)。组里每个播放器(成员)独立一格,互不影响 —— 不再按
// 协议(AP1/AP2/Sendspin)一刀切:同组两台同协议音箱的抵达延迟也可以不同。
//
// 存储键 = 命名空间成员 id(与 player_groups.memberIds 完全同源):
//   airplay:<deviceId>   → bridgeAnchorShiftUsOf(groupName, deviceId) → 桥投递窗口/
//                          锚点位移(µs;锚点在桥会话建立时算死 ⇒ 改完要重建该成员桥才生效)
//   sendspin:<clientId>  → sendspinDelayUsOfClient(groupName, clientId) → pushFrame
//                          下发戳偏移(帧级,**真·实时**,约 0.5~1s 后听到,取决于设备
//                          send_ahead 缓冲)
// 无组上下文(设备直连/单测桩)一律 0 —— 全局兜底值仍由 airplay/bridgeCalib 管,不归本文件。
//
// 缓存策略:懒加载 + 写时更新(无 TTL)。延迟值只经 setMemberDelay 变更,
// 因此不需要失效轮询;组删除由 invalidateGroupDelays 清缓存。
//
// ⚠️ 2026-11-02(P3):旧的「混合组切歌等待」组级值(mixed_anchor_lead_ms)已**移除**。
//   纯桥组/混合组统一由后端按 P1 分档 lead(2.5s/4.5s)+ P2 接续锚点自动决定起播
//   时机,前端不再有手动入口。DB 列保留但不再读写(避免迁移)。
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { playerGroups } from "../../db/schema.js";

/** 补偿范围(ms)。超出即钳制。用户定稿 ±30s:大偏移主要用于「排查/示波」而非日常听感,
 *  各设备的物理后果不对称(见文件头注释),前端文案已提示。 */
export const GROUP_DELAY_MIN_MS = -30000;
export const GROUP_DELAY_MAX_MS = 30000;
/** 前端步进(ms)。 */
export const GROUP_DELAY_STEP_MS = 10;

/** 成员延迟表:命名空间成员 id → ms(已钳制)。 */
export type MemberDelays = Record<string, number>;

interface GroupDelayCache {
  memberDelays: MemberDelays;
}

const cache = new Map<string, GroupDelayCache>();

/** 全新的「全空」补偿值。**必须每次新建对象**:调用方拿到的就是它,若复用同一个模块级
 *  常量(或把它塞进 cache),任一调用方改写返回值就会污染「全局默认 + 所有无行组」的读值
 *  —— 表现为别处莫名多出补偿,且刷新页面也复现不一致。 */
function zeroCache(): GroupDelayCache {
  return { memberDelays: {} };
}

/** 钳制到 ±30000ms 的整数;非数字 → 0。 */
export function clampGroupDelayMs(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(GROUP_DELAY_MAX_MS, Math.max(GROUP_DELAY_MIN_MS, Math.round(n)));
}

/** 从 member_delays_json 文本解析成员延迟表(非法/缺失 → {};逐项钳制)。 */
function parseMemberDelays(raw: unknown): MemberDelays {
  const out: MemberDelays = {};
  if (typeof raw !== "string" || raw.length === 0) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return out;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!k) continue;
    out[k] = clampGroupDelayMs(v);
  }
  return out;
}

/** 读某组的全部成员补偿(懒加载 + 缓存)。groupId 缺失/组不存在 → {}。
 *  返回值是**新建对象**(缓存命中也另建一份),调用方改写它不会污染缓存或其他组。 */
export function getMemberDelays(groupId: string | null | undefined): MemberDelays {
  if (!groupId) return {};
  const hit = cache.get(groupId);
  if (hit) return { ...hit.memberDelays };
  let v: GroupDelayCache = zeroCache();
  try {
    const row = db
      .select({ md: playerGroups.memberDelaysJson })
      .from(playerGroups)
      .where(eq(playerGroups.id, groupId))
      .get();
    if (row) {
      v = { memberDelays: parseMemberDelays(row.md) };
    }
  } catch { /* 库不可用 → {} */ }
  cache.set(groupId, v);
  return { ...v.memberDelays };
}

/** 读单个成员的补偿(ms)。成员没设过/组缺失 → 0。 */
export function getMemberDelayMs(groupId: string | null | undefined, memberId: string): number {
  if (!groupId || !memberId) return 0;
  return getMemberDelays(groupId)[memberId] ?? 0;
}

/** 写单个成员的补偿:**内存先更新(立即生效),再落库**(member_delays_json 整表回写)。
 *  @returns 实际生效值(已钳制)。 */
export function setMemberDelay(groupId: string, memberId: string, ms: unknown): number {
  if (!memberId) return 0;
  const v = clampGroupDelayMs(ms);
  const cur = cache.get(groupId) ?? { memberDelays: getMemberDelays(groupId) };
  const next: MemberDelays = { ...cur.memberDelays, [memberId]: v };
  cache.set(groupId, { memberDelays: next });
  try {
    db.update(playerGroups)
      .set({ memberDelaysJson: JSON.stringify(next), updatedAt: new Date().toISOString() })
      .where(eq(playerGroups.id, groupId))
      .run();
  } catch { /* 落库失败不回滚内存:播放正确性优先,下次启动回到旧值 */ }
  return v;
}

/** 组删除/重建时清缓存,避免同名 id 复用读到陈旧值。 */
export function invalidateGroupDelays(groupId: string): void {
  cache.delete(groupId);
}

/** 桥投递窗口用的锚点位移(µs):按**该桥设备**读它的成员格子(`airplay:<deviceId>`)。
 *  组名非 ug: ⇒ 0n(历史行为);成员没设过 → 0。
 *  正数 = 桥侧更晚出声(与 planBridgeAnchor.anchorShiftUs 同向)。
 *  投递窗口必须含它:桥侧可听时刻 = 组时间线 + shift;窗口不跟随 ⇒ shift 会被
 *  桥内对齐器当「帧提前到达」drop/skip 出清(2026-10-27 真机实锤),补偿整体失效。 */
export function bridgeAnchorShiftUsOf(groupName: string, airplayDeviceId: string): bigint {
  const id = parseUserGroupId(groupName);
  if (!id || !airplayDeviceId) return 0n;
  return BigInt(getMemberDelayMs(id, `airplay:${airplayDeviceId}`) * 1000);
}

/** 从 sendspin 组名取用户组 id:`ug:<gid>` → gid;设备组(裸 clientId)→ null。 */
export function parseUserGroupId(groupName: string): string | null {
  if (typeof groupName !== "string" || !groupName.startsWith("ug:")) return null;
  const id = groupName.slice("ug:".length);
  return id || null;
}

/** Sendspin 成员补偿(µs,bigint 给 pushAudio/sendAudio 的戳偏移):按**该客户端**
 *  读它的成员格子(`sendspin:<clientId>`)。正数 = 下发戳后移 = 该成员更晚出声。 */
export function sendspinDelayUsOfClient(groupName: string, clientId: string): bigint {
  const id = parseUserGroupId(groupName);
  if (!id || !clientId) return 0n;
  return BigInt(getMemberDelayMs(id, `sendspin:${clientId}`) * 1000);
}
