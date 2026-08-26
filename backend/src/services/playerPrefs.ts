// 播放器「按用户级隐藏」偏好:每个用户可把某台 DLNA/AirPlay 设备/群组设成
// 「不显示在我自己的播放器切换弹窗里」。仅影响本人列表,不禁用设备(他人仍可
// 使用),管理员同样受自己的隐藏影响,独立于播放器授权(user_renderer_grants)。
// peerId = "dlna:<id>" | "airplay:<id>" | "group:<id>"。
import { db } from "../db/index.js";
import { playerPrefs, playerNameOverrides } from "../db/schema.js";
import { eq, and } from "drizzle-orm";

/** 返回该用户隐藏的所有 peerId。ownerUserId 为空时(未登录)恒为空集。 */
export function getHiddenPeerIds(ownerUserId: string): Set<string> {
  if (!ownerUserId) return new Set();
  const rows = db.select().from(playerPrefs).where(eq(playerPrefs.ownerUserId, ownerUserId)).all();
  return new Set(rows.filter((r) => r.hidden === 1).map((r) => r.peerId));
}

/** 设置/取消该用户对某 peerId 的隐藏。hidden=false 时删除行(等同未隐藏)。 */
export function setPeerHidden(ownerUserId: string, peerId: string, hidden: boolean): void {
  if (!ownerUserId || !peerId) return;
  const cond = and(eq(playerPrefs.ownerUserId, ownerUserId), eq(playerPrefs.peerId, peerId));
  const existing = db.select().from(playerPrefs).where(cond).get();
  const now = new Date().toISOString();
  if (hidden) {
    if (existing) db.update(playerPrefs).set({ hidden: 1, updatedAt: now }).where(cond).run();
    else db.insert(playerPrefs).values({ ownerUserId, peerId, hidden: 1, updatedAt: now }).run();
  } else if (existing) {
    db.delete(playerPrefs).where(cond).run();
  }
}

/** 查某用户是否隐藏了指定 peerId(供「播放器」页开关显示状态用)。 */
export function isPeerHidden(ownerUserId: string, peerId: string): boolean {
  if (!ownerUserId || !peerId) return false;
  const r = db.select().from(playerPrefs).where(and(eq(playerPrefs.ownerUserId, ownerUserId), eq(playerPrefs.peerId, peerId))).get();
  return !!r && r.hidden === 1;
}

// ==================== 按用户级显示名覆盖 ====================
// 每个用户可给自己视角下的某台设备/群组(peerId)起显示名,只影响本人界面与播放器
// 切换器;他人各自改名互不影响,设备原始名(alias/name)保持不变。

/** 返回该用户的全部显示名覆盖:peerId → displayName(未改名者为空集)。 */
export function getNameOverrides(ownerUserId: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!ownerUserId) return map;
  const rows = db.select().from(playerNameOverrides).where(eq(playerNameOverrides.ownerUserId, ownerUserId)).all();
  for (const r of rows) {
    if (r.displayName) map.set(r.peerId, r.displayName);
  }
  return map;
}

/** 查该用户对某 peerId 的显示名(未覆盖返回空串)。 */
export function getPeerNameOverride(ownerUserId: string, peerId: string): string {
  if (!ownerUserId || !peerId) return "";
  const r = db.select().from(playerNameOverrides)
    .where(and(eq(playerNameOverrides.ownerUserId, ownerUserId), eq(playerNameOverrides.peerId, peerId)))
    .get();
  return r?.displayName || "";
}

/** 设置该用户对某 peerId 的显示名;name 为空串表示清除覆盖(恢复原始名)。 */
export function setPeerNameOverride(ownerUserId: string, peerId: string, name: string): void {
  if (!ownerUserId || !peerId) return;
  const displayName = (name || "").trim();
  const cond = and(eq(playerNameOverrides.ownerUserId, ownerUserId), eq(playerNameOverrides.peerId, peerId));
  const now = new Date().toISOString();
  if (!displayName) {
    db.delete(playerNameOverrides).where(cond).run();
    return;
  }
  const existing = db.select().from(playerNameOverrides).where(cond).get();
  if (existing) db.update(playerNameOverrides).set({ displayName, updatedAt: now }).where(cond).run();
  else db.insert(playerNameOverrides).values({ ownerUserId, peerId, displayName, updatedAt: now }).run();
}