// ==================== per-player 输出格式配置（采样率 + 位深，batch48/batch49） ====================
//
// 【采样率】背景：v4.2.3 把 HTTP/DLNA 转码链的降采样回落**写死成 48k**
// （`routes/rest/index.ts` 的 `resolveRequestAf` 里 `aresample=resampler=swr:osr=48000`）。
// 它治好了「loudnorm 恒上采样 192kHz → 高采样率流直喂设备 → 变速变调」，
// 但也把**真支持 96K/192K 的设备**一刀切按 48K 出流（无谓降级）。本模块提供
// 「每台播放器一个目标采样率」，出流侧按它裁决；**缺省仍 48000**
// （与 v4.2.3 行为逐字节一致 ⇒ 存量设备零变化、零破坏）。
//
// 三个来源，优先级 **手动 > 自动探测 > 缺省 48000**：
//   - 手动：设置面板选的档位（`RATE_OPTIONS` 白名单，防手滑填非法值）；
//   - 探测：Sendspin 设备在 `client/hello` 的 `player@v1_support.supported_formats`
//     里**按「编码×声道」逐条**上报 `sample_rate`（真机实测，见 `sendspin/server.ts`
//     的 `parseHelloSupportedFormats`）→ 取其中最大值；
//   - 缺省：48000。
//
// **DLNA 侧探测无解**（这不是实现偷懒，是协议没有）：UPnP/DLNA 的
// `description.xml` 只给 `X_DLNADOC`（DMR-1.50 之类规范版本号），能力清单接口
// `ConnectionManager#GetProtocolInfo` 的 Sink 列表只报 mime + `DLNA.ORG_PN`
// 编码档位（MP3/LPCM/FLAC…），**不编码采样率**。240 真机实测 H5MKII(Linkplay)
// 返回 20 条 audio 协议项，无一条带 rate；规范层唯一可能带 rate 的只有
// L16/LPCM 的第四字段（`audio/L16;rate=44100`），实际生态无人使用。
// 故 DLNA 只走「手动 + 缺省」。
//
// 【位深】与采样率**不是一回事**，它有两个「自动」候选，本模块选的是后者：
//   - 设备宣告（sendspin 的 `client/hello` 里确有 `bit_depth`）—— 但设备声明的
//     是**它自己编码给上位机**的位深，跟「我们出流给它多少位」没有必然关系；
//   - **跟随源位深**（本模块采用）：16bit 源出 16bit、24bit 源出 24bit。
// 为什么必须显式指定：链里有 `loudnorm`，它内部走浮点 ⇒ 不显式指定时
// **编码器恒吃 f32，FLAC 于是恒落 24bit**（230 实测：16bit 源经线上链出参
// `s32 (24 bit)`）。所以「跟随源位深」= 把源位深换算成 `osf=s16`/`osf=s32`
// 挂到出流侧那条 `aresample` 上（见 `routes/rest/index.ts` 的 `resolveRequestAf`），
// 230 同链实测：`osf=s16:dither_method=triangular_hp` → 出参 `s16`，**体积减半**。
// 位深只在**无损链路**（flac / LPCM）有意义；mp3/aac/opus 是有损，给不给都无意义。
//
// 群组：同一组的音频必须**同一个采样率/位深**（members 要同步、flow 连续流内部
// 更不能变速）→ 取成员设备里**最低**的那个（木桶原理）。设备成组后按组算，
// 独立播放按自己算；显式传 `group:<gid>` 也按该组成员算。
// 位深取「最低」时**跳过 null（=跟随源）**：跟随源本身会自适应，不该把组钉死。
//
// AirPlay 不参与：RAOP 协议锁 44100/16bit（见 `services/airplay/raop.ts`），
// 前端对 `airplay:` peer 不显示本项。
//
// 落点说明：与 `playerDsp.ts` / `sendspin_device_state` 同理，**按设备全局**
// （不是按用户）—— 采样率/位深是设备硬件属性，换个账号登进来不该换一套。
// 读路径必须**永不抛**（它在出流热路径上：读失败 = 这首歌放不出来，而用户只想听歌）；
// 写路径要抛（设置面板保存失败必须能回 500）。
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { playerOutputConfigs } from "../db/schema.js";
import { getGroupManager } from "./group/index.js";

/** 手动采样率档位白名单（下拉选项，防手滑）。顺序即界面顺序。 */
export const RATE_OPTIONS: readonly number[] = [48000, 88200, 96000, 176400, 192000];

/** 手动位深档位白名单。null（不在表里）表示「自动 = 跟随源位深」。 */
export const BITS_OPTIONS: readonly number[] = [16, 24];

/** 缺省目标采样率（= v4.2.3 的硬编码值，存量行为不变）。 */
export const DEFAULT_TARGET_RATE = 48000;

/** 探测值的可接受区间（设备宣告什么就信什么，但离谱值不入库）。 */
export const MIN_PROBED_RATE = 8000;
export const MAX_PROBED_RATE = 192000;

/** 库里 0 = 「未设置」（与 `sendspin_device_state.esphome_port` 同一约定）。 */
const UNSET = 0;

export interface PlayerRateConfig {
  /** 用户手动设置的目标采样率（白名单档位）；null = 未设置。 */
  manualRate: number | null;
  /** 设备 `client/hello` 自动宣告的采样率；null = 未探测过 / 设备未宣告。 */
  probedRate: number | null;
  /** 用户手动设置的位深（16/24）；null = 自动（跟随源位深）。 */
  manualBits: number | null;
}

/**
 * 归一化**手动**采样率档位：只认 `RATE_OPTIONS` 里的严格命中（数字或数字字符串）。
 * 不吸附到最近档 —— 这是「设置面板的下拉值」，非法值只可能来自手改 API，
 * 吸附会把「传错了」伪装成「设置成功」。取不到 → null（= 清除手动设置）。
 */
export function normalizeTargetRate(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return RATE_OPTIONS.includes(r) ? r : null;
}

/** 归一化**手动**位深：只认 16 / 24。取不到 → null（= 自动，跟随源位深）。 */
export function normalizeTargetBits(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const b = Math.round(n);
  return BITS_OPTIONS.includes(b) ? b : null;
}

/**
 * 源位深 → 我们的目标位深归档。源位深可能来自 `music-metadata`
 * （16 / 24 / 32 都见过，MP3 之类有损甚至拿不到），统一归到 16 或 24：
 * 20 位以上算 24（FLAC 上限就是 24），拿不到 → null（= 不干预，保持缺省行为）。
 */
export function classifySourceBits(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 8) return null;
  return n >= 20 ? 24 : 16;
}

/**
 * 归一化**探测**值：设备宣告什么就信什么（ESPHome `sample_rate` 允许 16000~96000
 * 的任意整数，不限于我们的五档），只挡明显非法的值。取不到 → null。
 */
export function normalizeProbedRate(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (r < MIN_PROBED_RATE || r > MAX_PROBED_RATE) return null;
  return r;
}

/** 读某台设备的输出格式配置。无行 / 表未就绪 / 坏数据一律回「都没设」（**绝不抛**）。 */
export function getPlayerRateConfig(peerId: string): PlayerRateConfig {
  const empty: PlayerRateConfig = { manualRate: null, probedRate: null, manualBits: null };
  if (!peerId) return empty;
  try {
    const row = db.select().from(playerOutputConfigs).where(eq(playerOutputConfigs.peerId, peerId)).get();
    if (!row) return empty;
    return {
      manualRate: normalizeTargetRate(row.manualRate || UNSET),
      probedRate: normalizeProbedRate(row.probedRate || UNSET),
      manualBits: normalizeTargetBits(row.manualBits || UNSET),
    };
  } catch {
    return empty;
  }
}

/**
 * 写手动设置。`raw` 可为 `{ rate?, bits? }` 形状或裸值（裸值 = 只改采样率，
 * 兼容 batch48 的调用与用例）。
 *
 * 键的语义是**「缺席 = 不动」**：只提交 `rate` 不会把位深冲掉（设置面板的
 * 两个下拉各自有独立的一次 PUT 场景），显式给 `null` / 空串才是「清除」。
 * 归一化后为 null（= 清除）时只清对应列（**保留 probedRate** —— 探测值不是
 * 用户设的，不该被顺手抹掉）；三列都空 → 删行，避免库里留一堆空行
 * （与 `setPlayerDspConfig` 同纪律）。写失败**不吞**（设置面板要能回 500）。
 */
export function setPlayerRate(peerId: string, raw: unknown): PlayerRateConfig {
  if (!peerId) return { manualRate: null, probedRate: null, manualBits: null };
  const isObj = raw !== null && typeof raw === "object";
  const hasRateKey = isObj ? "rate" in (raw as any) : true;
  const hasBitsKey = isObj ? "bits" in (raw as any) : false;
  const rateInput = isObj ? (raw as any).rate : raw;
  const bitsInput = isObj ? (raw as any).bits : undefined;

  const now = new Date().toISOString();
  const existing = getPlayerRateRaw(peerId);
  const prevManualRate = normalizeTargetRate(existing?.manualRate || UNSET);
  const prevManualBits = normalizeTargetBits(existing?.manualBits || UNSET);
  const probed = existing?.probedRate ?? UNSET;

  const manualRate = hasRateKey ? (normalizeTargetRate(rateInput) ?? UNSET) : (prevManualRate ?? UNSET);
  const manualBits = hasBitsKey ? (normalizeTargetBits(bitsInput) ?? UNSET) : (prevManualBits ?? UNSET);

  if (manualRate === UNSET && manualBits === UNSET && probed === UNSET) {
    db.delete(playerOutputConfigs).where(eq(playerOutputConfigs.peerId, peerId)).run();
    return { manualRate: null, probedRate: null, manualBits: null };
  }
  const values = { peerId, manualRate, probedRate: probed, manualBits, updatedAt: now };
  db.insert(playerOutputConfigs)
    .values(values)
    .onConflictDoUpdate({
      target: playerOutputConfigs.peerId,
      set: { manualRate: values.manualRate, manualBits: values.manualBits, updatedAt: now },
    })
    .run();
  return {
    manualRate: normalizeTargetRate(manualRate),
    probedRate: normalizeProbedRate(probed),
    manualBits: normalizeTargetBits(manualBits),
  };
}

/**
 * 记录设备自动宣告的采样率（sendspin `client/hello`）。**绝不抛** ——
 * 它跑在握手路径上，探测记账失败绝不能把设备拒之门外。
 * 值没变就不写（设备每次重连都会 hello，避免无意义写放大）。返回是否真的变了。
 */
export function recordProbedRate(peerId: string, raw: unknown): boolean {
  const rate = normalizeProbedRate(raw);
  if (!peerId || rate === null) return false;
  try {
    const existing = getPlayerRateRaw(peerId);
    if (existing?.probedRate === rate) return false;
    const now = new Date().toISOString();
    const values = {
      peerId,
      manualRate: existing?.manualRate ?? UNSET,
      manualBits: existing?.manualBits ?? UNSET,
      probedRate: rate,
      updatedAt: now,
    };
    db.insert(playerOutputConfigs)
      .values(values)
      .onConflictDoUpdate({
        target: playerOutputConfigs.peerId,
        set: { probedRate: rate, updatedAt: now },
      })
      .run();
    return true;
  } catch {
    return false;
  }
}

/** 全部非空配置（设置面板一次拿全，省 N 次请求）。读失败回空表。 */
export function listPlayerRateConfigs(): Record<string, PlayerRateConfig> {
  const out: Record<string, PlayerRateConfig> = {};
  try {
    for (const r of db.select().from(playerOutputConfigs).all()) {
      const manualRate = normalizeTargetRate(r.manualRate || UNSET);
      const probedRate = normalizeProbedRate(r.probedRate || UNSET);
      const manualBits = normalizeTargetBits(r.manualBits || UNSET);
      if (manualRate === null && probedRate === null && manualBits === null) continue;
      out[r.peerId] = { manualRate, probedRate, manualBits };
    }
  } catch {
    /* 表未就绪 → 空表 */
  }
  return out;
}

/** 单台设备的目标采样率（**不考虑群组**）：手动 > 探测 > 缺省 48000。 */
export function resolveDeviceRate(peerId: string | null | undefined): number {
  if (!peerId) return DEFAULT_TARGET_RATE;
  const cfg = getPlayerRateConfig(peerId);
  return cfg.manualRate ?? cfg.probedRate ?? DEFAULT_TARGET_RATE;
}

/** 单台设备的目标位深（**不考虑群组**）；null = 自动（跟随源位深）。 */
export function resolveDeviceBits(peerId: string | null | undefined): number | null {
  if (!peerId) return null;
  return getPlayerRateConfig(peerId).manualBits;
}

/**
 * 出流侧唯一入口：`peerId` → 本次出流的目标采样率。
 *
 * 设备成组时取**成员设备的最低值**（组内必须同率，见文件头）；独立设备就是自己。
 * 任何一步失败（组服务未初始化 / DB 未就绪）一律回退成「按自己算」，
 * 绝不因为算不出组就放不出声。
 */
export function resolveTargetSampleRate(peerId: string | null | undefined): number {
  if (!peerId) return DEFAULT_TARGET_RATE;
  const scope = rateScope(peerId);
  let min = 0;
  for (const p of scope) {
    const r = resolveDeviceRate(p);
    if (min === 0 || r < min) min = r;
  }
  return min || DEFAULT_TARGET_RATE;
}

/**
 * 出流侧唯一入口：`peerId` → 本次出流的目标位深；**null = 自动（跟随源位深）**。
 *
 * 成组取成员最低值，但**跳过 null**：null 是「跟随源」，本身自适应，
 * 把组钉死在一个具体位深反而是过约束；只有成员里真有显式档位时才取其中最低。
 */
export function resolveTargetBits(peerId: string | null | undefined): number | null {
  if (!peerId) return null;
  const scope = rateScope(peerId);
  let min = 0;
  for (const p of scope) {
    const b = resolveDeviceBits(p);
    if (b !== null && (min === 0 || b < min)) min = b;
  }
  return min || null;
}

/** 参与「取最低」的设备 peerId 集合（含自己）。 */
export function rateScope(peerId: string): string[] {
  if (!peerId) return [];
  try {
    const gm = getGroupManager();
    if (peerId.startsWith("group:")) {
      const g = gm.get(peerId.slice("group:".length));
      if (!g) return [peerId];
      const out = g.memberIds.map(memberToPeerId).filter((p): p is string => !!p);
      return out.length > 0 ? out : [peerId];
    }
    // 只有 DLNA / Sendspin 能进组（见 group/index.ts 的 GroupMemberKind）。
    if (!peerId.startsWith("dlna:") && !peerId.startsWith("sendspin:")) return [peerId];
    const bare = peerId.slice(peerId.indexOf(":") + 1);
    const gids = gm.groupsOfDevice(bare);
    if (gids.length === 0) return [peerId];
    const set = new Set<string>([peerId]);
    for (const gid of gids) {
      for (const m of gm.get(gid)?.memberIds ?? []) {
        const p = memberToPeerId(m);
        if (p) set.add(p);
      }
    }
    return [...set];
  } catch {
    return [peerId];
  }
}

/** 组成员 id（裸 id ≡ DLNA / `dlna:` / `sendspin:`）→ peerId；其它 → null。 */
function memberToPeerId(m: unknown): string | null {
  if (typeof m !== "string" || !m) return null;
  if (m.startsWith("sendspin:") || m.startsWith("dlna:")) return m;
  if (m.startsWith("group:") || m.startsWith("local:") || m.startsWith("airplay:")) return null;
  return `dlna:${m}`; // 裸 id = 历史数据，视为 DLNA（与 group/index.ts 同口径）
}

/** 裸读一行（不做归一化），供写路径判「是否需要写」。 */
function getPlayerRateRaw(peerId: string) {
  try {
    return db.select().from(playerOutputConfigs).where(eq(playerOutputConfigs.peerId, peerId)).get() ?? null;
  } catch {
    return null;
  }
}
