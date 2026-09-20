// ==================== per-player DSP 配置（③ 段, P4-2） ====================
//
// 分工：`audio/dsp.ts` 是纯函数（配置 → ffmpeg 片段），本文件负责**从哪读、按谁读**。
//
// 键是 `peerId`（"dlna:<deviceId>" / "group:<gid>" / "airplay:<id>" / "sendspin:<id>" /
// "local:<clientId>"），**按设备全局**、不按用户 —— 与 `sendspin_device_state` 同理：
// 音色是设备属性（书架箱 / 耳机各自的补偿曲线），换个账号登进来不该换一套 EQ。
//
// ⚠️ 落点说明：任务表 P4-2 写的落点是 `services/settings.ts`，实际落在本文件 ——
// `settings.ts` 是**全局单键** KV（`key → value`），per-player 配置塞进去要么拼 key
// 前缀（"dsp:dlna:xxx"）要么改它的语义；而仓里已有 `playerPrefs.ts` 这种"per-player 设置"
// 模块的先例，故新开一个同层文件，职责更单一。已在任务表备注里回报该偏离。
//
// 用 drizzle 而非裸 SQL，与 `playerPrefs.ts` 同构；读写失败的容忍度两边刻意不同：
// **读**必须永不抛（它在出流热路径上，读失败 = 这首歌放不出来，而用户只想听歌）；
// **写**失败要抛（设置面板的保存必须能回 500，静默吞掉才是最坏的结果）。
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { playerDspConfigs } from "../db/schema.js";
import { DSP_FILTER_RATE, buildFilterChain, normalizeDspConfig, type DspConfig, type DspFormat } from "./audio/dsp.js";
import { getGroupManager } from "./group/index.js";

/**
 * 单曲管道（非 flow）的**锚定格式**：48000 Hz / 立体声，与 `DSP_FILTER_RATE` 同源。
 *
 * 为什么声道数可以直接定成 2：我们拿不到"起播前的真实格式"（见 `DSP_FILTER_RATE` 的注释），
 * 而 Balance 与分声道 EQ（`:c=FL`）在**单声道输入**上根本没有 FL/FR 可操作 —— 与其猜，
 * 不如在链首显式锚到立体声（`aformat=channel_layouts=stereo`），结果可预测。
 * flow 会话不需要这一层：它的解码段本来就 `-ar 48000 -ac 2`（`flowDecodeArgs`）。
 */
export const DSP_ANCHOR_FORMAT: DspFormat = { sampleRate: DSP_FILTER_RATE, channels: 2 };

/** 读某台播放器的 DSP 配置；无行 / 坏 JSON / 全 0 一律 `null`（= 无 DSP，零滤镜）。 */
export function getPlayerDspConfig(peerId: string): DspConfig | null {
  if (!peerId) return null;
  try {
    const row = db.select().from(playerDspConfigs).where(eq(playerDspConfigs.peerId, peerId)).get();
    if (!row?.config) return null;
    return normalizeDspConfig(JSON.parse(row.config));
  } catch {
    // 表未就绪 / JSON 坏 → 按无 DSP 处理（绝不把坏值带进 ffmpeg 命令）
    return null;
  }
}

/**
 * 写入配置。入参是**任意形状**（API 请求体），归一化后落库；归一化结果为 `null`
 * （= 没活可干）时**删行**，避免库里留一堆"等于没配置"的空行。
 * 返回归一化后的配置，便于调用方回显"实际生效值"（前端表单据此纠正用户输入）。
 *
 * 与读路径相反：这里**不吞 DB 错误** —— 写失败必须让 API 能回 500（见文件头注释）。
 */
export function setPlayerDspConfig(peerId: string, raw: unknown): DspConfig | null {
  if (!peerId) return null;
  const cfg = normalizeDspConfig(raw);
  const now = new Date().toISOString();
  if (!cfg) {
    db.delete(playerDspConfigs).where(eq(playerDspConfigs.peerId, peerId)).run();
    return null;
  }
  const config = JSON.stringify(cfg);
  db.insert(playerDspConfigs)
    .values({ peerId, config, updatedAt: now })
    .onConflictDoUpdate({ target: playerDspConfigs.peerId, set: { config, updatedAt: now } })
    .run();
  return cfg;
}

/** 全部配置（设置面板一次拿全，省 N 次请求）。只回非空配置；读失败回空表。 */
export function listPlayerDspConfigs(): Record<string, DspConfig> {
  const out: Record<string, DspConfig> = {};
  try {
    for (const r of db.select().from(playerDspConfigs).all()) {
      const cfg = normalizeDspConfig(safeParse(r.config));
      if (cfg) out[r.peerId] = cfg;
    }
  } catch { /* 表未就绪 → 空表 */ }
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 该播放器是否属于某个「组」（成组后 per-player DSP 必须禁用，照 MA / plan §3.3 的 ⚠️）。 */
export function isPeerGrouped(peerId: string): boolean {
  if (!peerId) return false;
  try {
    return getGroupManager().groupsOfDevice(peerId).length > 0;
  } catch {
    return false;
  }
}

/**
 * 出流侧唯一入口：`peerId` → 该播放器该加的 `-af` 片段。
 *
 * 调用方把返回值**接在响度链之后、限制器之前**（② → ③ → ⑤，见 plan §3.1）：
 * DSP 必须作用在"已经一样响"的信号上，否则音量归一化会把你调的音色重新抹平。
 * 返回 `[]` 的四种情形：没传 peerId（HTTP 客户端没自报家门） / 无配置 / 成组 / 全 0。
 *
 * `opts.flow`（缺省 false）表示这次出流是 flow 连续流会话：它的解码段已经
 * `-ar 48000 -ac 2`，系数与锚定值同源 ⇒ 不必再补 `aresample` / `aformat`。
 * 非 flow（单曲管道）不强制格式，故在链首补 `aresample=48000` +
 * `aformat=channel_layouts=stereo` —— biquad 系数与采样率绑定，不锚定就等于
 * "按错的频率算 EQ"（见 `DSP_FILTER_RATE` 的注释）。
 */
export function playerDspFilters(
  peerId: string | null | undefined,
  opts: { flow?: boolean } = {},
): string[] {
  if (!peerId) return [];
  const cfg = getPlayerDspConfig(peerId);
  if (!cfg) return [];
  const chain = buildFilterChain(cfg, DSP_ANCHOR_FORMAT, { grouped: isPeerGrouped(peerId) });
  if (chain.length === 0) return [];
  if (opts.flow === true) return chain;
  return [`aresample=${DSP_FILTER_RATE}`, `aformat=channel_layouts=stereo`, ...chain];
}
