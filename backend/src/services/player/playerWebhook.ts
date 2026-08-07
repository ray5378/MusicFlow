// 通用播放器控制 Webhook(与 flow 解耦):
//   URL 参数即配置,不依赖任何内部流程。外部工具(HA/快捷指令)直接控制
//   DLNA 音箱/播放器群组:切换播放模式 / 播放/暂停/停止/上一首/下一首 /
//   精确音量(0-100 或相对 +N/-N)/ 收藏当前曲到「我喜欢」。
//   鉴权靠独立管理的多条渠道 token(免鉴权端点,凭任一启用的 token 执行)。
import { randomUUID as uuidv4 } from "crypto";
import { db } from "../../db/index.js";
import { users, userFavoriteSongs, playerWebhookTokens } from "../../db/schema.js";
import { eq, and } from "drizzle-orm";
import { parsePeerId, getPeerManager } from "../peer.js";
import { getQueueManager } from "../dlna/queue.js";
import { getQueueController } from "../player/index.js";
import type { PlayMode } from "../player/types.js";
import { getGroupManager } from "../group/index.js";
import { getGroupStatus } from "../group/protocolPlayer.js";
import {
  playDevice, pauseDevice, stopDevice, setDeviceVolume,
  getCachedDevices, getDeviceStatus,
} from "../dlna/control.js";

export const PLAY_MODES = ["order", "one", "all", "shuffle"] as const;

// ==================== 渠道 Token 管理 ====================

/** 列出所有渠道 token(完整 token 只在管理接口返回)。 */
export function listPlayerWebhookTokens(): readonly {
  id: string; name: string; token: string; enabled: boolean; ownerUserId: string; createdAt: string; updatedAt: string;
}[] {
  return db.select().from(playerWebhookTokens).orderBy(playerWebhookTokens.createdAt).all()
    .map(r => ({
      id: r.id, name: r.name || "", token: r.token, enabled: !!r.enabled,
      ownerUserId: r.ownerUserId || "", createdAt: r.createdAt || "", updatedAt: r.updatedAt || "",
    }));
}

/** 新增一条渠道 token,并绑定创建者(owner)。 */
export function createPlayerWebhookToken(userId: string, name: string): string {
  const id = uuidv4();
  const token = uuidv4().replace(/-/g, "");
  db.insert(playerWebhookTokens).values({
    id, name, token, enabled: 1, ownerUserId: userId,
  }).run();
  return token;
}

/** 删除一条渠道 token(永久失效)。 */
export function deletePlayerWebhookToken(id: string): boolean {
  const res = db.delete(playerWebhookTokens).where(eq(playerWebhookTokens.id, id)).run();
  return (res?.changes ?? 0) > 0;
}

/** 按 id 启用/停用渠道 token(id=1 执行,0 停用)。 */
export function setPlayerWebhookTokenEnabled(id: string, enabled: boolean): boolean {
  const res = db.update(playerWebhookTokens)
    .set({ enabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() })
    .where(eq(playerWebhookTokens.id, id)).run();
  return (res?.changes ?? 0) > 0;
}

/** 校验 token:存在且启用。返回归属用户 id(供「我喜欢」)。校验失败返回 undefined。 */
export function validatePlayerWebhookToken(token: string): { ownerUserId: string } | undefined {
  const r = db.select().from(playerWebhookTokens).where(eq(playerWebhookTokens.token, token)).get();
  if (!r || !r.enabled) return undefined;
  return { ownerUserId: r.ownerUserId || "" };
}

/** 渠道 token 的归属用户名(展示用)。 */
export function resolvePlayerWebhookOwnerName(ownerUserId: string): string {
  if (!ownerUserId) return "";
  const u = db.select().from(users).where(eq(users.id, ownerUserId)).get();
  return u?.username || "";
}

/** 解析 device 参数 → 一个或多个 cast peerId(dlna:<id> / group:<id>)。 */
export function resolvePlayerDevicePeers(device: string): string[] {
  const q = (device || "").trim();
  if (!q) throw new Error("缺少 device 参数");
  // 精确 peerId
  if (q.startsWith("dlna:") || q.startsWith("group:")) {
    const parsed = parsePeerId(q);
    if (!parsed) throw new Error(`无效的 peerId: ${q}`);
    return [q];
  }
  // all → 全部在线的 DLNA 设备 + 全部群组
  if (q === "all") {
    const all: string[] = [];
    for (const d of getCachedDevices()) {
      if (d.available) all.push(`dlna:${d.id}`);
    }
    for (const g of getGroupManager().list()) {
      all.push(`group:${g.id}`);
    }
    if (all.length === 0) throw new Error("没有可用的播放器");
    return all;
  }
  // 名字模糊匹配(大小写不敏感)
  const lower = q.toLowerCase();
  const matches: Array<{ peerId: string; name: string }> = [];
  for (const d of getCachedDevices()) {
    if ((d.name || "").toLowerCase().includes(lower)) matches.push({ peerId: `dlna:${d.id}`, name: d.name });
  }
  for (const g of getGroupManager().list()) {
    if ((g.name || "").toLowerCase().includes(lower)) matches.push({ peerId: `group:${g.id}`, name: g.name });
  }
  if (matches.length === 0) throw new Error(`找不到播放器「${device}」`);
  if (matches.length > 1) {
    throw new Error(`「${device}」匹配到多个播放器(${matches.map(m => m.name).join("、")}),请改用精确 peerId`);
  }
  return [matches[0].peerId];
}

function asFlag(v: string | undefined): boolean {
  if (v === undefined || v === "") return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseVolumeParam(v: string): { absolute: number } | { relative: number } | null {
  const s = (v || "").trim();
  if (s === "") return null;
  if (/^[+-]\d+$/.test(s)) {
    const rel = parseInt(s.slice(1), 10) * (s[0] === "-" ? -1 : 1);
    return { relative: rel };
  }
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n < 0 || n > 100) return null;
    return { absolute: n };
  }
  return null;
}

async function readVolume(peerId: string, kind: string): Promise<number> {
  if (kind === "dlna") {
    const st = await getDeviceStatus(peerId);
    return typeof st.volume === "number" ? st.volume : NaN;
  }
  const st = await getGroupStatus(peerId);
  return typeof st.volume === "number" ? st.volume : NaN;
}

/** 收藏「当前播放曲」:从 cast peer 队列快照取 currentIndex 歌曲,归属该 token 的 owner。 */
function favoriteCurrent(peerId: string, owner: string): { ok: boolean; detail?: string } {
  if (!owner) return { ok: false, detail: "该 token 未绑定归属用户" };
  const snap = getPeerManager().getQueueSnapshot(peerId);
  const items = snap?.items || [];
  const idx = typeof snap?.currentIndex === "number" ? snap.currentIndex : -1;
  if (!items.length || idx < 0 || idx >= items.length) {
    return { ok: false, detail: "当前没有正在播放的歌曲" };
  }
  const songId = items[idx].songId;
  const existing = db.select().from(userFavoriteSongs)
    .where(and(eq(userFavoriteSongs.userId, owner), eq(userFavoriteSongs.songId, songId))).get();
  if (!existing) db.insert(userFavoriteSongs).values({ userId: owner, songId }).run();
  return { ok: true, detail: `${items[idx].title || "未知"}${items[idx].artist ? ` - ${items[idx].artist}` : ""}` };
}

export interface PlayerWebhookOpResult {
  device: string;
  op: string;
  ok: boolean;
  detail?: string;
}

export interface PlayerWebhookResult {
  success: boolean;
  device: string;
  results: PlayerWebhookOpResult[];
  song?: { songId?: string; title?: string; artist?: string };
}

/** 对一个 cast peer 依次执行:mode → 传输 → volume → favorite。ownerUserId 用于「我喜欢」。 */
export async function handlePlayerWebhook(
  peerId: string,
  params: Record<string, string>,
  baseUrl: string,
  ownerUserId = "",
): Promise<PlayerWebhookResult> {
  const parsed = parsePeerId(peerId);
  if (!parsed || (parsed.kind !== "dlna" && parsed.kind !== "group")) {
    throw new Error("仅支持 DLNA 设备与播放器群组");
  }
  const id = parsed.id;
  const results: PlayerWebhookOpResult[] = [];
  const qm = getQueueManager();
  const qc = getQueueController();

  // ① 播放模式
  if (typeof params.mode === "string" && params.mode !== "") {
    if (!(PLAY_MODES as readonly string[]).includes(params.mode)) {
      throw new Error(`无效的 mode: ${params.mode}(可选 ${PLAY_MODES.join("|")})`);
    }
    qm.setPlayMode(id, params.mode as PlayMode);
    results.push({ device: peerId, op: "mode", ok: true, detail: params.mode });
  }

  // ② 传输控制(按 play/pause/stop/next/prev 顺序)
  const runTransport = async (op: string): Promise<void> => {
    try {
      if (op === "next") { await qm.next(id, baseUrl); }
      else if (op === "prev") { await qm.prev(id, baseUrl); }
      else if (parsed.kind === "dlna") {
        if (op === "play") await playDevice(id);
        else if (op === "pause") await pauseDevice(id);
        else if (op === "stop") await stopDevice(id);
      } else {
        await qc.transport(id, op as "play" | "pause" | "stop");
      }
      results.push({ device: peerId, op, ok: true });
    } catch (e: any) {
      results.push({ device: peerId, op, ok: false, detail: e?.message || String(e) });
    }
  };
  for (const op of ["play", "pause", "stop", "next", "prev"]) {
    if (asFlag(params[op])) await runTransport(op);
  }

  // ③ 音量(绝对值 0-100,或相对 +N/-N)
  if (typeof params.volume === "string" && params.volume !== "") {
    const v = parseVolumeParam(params.volume);
    if (!v) {
      results.push({ device: peerId, op: "volume", ok: false, detail: `无效的 volume: ${params.volume}(0-100 或 +N/-N)` });
    } else {
      try {
        let target: number;
        if ("absolute" in v) target = v.absolute;
        else {
          const cur = await readVolume(id, parsed.kind);
          if (!Number.isFinite(cur)) {
            results.push({ device: peerId, op: "volume", ok: false, detail: "无法读取当前音量,不支持相对调节" });
            target = NaN;
          } else target = Math.max(0, Math.min(100, cur + v.relative));
        }
        if (Number.isFinite(target)) {
          if (parsed.kind === "dlna") await setDeviceVolume(id, target);
          else await qc.transport(id, "volume", target);
          results.push({ device: peerId, op: "volume", ok: true, detail: `${target}%` });
        }
      } catch (e: any) {
        results.push({ device: peerId, op: "volume", ok: false, detail: e?.message || String(e) });
      }
    }
  }

  // ④ 收藏当前曲到「我喜欢」
  if (asFlag(params.favorite)) {
    const r = favoriteCurrent(peerId, ownerUserId);
    results.push({ device: peerId, op: "favorite", ok: r.ok, detail: r.detail });
  }

  const song = { songId: undefined as string | undefined, title: undefined as string | undefined, artist: undefined as string | undefined };
  const snap = getPeerManager().getQueueSnapshot(peerId);
  const items = snap?.items || [];
  const idx = typeof snap?.currentIndex === "number" ? snap.currentIndex : -1;
  if (items.length && idx >= 0 && idx < items.length) {
    song.songId = items[idx].songId;
    song.title = items[idx].title;
    song.artist = items[idx].artist;
  }

  const failed = results.filter(r => !r.ok);
  return {
    success: failed.length === 0,
    device: peerId,
    results,
    song,
  };
}
