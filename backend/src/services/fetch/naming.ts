// MusicFetch 落盘命名：模板渲染 / 非法字符清理 / 相对路径构造 / 冲突处理。
//
// 目标结构（默认）：`歌手/专辑名/歌曲-歌手.mp3`（产品已确认）。
// 全部为纯函数（除 crypto 哈希外无 IO），便于单测覆盖非法字符、超长路径、多碟等分支。
import crypto from "node:crypto";

/** 命名上下文：由候选元数据 + 下载后探针填充。 */
export interface NamingCtx {
  title: string;
  artist?: string;
  artists?: string[];
  albumArtist?: string;
  album?: string;
  year?: number;
  track?: number;
  disc?: number;
  source?: string;
  bitDepth?: number;
  sampleRateHz?: number;
  bitrateKbps?: number;
}

/** 命名配置。 */
export interface NamingConfig {
  dirTemplate: string;
  fileTemplate: string;
  extFromContainer: boolean;
  illegalCharPolicy: "replace" | "remove" | "transliterate";
  illegalCharReplaceWith: string;
  trimTrailingDots: boolean;
  maxPathBytes: number;
  multiArtistSeparator: string;
  vaAlbumArtist: string;
  vaRootFolder: string;
  multiDiscStrategy: "merge" | "prefix" | "subdir";
  padTrackNumber: number;
}

/** 默认命名配置。 */
export const DEFAULT_NAMING_CONFIG: NamingConfig = {
  dirTemplate: "{albumArtist}/{album}",
  fileTemplate: "{title} - {artist}",
  extFromContainer: true,
  illegalCharPolicy: "replace",
  illegalCharReplaceWith: "_",
  trimTrailingDots: true,
  // 180 字节 ≈ 多数文件系统单段/单路径的安全线（中文占 3 字节，60 个汉字即触顶）。
  maxPathBytes: 180,
  multiArtistSeparator: "、",
  vaAlbumArtist: "Various Artists",
  vaRootFolder: "",
  multiDiscStrategy: "prefix",
  padTrackNumber: 2,
};

/** 可识别的音频容器（用于 {ext} 与 extFromContainer）。 */
const KNOWN_CONTAINERS: ReadonlySet<string> = new Set([
  "flac",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "ape",
  "wav",
  "alac",
  "aiff",
  "aif",
  "wma",
]);

/** Windows 保留字符 + 控制字符。 */
const ILLEGAL_CHARS: RegExp = /[\\/:*?"<>|\x00-\x1f\x7f]/g;

/** 悬挂分隔符（token 缺失后残留的连接符）。 */
const DANGLING_EDGE: RegExp = /^[\s\-—–·_]+|[\s\-—–·_]+$/g;
const DANGLING_MID: RegExp = /\s*[-—–]\s*[-—–]\s*/g;

/** 全角 → 半角（transliterate 策略用）：U+FF01~U+FF5E 与全角空格。 */
function toHalfWidth(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x3000) {
      out += " ";
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - 0xfee0);
    } else {
      out += ch;
    }
  }
  return out;
}

/** 按 UTF-8 字节数安全截断（按码点迭代，不切断代理对）。 */
function cutBytes(s: string, maxBytes: number): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/** 段级截断：超长时截断到 budget 并追加 '-' + 8 位 sha256 前缀哈希，保证唯一可追溯。 */
function fitSegment(s: string, budget: number): string {
  if (Buffer.byteLength(s, "utf8") <= budget) return s;
  const hash = crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
  const tail = `-${hash}`;
  const keep = budget - tail.length;
  if (keep < 8) return cutBytes(s, Math.max(1, budget));
  return cutBytes(s, keep) + tail;
}

/** 目录段总字节数（含段间斜杠）。 */
function segmentsBytes(segs: string[]): number {
  if (segs.length === 0) return 0;
  let n = Math.max(0, segs.length - 1);
  for (const s of segs) n += Buffer.byteLength(s, "utf8");
  return n;
}

/** 目录整体压到预算内：每次削掉当前最长的段，直至总量达标（削段会附哈希防碰撞）。 */
function shrinkSegments(segs: string[], budget: number): string[] {
  const out = [...segs];
  let guard = 0;
  while (segmentsBytes(out) > budget && guard++ < 64) {
    let idx = 0;
    for (let i = 1; i < out.length; i++) {
      if (Buffer.byteLength(out[i], "utf8") > Buffer.byteLength(out[idx], "utf8")) idx = i;
    }
    const overflow = segmentsBytes(out) - budget;
    const target = Math.max(8, Buffer.byteLength(out[idx], "utf8") - overflow - 9);
    out[idx] = fitSegment(out[idx], target);
  }
  return out;
}

/**
 * 单段清理：Windows 保留字符 \ / : * ? " < > | 与控制字符。
 * - replace → 替换为 illegalCharReplaceWith；
 * - remove → 直接删除；
 * - transliterate → 先全角转半角，再按 replace 处理；
 * trimTrailingDots 为真时去掉末尾的点与空格（Windows 下 'xxx.' 与 'xxx' 同名）。
 */
export function sanitizeSegment(s: string, cfg: NamingConfig): string {
  let out = s ?? "";
  if (cfg.illegalCharPolicy === "transliterate") out = toHalfWidth(out);
  if (cfg.illegalCharPolicy === "remove") {
    out = out.replace(ILLEGAL_CHARS, "");
  } else {
    out = out.replace(ILLEGAL_CHARS, cfg.illegalCharReplaceWith);
  }
  out = out.replace(/\s{2,}/g, " ").trim();
  if (cfg.trimTrailingDots) out = out.replace(/[.\s]+$/, "");
  return out;
}

/** 有效 albumArtist：albumArtist → artist → artists 拼接 → 'Unknown Artist'。 */
function effectiveAlbumArtist(ctx: NamingCtx, cfg: NamingConfig): string {
  const artists = ctx.artists && ctx.artists.length > 0 ? ctx.artists.join(cfg.multiArtistSeparator) : "";
  return ctx.albumArtist || ctx.artist || artists || "Unknown Artist";
}

/** 有效 artist：artist → artists 拼接。 */
function effectiveArtist(ctx: NamingCtx, cfg: NamingConfig): string {
  const artists = ctx.artists && ctx.artists.length > 0 ? ctx.artists.join(cfg.multiArtistSeparator) : "";
  return ctx.artist || artists;
}

/** {quality} 短标签：优先按位深判定无损，否则按比特率取整到 32 的倍数。 */
function qualityLabel(ctx: NamingCtx): string {
  if (ctx.bitDepth && ctx.bitDepth >= 24) return "HiRes";
  if (ctx.bitDepth && ctx.bitDepth >= 16) return "FLAC";
  if (ctx.bitrateKbps && ctx.bitrateKbps > 0) {
    const k = Math.max(32, Math.round(ctx.bitrateKbps / 32) * 32);
    return `${k}K`;
  }
  return "";
}

/** {ext}：仅当 ctx.source 是可识别容器时输出，否则空（配合空段消除可整段消去）。 */
function extFromSource(ctx: NamingCtx): string {
  const s = (ctx.source ?? "").toLowerCase().replace(/^\./, "");
  return KNOWN_CONTAINERS.has(s) ? s : "";
}

/** 曲目号格式化：宽度取字面量 :0Nd 的 N，否则取 cfg.padTrackNumber；宽度 <= 0 不输出。 */
function formatTrack(ctx: NamingCtx, cfg: NamingConfig, spec?: string): string {
  // padTrackNumber <= 0 表示「不要曲目号」,此时即使字面量写了 :02d 也不输出。
  if (!(cfg.padTrackNumber > 0)) return "";
  let width = cfg.padTrackNumber;
  if (spec) {
    const m = /^0?(\d+)d$/.exec(spec.trim());
    if (m) width = Number.parseInt(m[1], 10);
  }
  if (!(width > 0)) return "";
  const track = ctx.track ?? 0;
  if (!(track > 0)) return "";
  return String(track).padStart(width, "0");
}

/** 单个 token 的取值；缺失时返回空串，交由上层做「整段消去」。 */
function tokenValue(key: string, spec: string | undefined, ctx: NamingCtx, cfg: NamingConfig): string {
  switch (key) {
    case "artist":
      return effectiveArtist(ctx, cfg);
    case "artists":
      return (
        (ctx.artists && ctx.artists.length > 0 ? ctx.artists.join(cfg.multiArtistSeparator) : "") ||
        (ctx.artist ?? "")
      );
    case "albumArtist":
      return effectiveAlbumArtist(ctx, cfg);
    case "title":
      return ctx.title ?? "";
    case "album":
      return ctx.album || "Unknown Album";
    case "year":
      return ctx.year && ctx.year > 0 ? String(ctx.year) : "";
    case "track":
      return formatTrack(ctx, cfg, spec);
    case "disc":
      return ctx.disc && ctx.disc > 0 ? String(ctx.disc) : "";
    case "source":
      return ctx.source ?? "";
    case "quality":
      return qualityLabel(ctx);
    case "bitDepth":
      return ctx.bitDepth && ctx.bitDepth > 0 ? String(ctx.bitDepth) : "";
    case "sampleRateKHz":
      return ctx.sampleRateHz && ctx.sampleRateHz > 0 ? String(ctx.sampleRateHz / 1000) : "";
    case "ext":
      return extFromSource(ctx);
    default:
      return "";
  }
}

/** 消去 token 缺失产生的空括号组：'({year})' → '()' → ''（反复应用到稳定）。 */
function dropEmptyGroups(s: string): string {
  let out = s;
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out
      .replace(/\(\s*\)/g, "")
      .replace(/\[\s*\]/g, "")
      .replace(/\{\s*\}/g, "")
      .replace(/（\s*）/g, "")
      .replace(/【\s*】/g, "");
  }
  return out;
}

/** 收敛悬挂分隔符：'{title} - {artist}' 中 artist 缺失时不留下 ' - '。 */
function stripDangling(s: string): string {
  return s.replace(DANGLING_MID, " - ").replace(DANGLING_EDGE, "");
}

/**
 * 渲染命名模板。
 *
 * 支持的 token：{artist} {artists} {albumArtist} {title} {album} {year} {track}
 * {track:02d} {disc} {source} {quality} {bitDepth} {sampleRateKHz} {ext}。
 *
 * 关键行为：模板按 '/' 切段渲染，**某段渲染后为空则整段消去**，不留 '()'、不留空目录
 * 层级、不留连续斜杠。
 */
export function renderTemplate(tpl: string, ctx: NamingCtx, cfg: NamingConfig): string {
  const segments = String(tpl ?? "").split("/");
  const rendered = segments.map((seg) => {
    const substituted = seg.replace(/\{([a-zA-Z]+)(?::([^}]*))?\}/g, (_m, key: string, spec?: string) =>
      tokenValue(key, spec, ctx, cfg),
    );
    const cleaned = dropEmptyGroups(substituted);
    return sanitizeSegment(stripDangling(cleaned.replace(/\s{2,}/g, " ")), cfg);
  });
  return rendered.filter((s) => s.length > 0).join("/");
}

/** 归一化扩展名（去掉前导点、转小写）。 */
function normalizeExt(ext: string): string {
  return String(ext ?? "").replace(/^\./, "").toLowerCase();
}

/**
 * 构造相对路径（相对挂载根目录，如 '周杰伦/范特西/爱在西元前 - 周杰伦.mp3'）。
 *
 * 处理顺序：目录模板 → 文件模板 → 多碟策略 → 合辑集中目录 → 按 UTF-8 字节截断。
 * 截断**逐段**进行，且绝不切断文件名后缀。
 */
export function buildRelativePath(ctx: NamingCtx, cfg: NamingConfig, ext: string): string {
  const containerFromSource = extFromSource(ctx);
  const finalExt = cfg.extFromContainer && containerFromSource ? containerFromSource : normalizeExt(ext);

  const dirSegs = renderTemplate(cfg.dirTemplate, ctx, cfg)
    .split("/")
    .filter((s) => s.length > 0);

  let file = sanitizeSegment(renderTemplate(cfg.fileTemplate, ctx, cfg), cfg);

  // 多碟策略（仅 disc > 1 时生效：单碟专辑不需要前缀/子目录）
  if (ctx.disc && ctx.disc > 1) {
    if (cfg.multiDiscStrategy === "prefix") {
      const t = formatTrack(ctx, cfg);
      const prefix = t ? `${ctx.disc}-${t}` : `${ctx.disc}-`;
      file = `${prefix} ${file}`;
    } else if (cfg.multiDiscStrategy === "subdir") {
      dirSegs.push(`Disc ${ctx.disc}`);
    }
    // merge：忽略碟号
  }

  // 合辑集中目录
  let segs = dirSegs;
  if (cfg.vaRootFolder && effectiveAlbumArtist(ctx, cfg) === cfg.vaAlbumArtist) {
    const root = cfg.vaRootFolder
      .split("/")
      .filter((s) => s.trim().length > 0)
      .map((s) => sanitizeSegment(s, cfg));
    segs = [...root, ...segs];
  }

  // 截断：先压目录（给文件名留出最小 16 字节），再压文件名
  const MIN_BASE = 16;
  const suffixBytes = Buffer.byteLength(`.${finalExt}`, "utf8");
  const dirBudget = Math.max(MIN_BASE, cfg.maxPathBytes - suffixBytes - 1 - MIN_BASE);
  segs = shrinkSegments(segs, dirBudget);
  const prefixBytes = segs.length > 0 ? segmentsBytes(segs) + 1 : 0;
  const baseBudget = Math.max(MIN_BASE, cfg.maxPathBytes - prefixBytes - suffixBytes);
  const base = fitSegment(file, baseBudget);

  return [...segs, `${base}.${finalExt}`].join("/");
}

export type ConflictPolicy = "skip" | "overwrite" | "rename" | "keepBetter";

/**
 * 同名冲突处理。
 *
 * - skip：已存在则跳过；
 * - overwrite：已存在仍写入；
 * - rename：返回 'xxx (1).ext'（usedNames 中已有则递增到 (2)、(3)...）；
 * - keepBetter：newIsBetter 为真才写入，否则保留旧文件（action='keep'，调用方不动文件）。
 *
 * 说明：规格给出的入参未包含文件名，而 rename 需要它才能拼 '(1)'，故**新增可选字段
 * name**；未传 name 时 rename 退化为直接写入（无法改名）。
 */
export function resolveConflict(opts: {
  exists: boolean;
  policy: ConflictPolicy;
  newIsBetter?: boolean;
  usedNames?: Set<string>;
  name?: string;
}): { action: "write" | "skip" | "keep"; finalName?: string } {
  if (!opts.exists) return { action: "write" };
  switch (opts.policy) {
    case "skip":
      return { action: "skip" };
    case "overwrite":
      return { action: "write" };
    case "keepBetter":
      return opts.newIsBetter ? { action: "write" } : { action: "keep" };
    case "rename": {
      const name = opts.name ?? "";
      if (!name) return { action: "write" };
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let i = 1;
      while (opts.usedNames?.has(`${base} (${i})${ext}`)) i++;
      return { action: "write", finalName: `${base} (${i})${ext}` };
    }
    default:
      return { action: "write" };
  }
}
