// ==================== ③ Processing DSP：滤镜链构建（P4-1，照 MA `helpers/dsp.py`） ====================
//
// 六段流水线的第 ③ 段（docs/audio-pipeline-plan.md §3.3，范围按 **D6**：Gain / 3 段 ToneControl /
// 多段参量 EQ / Balance 四项）。② 段管「每首歌一样响」，③ 段管「按口味调音色」——
// 两者职责不同、不可互换：**UI 里的音量滑块是用户偏好，不属于流水线**；音色塑形放在服务端
// 才能对全部链路（含音箱类 DLNA / Sendspin 设备）生效。
//
// 本文件是**纯函数层**：配置 → ffmpeg `-af` 片段数组。零进程、零 IO、零 DB。
//
// MA 取证：`music-assistant/server` commit `76c2fcb`，`music_assistant/helpers/dsp.py`
// （`filter_to_ffmpeg_params` / `_pass_biquad_params`）。三处**与 plan §3.3 表格不同**的地方
// 已按源码改正（表格是简化版，以源码为准）：
//   ① ToneControl 三段各自的 width 是 200 / **1800** / **18000**（表格只给了低段那个 200）；
//   ② 任何一段电平为 0 → **该段不加滤镜**（不是加个 gain=0）；
//   ③ Balance 在**单声道源**上另有一套写法（mono 没有 FL/FR 可 pan，改用 `pan=stereo|FL=…*c0`）。
//
// 为什么参量 EQ 必须自己算 `biquad` 系数、不能拿 ffmpeg 的 `equalizer` 顶替：
// `equalizer` 的带宽口径是 `width_type`（h/q/o...），与 MA 用的 Cookbook Q（`alpha = sin(w0)/(2q)`）
// 不是一回事 —— Q 值不一致，同一份配置在两边的听感就不同。

/** 一帧内的声道命名（对齐 MA `AudioChannel`；只用得到这三种）。 */
export type DspChannel = "all" | "FL" | "FR";

/** 参量 EQ 单段类型（MA `ParametricEQBandType` 里本轮会用到的全部六个）。 */
export type EqBandType = "peak" | "low_shelf" | "high_shelf" | "high_pass" | "low_pass" | "notch";

export interface EqBand {
  type: EqBandType;
  /** 中心/截止频率（Hz）。 */
  frequency: number;
  /** 增益（dB）；PEAK / 两个 SHELF 用得上，其余忽略。 */
  gainDb?: number;
  /** Q 值（`alpha = sin(w0)/(2Q)`）。 */
  q?: number;
  /** 缺省启用；false = 该段跳过。 */
  enabled?: boolean;
  /** 缺省 `all`；非 all 时加 `:c=<channel>` 只作用于该声道。 */
  channel?: DspChannel;
}

/** 三段音色（MA `ToneControlFilter`）。0 = 该段不生效（不加滤镜）。 */
export interface ToneControlConfig {
  /** 低频（100 Hz，width 200 Hz，`width_type=h`）。 */
  bassDb?: number;
  /** 中频（900 Hz，width 1800 Hz）。 */
  midDb?: number;
  /** 高频（9000 Hz，width 18000 Hz）。 */
  trebleDb?: number;
}

/**
 * per-player DSP 配置（D6 四项）。**空配置 = 零滤镜**（成功标准 2）——
 * 不往 ffmpeg 链里塞任何 `-af`，与不做 DSP 时逐字节一致。
 */
export interface DspConfig {
  /** 前置增益（dB），链首（MA `ParametricEQFilter.preamp`）。 */
  preampDb?: number;
  /**
   * 每声道前置增益（dB）。任一非 0 时**改用它**而不用 `preampDb`：
   * ffmpeg 的 `volume` 只能整条流一起动，分声道要靠 `pan`（MA 源码注释同此）。
   */
  perChannelPreampDb?: { FL?: number; FR?: number };
  tone?: ToneControlConfig;
  parametricEq?: { bands?: EqBand[] };
  /** 左右平衡（-100 = 全左 … +100 = 全右）。**只衰减**，不做正增益。 */
  balance?: number;
  /** 输出级增益（dB），链尾。 */
  gainDb?: number;
}

export interface DspFormat {
  sampleRate: number;
  channels: number;
}

/**
 * DSP 滤镜段的**锚定采样率**（biquad 系数与采样率绑定，必须先定下来）。
 *
 * MA 是拿**每首歌真实的** AudioFormat 现算系数（`filter_to_ffmpeg_params(dsp_filter,
 * input_format)`），我们没有那条"起播前已知实际格式"的通道（webdav/本地/在线源的
 * 实际采样率要么得 ffprobe 一次、要么由 ffmpeg 自己发现）。所以这里固定一个锚定值，
 * 调用方在链首补一条 `aresample=<锚定值>` —— **结果是精确的**，不是"近似按 48k 算"。
 * 锚定值取 48000 与 flow 会话（P3 解码段强制 `-ar 48000`）对齐，flow 里就不必再补 resample。
 */
export const DSP_FILTER_RATE = 48000;

/** MA 的三段音色常量（`helpers/dsp.py` 里硬编码的三个 frequency/width 对）。 */
export const TONE_BANDS: ReadonlyArray<{ key: "bassDb" | "midDb" | "trebleDb"; frequency: number; width: number }> = [
  { key: "bassDb", frequency: 100, width: 200 },
  { key: "midDb", frequency: 900, width: 1800 },
  { key: "trebleDb", frequency: 9000, width: 18000 },
];

/**
 * 数字 → 滤镜参数里的稳定文本。
 * JS 的 `String(1)` 是 `"1"`、Python 的 `f"{1.0}"` 是 `"1.0"` —— 两边都能被 ffmpeg 解析，
 * 但**字符串没法拿来当契约断言**，所以这里统一定成「最多 10 位小数、去掉尾随 0」。
 */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

/** dB → 线性幅度（MA 用 `10 ** (db/20)`）。 */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** 归一化角频率 `w0 = 2π·f/fs`（MA `w_0 = 2 * math.pi * f_0 / f_s`）。 */
export function omega(frequency: number, sampleRate: number): number {
  return (2 * Math.PI * frequency) / sampleRate;
}

/** Cookbook 的 `alpha = sin(w0)/(2Q)`（Q ≤ 0 时退回 1，避免除零把整条链变成 NaN）。 */
export function alphaOf(w0: number, q: number): number {
  const qq = Number.isFinite(q) && q > 0 ? q : 1;
  return Math.sin(w0) / (2 * qq);
}

/** 拼一条 `biquad=` 片段（MA 六种类型共用同一形状，字段顺序也照抄）。 */
function biquad(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number, channels = ""): string {
  return `biquad=b0=${fmtNum(b0)}:b1=${fmtNum(b1)}:b2=${fmtNum(b2)}:a0=${fmtNum(a0)}:a1=${fmtNum(a1)}:a2=${fmtNum(a2)}${channels}`;
}

/** PEAK（Cookbook peaking EQ）：用 `a = sqrt(10^(gain/20))` 把增益折进 alpha 项。 */
export function biquadPeak(frequency: number, gainDb: number, q: number, sampleRate: number, channels = ""): string {
  const w0 = omega(frequency, sampleRate);
  const a = Math.sqrt(dbToGain(gainDb));
  const alpha = alphaOf(w0, q);
  return biquad(
    1 + alpha * a,
    -2 * Math.cos(w0),
    1 - alpha * a,
    1 + alpha / a,
    -2 * Math.cos(w0),
    1 - alpha / a,
    channels,
  );
}

/** LOW_SHELF（Cookbook low shelf）。 */
export function biquadLowShelf(frequency: number, gainDb: number, q: number, sampleRate: number, channels = ""): string {
  const w0 = omega(frequency, sampleRate);
  const a = Math.sqrt(dbToGain(gainDb));
  const alpha = alphaOf(w0, q);
  const sqrtA = Math.sqrt(a);
  const cosW0 = Math.cos(w0);
  return biquad(
    a * (a + 1 - (a - 1) * cosW0 + 2 * sqrtA * alpha),
    2 * a * (a - 1 - (a + 1) * cosW0),
    a * (a + 1 - (a - 1) * cosW0 - 2 * sqrtA * alpha),
    a + 1 + (a - 1) * cosW0 + 2 * sqrtA * alpha,
    -2 * (a - 1 + (a + 1) * cosW0),
    a + 1 + (a - 1) * cosW0 - 2 * sqrtA * alpha,
    channels,
  );
}

/** HIGH_SHELF（Cookbook high shelf）。 */
export function biquadHighShelf(frequency: number, gainDb: number, q: number, sampleRate: number, channels = ""): string {
  const w0 = omega(frequency, sampleRate);
  const a = Math.sqrt(dbToGain(gainDb));
  const alpha = alphaOf(w0, q);
  const sqrtA = Math.sqrt(a);
  const cosW0 = Math.cos(w0);
  return biquad(
    a * (a + 1 + (a - 1) * cosW0 + 2 * sqrtA * alpha),
    -2 * a * (a - 1 + (a + 1) * cosW0),
    a * (a + 1 + (a - 1) * cosW0 - 2 * sqrtA * alpha),
    a + 1 - (a - 1) * cosW0 + 2 * sqrtA * alpha,
    2 * (a - 1 - (a + 1) * cosW0),
    a + 1 - (a - 1) * cosW0 - 2 * sqrtA * alpha,
    channels,
  );
}

/** NOTCH（Cookbook notch；b0/b2 恒为 1）。 */
export function biquadNotch(frequency: number, q: number, sampleRate: number, channels = ""): string {
  const w0 = omega(frequency, sampleRate);
  const alpha = alphaOf(w0, q);
  const cosW0 = Math.cos(w0);
  return biquad(1, -2 * cosW0, 1, 1 + alpha, -2 * cosW0, 1 - alpha, channels);
}

/** HIGH_PASS / LOW_PASS 单节（MA `_pass_biquad_params`；级联的 Butterworth 各节只差 Q）。 */
export function biquadPass(
  opts: { mode: "highpass" | "lowpass"; frequency: number; q: number; sampleRate: number; channels?: string },
): string {
  const w0 = omega(opts.frequency, opts.sampleRate);
  const alpha = alphaOf(w0, opts.q);
  const cosW0 = Math.cos(w0);
  const high = opts.mode === "highpass";
  const b0 = high ? (1 + cosW0) / 2 : (1 - cosW0) / 2;
  const b1 = high ? -(1 + cosW0) : 1 - cosW0;
  const b2 = high ? (1 + cosW0) / 2 : (1 - cosW0) / 2;
  return biquad(b0, b1, b2, 1 + alpha, -2 * cosW0, 1 - alpha, opts.channels ?? "");
}

/** 单段参量 EQ → 滤镜片段（`enabled === false` 时返回 null）。 */
export function eqBandFilter(band: EqBand, sampleRate: number): string | null {
  if (band.enabled === false) return null;
  if (!Number.isFinite(band.frequency) || band.frequency <= 0) return null;
  const channels = band.channel && band.channel !== "all" ? `:c=${band.channel}` : "";
  const gain = Number.isFinite(band.gainDb) ? (band.gainDb as number) : 0;
  const q = Number.isFinite(band.q) ? (band.q as number) : 1;
  switch (band.type) {
    case "peak":
      return biquadPeak(band.frequency, gain, q, sampleRate, channels);
    case "low_shelf":
      return biquadLowShelf(band.frequency, gain, q, sampleRate, channels);
    case "high_shelf":
      return biquadHighShelf(band.frequency, gain, q, sampleRate, channels);
    case "notch":
      return biquadNotch(band.frequency, q, sampleRate, channels);
    case "high_pass":
      return biquadPass({ mode: "highpass", frequency: band.frequency, q, sampleRate, channels });
    case "low_pass":
      return biquadPass({ mode: "lowpass", frequency: band.frequency, q, sampleRate, channels });
    default:
      return null;
  }
}

/** 非 0 的有限数；其余（含 NaN / undefined）一律 0。 */
function nz(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 配置里是否真有要做的事（空配置 → 调用方连 `-af` 都不加）。 */
export function hasDspWork(cfg: DspConfig | null | undefined): boolean {
  if (!cfg) return false;
  if (nz(cfg.preampDb) !== 0) return true;
  if (nz(cfg.perChannelPreampDb?.FL) !== 0 || nz(cfg.perChannelPreampDb?.FR) !== 0) return true;
  if (nz(cfg.gainDb) !== 0) return true;
  if (nz(cfg.balance) !== 0) return true;
  if (TONE_BANDS.some((b) => nz(cfg.tone?.[b.key]) !== 0)) return true;
  if ((cfg.parametricEq?.bands ?? []).some((b) => b && b.enabled !== false)) return true;
  return false;
}

/**
 * 配置 → ffmpeg `-af` 片段数组。
 *
 * 顺序（成功标准 2 的「preamp → filters → output gain」）：
 *   preamp（或分声道 pan） → 三段音色 → 参量 EQ → Balance → 输出增益
 *
 * `grouped === true` 时**整体返回空**：与 MA 一致，播放器成组后 per-player DSP 被禁用
 * （plan §3.3 的 ⚠️）—— 成组的音色由组的输出统一决定，成员各自染一遍会四次叠加。
 *
 * 空配置 / 全部为 0 → `[]`（**零开销**：调用方不加 `-af`，与不做 DSP 的命令逐字节一致）。
 */
export function buildFilterChain(
  cfg: DspConfig | null | undefined,
  format: DspFormat,
  opts: { grouped?: boolean } = {},
): string[] {
  if (!cfg || opts.grouped === true) return [];
  if (!hasDspWork(cfg)) return [];
  const sampleRate = Number.isFinite(format.sampleRate) && format.sampleRate > 0 ? format.sampleRate : 44100;
  const channels = Number.isFinite(format.channels) && format.channels > 0 ? Math.floor(format.channels) : 2;
  const out: string[] = [];

  // ---- 链首：前置增益（分声道优先，因为 volume 只能整条流一起动）----
  // MA 的分声道写法：每声道总增益 = 全局 preamp + 该声道自己的；总增益为 0 的声道写成恒等
  // （`FL=FL`，不是 `FL=1*FL`）—— 文案与 MA 逐字符一致，避免"看起来等价但 diff 出来不同"。
  const fl = nz(cfg.perChannelPreampDb?.FL);
  const fr = nz(cfg.perChannelPreampDb?.FR);
  const hasPerChannel = fl !== 0 || fr !== 0;
  const preamp = nz(cfg.preampDb);
  if (hasPerChannel) {
    const chan = (v: number, name: "FL" | "FR") => {
      const total = preamp + v;
      return total === 0 ? name : `${flap(total)}*${name}`;
    };
    out.push(`pan=stereo|FL=${chan(fl, "FL")}|FR=${chan(fr, "FR")}`);
  } else if (preamp !== 0) {
    out.push(`volume=${fmtNum(preamp)}dB`);
  }

  // ---- 三段音色（0 = 该段不加；width 常量照 MA）----
  for (const band of TONE_BANDS) {
    const level = nz(cfg.tone?.[band.key]);
    if (level === 0) continue;
    out.push(`equalizer=frequency=${band.frequency}:width=${band.width}:width_type=h:gain=${fmtNum(level)}`);
  }

  // ---- 多段参量 EQ ----
  for (const b of cfg.parametricEq?.bands ?? []) {
    if (!b) continue;
    const f = eqBandFilter(b, sampleRate);
    if (f) out.push(f);
  }

  // ---- Balance（**只衰减**：不做正增益 ⇒ 不把已归一化的信号再推出 headroom）----
  // ⚠️ 这里的 `attenuation` 是**线性系数**（MA 就是这么算的），不是 dB —— 千万别套 `flap()`
  // （那是 dB→线性）。写成 `flap(att)` 会得到 `1*FL`（0.7 dB ≈ 1.08 → 反而变成正增益），
  // 与"只衰减"完全相反。
  const balance = Math.max(-100, Math.min(100, nz(cfg.balance)));
  if (balance !== 0) {
    const attenuation = fmtNum((100 - Math.abs(balance)) / 100);
    if (channels === 2) {
      out.push(
        balance > 0
          ? `pan=stereo|FL=${attenuation}*FL|FR=FR`
          : `pan=stereo|FL=FL|FR=${attenuation}*FR`,
      );
    } else if (channels === 1) {
      out.push(
        balance > 0
          ? `pan=stereo|FL=${attenuation}*c0|FR=c0`
          : `pan=stereo|FL=c0|FR=${attenuation}*c0`,
      );
    }
  }

  // ---- 链尾：输出增益 ----
  const gain = nz(cfg.gainDb);
  if (gain !== 0) out.push(`volume=${fmtNum(gain)}dB`);

  return out;
}

/** dB → 线性（pan 的系数）；钳到 ≤ 1 的上界不存在，但非有限值一律按 1（不衰减）。 */
function flap(db: number): string {
  if (!Number.isFinite(db)) return "1";
  return fmtNum(dbToGain(db));
}

// ==================== 配置归一化（P4-2：DB 里存的是 JSON 文本，读出来必须先过这一关） ====================

const EQ_TYPES: ReadonlySet<string> = new Set<EqBandType>([
  "peak",
  "low_shelf",
  "high_shelf",
  "high_pass",
  "low_pass",
  "notch",
]);

/**
 * 任意输入（`JSON.parse` 的结果 / API 请求体）→ 干净的 `DspConfig`，无效则 `null`。
 *
 * 为什么必须归一化而不直接信 JSON：配置来自前端表单与客户端，字段可能是字符串、
 * 缺字段、或手改过；**坏值不能变成 NaN 混进 ffmpeg 命令**（`biquad=b0=NaN` 会让
 * ffmpeg 直接失败、整条流断掉，而用户只会看到"这首歌放不出来"）。
 * 归一化后仍然"没有活"（全 0 / 空段）→ 返回 `null`，调用方按无 DSP 处理（零滤镜）。
 */
export function normalizeDspConfig(raw: unknown): DspConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, any>;
  const out: DspConfig = {};

  const finite = (v: unknown): number | undefined => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  };

  const preamp = finite(src.preampDb);
  if (preamp !== undefined && preamp !== 0) out.preampDb = preamp;

  const pc = src.perChannelPreampDb;
  if (pc && typeof pc === "object") {
    const FL = finite(pc.FL);
    const FR = finite(pc.FR);
    if ((FL !== undefined && FL !== 0) || (FR !== undefined && FR !== 0)) {
      out.perChannelPreampDb = { ...(FL ? { FL } : {}), ...(FR ? { FR } : {}) };
    }
  }

  const toneSrc = src.tone;
  if (toneSrc && typeof toneSrc === "object") {
    const tone: ToneControlConfig = {};
    for (const band of TONE_BANDS) {
      const v = finite((toneSrc as any)[band.key]);
      if (v !== undefined && v !== 0) tone[band.key] = v;
    }
    if (Object.keys(tone).length > 0) out.tone = tone;
  }

  const bandsSrc = src.parametricEq && typeof src.parametricEq === "object" ? (src.parametricEq as any).bands : undefined;
  if (Array.isArray(bandsSrc)) {
    const bands: EqBand[] = [];
    for (const b of bandsSrc) {
      if (!b || typeof b !== "object") continue;
      const type = String((b as any).type ?? "");
      if (!EQ_TYPES.has(type)) continue;
      const frequency = finite((b as any).frequency);
      if (frequency === undefined || frequency <= 0) continue;
      const gainDb = finite((b as any).gainDb);
      const q = finite((b as any).q);
      const channel = (b as any).channel;
      bands.push({
        type: type as EqBandType,
        frequency,
        ...(gainDb !== undefined ? { gainDb } : {}),
        ...(q !== undefined && q > 0 ? { q } : {}),
        ...((b as any).enabled === false ? { enabled: false } : {}),
        ...(channel === "FL" || channel === "FR" ? { channel } : {}),
      });
    }
    // 全 disabled 的段等于没配置（`hasDspWork` 也这么判），故按"有启用段"决定是否留下
    if (bands.some((b) => b.enabled !== false)) out.parametricEq = { bands };
  }

  const balance = finite(src.balance);
  if (balance !== undefined && balance !== 0) {
    out.balance = Math.max(-100, Math.min(100, balance));
  }

  const gain = finite(src.gainDb);
  if (gain !== undefined && gain !== 0) out.gainDb = gain;

  return hasDspWork(out) ? out : null;
}

