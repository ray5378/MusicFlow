// 播放器「按用户级隐藏」偏好:每个用户可把某台 DLNA/AirPlay 设备/群组设成
// 「不显示在我自己的播放器切换弹窗里」。仅影响本人列表,不禁用设备(他人仍可
// 使用),管理员同样受自己的隐藏影响,独立于播放器授权(user_renderer_grants)。
// peerId = "dlna:<id>" | "airplay:<id>" | "group:<id>"。
import { db } from "../db/index.js";
import { playerPrefs } from "../db/schema.js";
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