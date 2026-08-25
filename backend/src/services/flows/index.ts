// 音流(MusicFlow)执行引擎。
// 一条音流 = 目标设备/组(可多选)+ 等待上线 + 设音量 + 播放模式 + 播歌单。
// 触发后异步在后台执行:持续扫描 DLNA → 任一目标上线即对其依次执行后续节点;
// 执行状态写入 flows 表(页面可查看最近一次运行结果)。
import { randomUUID as uuidv4 } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { flows } from "../../db/schema.js";
import { getPeerManager, parsePeerId } from "../peer.js";
import { getQueueManager } from "../dlna/queue.js";
import { getQueueController } from "../player/index.js";
import { setDeviceVolume, refreshDevices } from "../dlna/control.js";
import { resolveContentSongs, songsToQueueItems } from "../content.js";
import { isFixedRecommendPlaylist, ensureHomePlaylist } from "../plugin/fixedRecommend.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("INDEX");
export type FlowPlayMode = "order" | "one" | "all" | "shuffle";

export interface FlowDefinition {
  /** 目标 peerId 列表:dlna:<deviceId> / group:<groupId> */
  targets: string[];
  /** 等待设备上线超时(秒);0 = 无限等待 */
  waitTimeoutSec: number;
  /** 持续扫描间隔(秒),2..60 */
  scanIntervalSec: number;
  volume: { enabled: boolean; value: number };
  playmode: { enabled: boolean; mode: FlowPlayMode };
  content: { enabled: boolean; type: "playlist" | "album" | "artist" | "genre"; id: string; name?: string; startIndex?: number };
}

export interface FlowRow {
  id: string;
  token: string;
  /** 对外链接绑定的「通用播放器控制」渠道 token id;空 = 未绑定,链接不可用。 */
  tokenId: string;
  name: string;
  definition: FlowDefinition;
  enabled: boolean;
  lastRunAt: string;
  lastRunStatus: string; // waiting|playing|success|error|timeout
  lastRunError: string;
  createdAt: string;
  updatedAt: string;
}

function parseDef(json: string): FlowDefinition {
  try {
    const raw = JSON.parse(json || "{}");
    return {
      targets: Array.isArray(raw.targets) ? raw.targets : [],
      waitTimeoutSec: typeof raw.waitTimeoutSec === "number" ? raw.waitTimeoutSec : 0,
      scanIntervalSec: typeof raw.scanIntervalSec === "number" ? raw.scanIntervalSec : 5,
      volume: { enabled: true, value: 80, ...(raw.volume || {}) },
      playmode: { enabled: true, mode: "shuffle", ...(raw.playmode || {}) },
      content: { enabled: true, type: "playlist", id: "", startIndex: 0, ...(raw.content || {}) },
    };
  } catch {
    return { targets: [], waitTimeoutSec: 0, scanIntervalSec: 5, volume: { enabled: true, value: 80 }, playmode: { enabled: true, mode: "shuffle" }, content: { enabled: true, type: "playlist", id: "", startIndex: 0 } };
  }
}

function rowToFlow(r: any): FlowRow {
  return {
    id: r.id,
    token: r.token,
    tokenId: r.tokenId || "",
    name: r.name,
    definition: parseDef(r.definitionJson),
    enabled: r.enabled === 1,
    lastRunAt: r.lastRunAt || "",
    lastRunStatus: r.lastRunStatus || "",
    lastRunError: r.lastRunError || "",
    createdAt: r.createdAt || "",
    updatedAt: r.updatedAt || "",
  };
}

export function listFlows(): FlowRow[] {
  return db.select().from(flows).all().map(rowToFlow);
}

export function getFlow(id: string): FlowRow | undefined {
  const r = db.select().from(flows).where(eq(flows.id, id)).get();
  return r ? rowToFlow(r) : undefined;
}

export function getFlowByToken(token: string): FlowRow | undefined {
  const r = db.select().from(flows).where(eq(flows.token, token)).get();
  return r ? rowToFlow(r) : undefined;
}

export function createFlow(name: string, definition: FlowDefinition, tokenId = ""): FlowRow {
  const id = `flow-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const now = new Date().toISOString();
  db.insert(flows).values({
    id,
    token: uuidv4().replace(/-/g, ""),
    tokenId,
    name,
    definitionJson: JSON.stringify(definition),
    enabled: 1,
    createdAt: now,
    updatedAt: now,
  }).run();
  return getFlow(id)!;
}

export function updateFlow(id: string, patch: { name?: string; definition?: FlowDefinition; enabled?: boolean; tokenId?: string }): FlowRow | undefined {
  const cur = getFlow(id);
  if (!cur) return undefined;
  const now = new Date().toISOString();
  db.update(flows).set({
    name: patch.name ?? cur.name,
    tokenId: patch.tokenId === undefined ? cur.tokenId : patch.tokenId,
    definitionJson: patch.definition ? JSON.stringify(patch.definition) : JSON.stringify(cur.definition),
    enabled: patch.enabled === undefined ? (cur.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
    updatedAt: now,
  }).where(eq(flows.id, id)).run();
  return getFlow(id);
}

export function deleteFlow(id: string): boolean {
  const cur = getFlow(id);
  if (!cur) return false;
  db.delete(flows).where(eq(flows.id, id)).run();
  return true;
}

export function setFlowEnabled(id: string, enabled: boolean): void {
  db.update(flows).set({ enabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() }).where(eq(flows.id, id)).run();
}

function touchRunStatus(id: string, status: string, error: string): void {
  db.update(flows).set({
    lastRunAt: new Date().toISOString(),
    lastRunStatus: status,
    lastRunError: error,
  }).where(eq(flows.id, id)).run();
}

const running = new Set<string>();

export function isFlowRunning(id: string): boolean {
  return running.has(id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 异步执行一条音流。同一时间同一流程只允许一个运行实例(重复触发直接跳过)。
 * 执行过程:
 *   1) 校验内容(歌单)可解析;
 *   2) 状态 → waiting:持续扫描(主动 refreshDevices + 读 peer 可用性),
 *      直到任一目标上线(waitTimeoutSec=0 时无限等待);
 *   3) 状态 → playing:对每个在线目标依次设音量、设播放模式、playFrom;
 *   4) 状态 → success / error / timeout,结果写回 flows 表。
 */
export async function executeFlow(flowId: string, baseUrl: string): Promise<"started" | "already-running"> {
  if (running.has(flowId)) return "already-running";
  const flow = getFlow(flowId);
  if (!flow) return "started"; // 不存在的情况由调用方处理
  running.add(flowId);
  setTimeout(() => {
    runInternal(flow.id, baseUrl).catch((e: any) => {
      console.warn(`[flow ${flow.name}] 执行异常:`, e?.message || e);
      touchRunStatus(flow.id, "error", e?.message || "执行异常");
    }).finally(() => running.delete(flowId));
  }, 0);
  return "started";
}

async function runInternal(flowId: string, baseUrl: string): Promise<void> {
  const flow = getFlow(flowId);
  if (!flow) return;
  const def = flow.definition;
  const pm = getPeerManager();
  const qm = getQueueManager();
  const qc = getQueueController();

  const targets = (def.targets || []).filter((t) => parsePeerId(t));
  if (targets.length === 0) {
    touchRunStatus(flowId, "error", "未配置目标设备/组");
    return;
  }

  // 预解析内容(歌单/专辑/艺人/风格)。
  let items: any[] = [];
  let contentName = "";
  if (def.content?.enabled) {
    // 固定推荐歌单(今日漫游/今日推荐/本地推荐)自愈:歌单缺失或暂无内容时,
    // 自动触发生成(对应插件 runDailyJob)并等待可播条目——音流触发不依赖
    // 每日调度时序,刚开机/当天未跑调度也能先生成再播。
    if ((def.content.type || "playlist") === "playlist" && isFixedRecommendPlaylist(def.content.id)) {
      const ensure = await ensureHomePlaylist(def.content.id);
      if (!ensure.ok) {
        touchRunStatus(flowId, "error", `推荐歌单「${def.content.name || def.content.id}」未就绪:${ensure.reason || "生成失败"}`);
        return;
      }
    }
    const resolved = resolveContentSongs(def.content.type || "playlist", def.content.id);
    if (!resolved || resolved.rows.length === 0) {
      touchRunStatus(flowId, "error", `内容解析失败:${def.content.name ? `「${def.content.name}」` : "所选内容"}无可播放歌曲`);
      return;
    }
    items = songsToQueueItems(resolved.rows);
    contentName = resolved.name;
  }

  // 阶段 1:持续扫描等待设备/组上线。
  touchRunStatus(flowId, "waiting", "");
  const intervalMs = Math.max(2, Math.min(60, def.scanIntervalSec || 5)) * 1000;
  const deadline = def.waitTimeoutSec > 0 ? Date.now() + def.waitTimeoutSec * 1000 : 0;
  const online: string[] = [];
  while (true) {
    try { await refreshDevices(); } catch { /* 扫描失败下一轮重试 */ }
    for (const pid of targets) {
      if (online.includes(pid)) continue;
      const p = pm.get(pid);
      if (p && p.available) online.push(pid);
    }
    if (online.length > 0) break;
    if (deadline > 0 && Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  if (online.length === 0) {
    touchRunStatus(flowId, "timeout", `等待设备上线超时(${def.waitTimeoutSec || 0}s),未找到可用目标`);
    return;
  }

  // 阶段 2:对每个在线目标执行 播放模式 → 播放 → 音量。
  touchRunStatus(flowId, "playing", "");
  const errs: string[] = [];
  for (const pid of online) {
    const parsed = parsePeerId(pid)!;
    const name = pm.get(pid)?.name || pid;
    try {
      if (def.playmode?.enabled && def.playmode.mode) {
        qm.setPlayMode(parsed.id, def.playmode.mode);
      }
      if (items.length > 0) {
        await qm.playFrom(parsed.id, items, def.content?.startIndex || 0, baseUrl);
      }
      if (def.volume?.enabled && typeof def.volume.value === "number") {
        if (parsed.kind === "dlna") await setDeviceVolume(parsed.id, def.volume.value);
        else if (parsed.kind === "group") await qc.transport(parsed.id, "volume", def.volume.value);
      }
      console.log(`[flow ${flow.name}] 已执行:${name}(${pid})${contentName ? ` → 「${contentName}」` : ""}`);
    } catch (e: any) {
      errs.push(`${name}: ${e?.message || e}`);
      log.warn(`[flow ${flow.name}] 目标 ${pid} 执行失败:${e?.message || e}`);
    }
  }
  if (errs.length === 0) touchRunStatus(flowId, "success", "");
  else touchRunStatus(flowId, "error", `部分失败:${errs.join("; ")}`);
}