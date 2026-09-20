// ==================== flow mode 的「开关 / 队列选曲 / ICY 元数据」（P3-1·P3-5） ====================
//
// flow.ts 只认 `FlowItem[]`（纯进程编排，不碰 DB / 队列 / HTTP）。本文件补齐它不该知道的三件事，
// 全部是**纯函数或纯字符串读取**（`get` 注入，不 import settings/db），因此能被 vitest 直接断言
// —— 交叉淡入链路的错误几乎都是"不报错、只难听"，必须靠这种可断言的边界把它圈住。
//
//   ① 开关与配置：`pipeline.flow` / `crossfade.mode` / `crossfade.durationSec`
//      （缺省 **关**：D7 只定"本轮做 L0"，没定"缺省打开"；自用场景下先手动开，见 P5-1 开关 UI）
//   ② 从服务端权威队列里挑出「本次会话要拼的连续曲目」：洗牌 / 单曲循环一律不拼
//      （它们的"下一首"不由队列下标决定，会话内推进会与设备的真实顺序打架）
//   ③ ICY 元数据块：连续流里设备拿不到曲目边界（P3-5），必须靠 icy-metaint 间隔下发 StreamTitle
import { FADE_DEFAULT_SEC, normalizeFadeConfig, type FadeConfig } from "./fades.js";
import type { QueueItem, QueueSnapshot } from "../player/types.js";

/** 总开关（`pipeline.flow`）。"0" = 关。 */
export const FLOW_ENABLED_KEY = "pipeline.flow";
/** 交叉淡入模式（`crossfade.mode`）：`disabled`（缺省）/ `standard`（本轮 L0）。 */
export const CROSSFADE_MODE_KEY = "crossfade.mode";
/** 过渡时长秒数（`crossfade.durationSec`）。 */
export const CROSSFADE_DURATION_KEY = "crossfade.durationSec";

/** 单次会话最多拼多少首（防止整库队列一次性建 FlowItem 数组；解码器是懒预取的，不占内存）。 */
export const FLOW_MAX_ITEMS = 200;

/** 交叉淡入模式取值（对齐 MA `CrossfadeMode`，本轮只实现前两个）。 */
export type CrossfadeMode = "disabled" | "standard";

export interface FlowSettings {
  /** 总开关。false → 调用方完全不碰 flow，逐首管道（D9：仍走管道）。 */
  enabled: boolean;
  /** 是否做交叉淡入。false = flow 会话退化为"连续直通"（无重叠），或干脆不走 flow。 */
  crossfade: boolean;
  /** 归一化后的过渡配置（时长已夹到 [3s, ∞)、曲线已收敛到闭集）。 */
  fade: FadeConfig;
  mode: CrossfadeMode;
}

/**
 * 读开关与配置。`get(key, def)` 由调用方注入（路由传 `getSetting`，测试传纯 Map 查询），
 * 这样本函数不依赖 settings 模块的 DB / 缓存，测试里能直接断言"缺省 = 全关"。
 *
 * `opts.effectsOn`（缺省 `true`）由调用方算好传入 —— **管道开关关掉时不做交叉淡入**
 * （plan §7「回退」：全局关 = 滤镜链为空 + 无交叉淡入；DLNA 单设备回退亦然）。
 * 判定不写在这里是为了保持本文件**纯函数**（不 import settings，见文件头）。
 *
 * 缺省策略（**必须记住，否则会误以为交叉淡入坏了**）：
 *   - `pipeline.flow` 缺省 `1`（开关语义上"允许"），但 `crossfade.mode` 缺省 `disabled`
 *     → `crossfade=false` ⇒ 调用方不会走 flow ⇒ 行为与 P2 逐首管道逐字节一致；
 *   - 只有把 `crossfade.mode` 显式设成 `standard` 才会真拼连续流。
 */
export function resolveFlowSettings(
  get: (key: string, def: string) => string,
  opts: { effectsOn?: boolean } = {},
): FlowSettings {
  const enabled = opts.effectsOn !== false && get(FLOW_ENABLED_KEY, "1") !== "0";
  const rawMode = (get(CROSSFADE_MODE_KEY, "disabled") || "").trim().toLowerCase();
  const mode: CrossfadeMode = rawMode === "standard" ? "standard" : "disabled";
  const rawDur = Number.parseInt(get(CROSSFADE_DURATION_KEY, ""), 10);
  const fade = normalizeFadeConfig({
    ...(Number.isFinite(rawDur) && rawDur > 0 ? { durationSec: rawDur } : {}),
  });
  return { enabled, crossfade: mode === "standard", fade, mode };
}

/**
 * 从队列快照里挑出「从 `fromSongId` 起、按队列顺序连续」的曲目（含它自己）。
 *
 * 不做会话的情况（返回 `[]`，调用方回退单曲管道）：
 *   - 队列里找不到这首歌（cast token 指向的歌已不在队列 / 被替换）；
 *   - `playMode` 不是 `order`：`shuffle` 的下一首由洗牌序决定、`one`/`all` 会回卷，
 *     都不是"队列下标 +1"，会话内推进必然与设备真实顺序不一致；
 *   - 队列项没有 songId（理论上不该有，防御）。
 *
 * 只截断不补齐：`max` 之后的曲目在本次会话里不存在（会话结束时设备自然停止 → 走
 * 既有的 `ended` 路径），所以 `max` 取大值即可让整条队列一次拼完。
 */
export function selectFlowCandidates(
  snapshot: Pick<QueueSnapshot, "items" | "currentIndex" | "playMode"> | null | undefined,
  fromSongId: string,
  max: number = FLOW_MAX_ITEMS,
): QueueItem[] {
  if (!snapshot || !Array.isArray(snapshot.items) || snapshot.items.length === 0) return [];
  if (snapshot.playMode !== "order") return [];
  if (!fromSongId) return [];
  const start = snapshot.items.findIndex((it) => it && it.songId === fromSongId);
  if (start < 0) return [];
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : FLOW_MAX_ITEMS;
  return snapshot.items.slice(start, start + cap).filter((it) => !!it && !!it.songId);
}

/** ICY `StreamTitle` 取值：有艺术家给 `Artist - Title`（Winamp 约定），否则只有标题。 */
export function icyStreamTitle(title: string | undefined, artist?: string | null): string {
  const t = (title || "").replace(/[';\u0000]/g, "").trim();
  const a = (artist || "").replace(/[';\u0000]/g, "").trim();
  if (!t && !a) return "";
  return a && t ? `${a} - ${t}` : (t || a);
}

/**
 * ICY 元数据块（P3-5）：首字节 = 16 字节分片数，后跟 N×16 字节、右侧补 0 的
 * `StreamTitle='…';`。这是 ICY 协议的 wire 格式，**不是**随便塞一段字符串
 * —— 长度字节写错会让设备把音频字节当元数据长度读，直接爆音/静音。
 * 空标题返回 `Buffer.alloc(1)`（= 单个 0 长度字节），与"无更新"同义。
 */
export function icyMetadataBlock(title: string | undefined, artist?: string | null): Buffer {
  const streamTitle = icyStreamTitle(title, artist);
  if (!streamTitle) return Buffer.alloc(1);
  let payload = Buffer.from(`StreamTitle='${streamTitle}';`, "utf8");
  // 分片数 1 字节 → 最多 255×16 = 4080 字节；超长按字节截断（不切坏多字节字符也无所谓，
  // 元数据只是显示用，截断比让设备解析越界安全得多）。
  const maxBytes = 255 * 16;
  if (payload.length > maxBytes) payload = payload.subarray(0, maxBytes);
  const chunks = Math.ceil(payload.length / 16);
  const out = Buffer.alloc(1 + chunks * 16);
  out.writeUInt8(chunks, 0);
  payload.copy(out, 1);
  return out;
}

/** 缺省过渡时长（供调用方/测试引用，避免各处硬编码 8）。 */
export const FLOW_DEFAULT_FADE_SEC = FADE_DEFAULT_SEC;
