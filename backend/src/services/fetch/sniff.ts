// ==================== 音频内容嗅探（按字节判容器，不信扩展名/信源声明） ====================
//
// 为什么单独成模块：`sniffMagic` 原本住在 `integrity.ts`，同时被两条链路依赖 ——
//   1. 完整性校验第 ② 档（magic）：挡「200 但内容是 HTML/JSON 错误页」的假成功；
//   2. 取流侧 `prefetchCache.ts` 的完整性判官（判 too-small / not-audio）。
// 而探针 `probe.ts` 也必须用它（见下），若从 `probe.ts` 反向 import `integrity.ts`
// 就形成 **循环依赖**（integrity → probe → integrity）。故把「读文件头 + 按 magic 判
// 容器」这一层下沉到本模块，`integrity.ts` 原样再导出 `sniffMagic`，对外函数面不变。
//
// 【2026-10-12 生产教训 · 本模块存在的直接原因】
// 上游聚合源会给候选**虚标容器**：kugou 的 `extra.sq_hash` 被 `sourcePlatforms.ts`
// 声明成 `container="flac"`，下载侧据此把临时文件命名成 `.flac`，而插件实际回的是
// **MP3（ID3 头 + ff fb 帧）**。music-metadata 的 `parseFile()` **按扩展名挑解析器**，
// 于是 FLAC 解析器读 MP3 字节 → `FourCC contains invalid characters: ff fb 90 64`
// → 整首歌被判 `INTEGRITY_FAILED`（240 实测 11883 首，占洗版失败的绝大多数）。
// 结论：**容器只能按内容定**，扩展名与信源声明都只是线索。
import { closeSync, openSync, readSync, statSync } from "node:fs";

const log = (...args: unknown[]): void => {
  // 本模块保持零依赖（不引 logger，避免与 probe/integrity 的加载顺序纠缠）。
  if (process.env.MF_SNIFF_DEBUG) console.log("[sniff]", ...args);
};

/** 嗅探缓冲区大小：足以覆盖 ID3 头后的同步字 / ftyp / fLaC / RIFF。 */
export const SNIFF_BYTES = 512;

/** 嗅探结果：kind 为容器名或 `text` / `unknown` / `empty`；audio 表示是否音频。 */
export interface SniffResult {
  kind: string;
  audio: boolean;
}

/** 只读头部若干字节（不加载整个文件）。 */
export function readHead(file: string, n: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const want = Math.min(n, Math.max(size, 0));
    const buf = Buffer.alloc(want);
    if (want > 0) readSync(fd, buf, 0, want, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** 按文件头判断是不是音频；返回 kind 与是否音频。 */
export function sniffMagic(buf: Buffer): SniffResult {
  if (!buf || buf.length === 0) return { kind: "empty", audio: false };
  const head = buf.subarray(0, 4).toString("latin1");
  if (head === "fLaC") return { kind: "flac", audio: true };
  if (head === "OggS") return { kind: "ogg", audio: true };
  // ⚠️ ID3v2 头是 "ID3" + 版本号(0x03 或 0x04),必须按前 3 字节判断 —— 拿 4 字节
  // 和 "ID3" 比会永远不相等,导致所有带 ID3 的 mp3 被误判成非音频(踩过一次)。
  if (head.startsWith("ID3")) return { kind: "mp3", audio: true };
  if (head === "MAC ") return { kind: "ape", audio: true };
  if (head === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WAVE") return { kind: "wav", audio: true };
  if (head === "FORM" && buf.subarray(8, 12).toString("latin1") === "AIFF") return { kind: "aiff", audio: true };
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") return { kind: "mp4", audio: true };
  // MPEG 裸帧同步字（无 ID3 头的 mp3）：11 位 1。允许在头部若干字节内搜索 ——
  // 有些编码器先写一个 "Info"/Xing 头再跟帧同步字。
  for (let i = 0; i + 1 < Math.min(buf.length, 64); i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) return { kind: "mp3", audio: true };
  }

  // 「假成功」识别：服务端把 HTML / JSON / XML 错误页当 200 返回。
  const text = buf.subarray(0, Math.min(buf.length, 64)).toString("utf8").trim();
  if (text.startsWith("<") || text.startsWith("{") || text.startsWith("[")) {
    return { kind: "text", audio: false };
  }
  return { kind: "unknown", audio: false };
}

/**
 * 嗅探 kind → 归一化容器名（与 `probe.ts` 的 `CONTAINER_BY_EXT` 同名空间）。
 * 认不出的 kind（text / unknown / empty）返回 undefined —— **不给信息就是不猜**。
 */
export const CONTAINER_BY_SNIFF: Record<string, string> = {
  flac: "flac",
  ogg: "ogg",
  mp3: "mp3",
  mp4: "m4a",
  wav: "wav",
  aiff: "aiff",
  ape: "ape",
};

/**
 * 嗅探 kind → 可供 `music-metadata` 直接选解析器的 MIME 类型。
 *
 * 取值必须落在各解析器 `mimeTypes` 声明里（music-metadata 11.14 实测）：
 * flac=`audio/flac`、mpeg=`audio/mpeg`、ogg=`audio/ogg`、mp4=`audio/mp4`、
 * wav=`audio/wav`、aiff=`audio/aiff`、ape=`audio/ape`。
 *
 * 注意：**这里只做「选哪个解析器」的提示**，最终容器/编码仍以解析结果为准
 * （例如 ogg 里到底是 Vorbis 还是 Opus，由 OggLoader 自己再嗅）。
 */
export const MIME_BY_SNIFF: Record<string, string> = {
  flac: "audio/flac",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  wav: "audio/wav",
  aiff: "audio/aiff",
  ape: "audio/ape",
};

/** 嗅探 kind → 归一化容器名；认不出返回 undefined。 */
export function sniffContainer(kind: string): string | undefined {
  return CONTAINER_BY_SNIFF[kind];
}

/** 嗅探 kind → MIME 类型；认不出返回 undefined（调用方保持按扩展名解析）。 */
export function sniffMimeType(kind: string): string | undefined {
  return MIME_BY_SNIFF[kind];
}

/**
 * 扩展名与嗅探 kind 是否**同族**（同族不算冲突，不触发按内容重解析）。
 *
 * 为什么要「族」而不是严格相等：同一容器有多种合法后缀，音乐元数据也认多种后缀 ——
 * `.ogg / .oga / .opus` 都是 Ogg 封装（Vorbis / Opus），`.m4a / .mp4 / .alac` 都是
 * MP4 家族。严格比较会把「.opus 里装 Ogg」这种正常情况误判成冲突。
 */
export const EXT_FAMILY_BY_SNIFF: Record<string, readonly string[]> = {
  flac: [".flac"],
  ogg: [".ogg", ".oga", ".opus"],
  mp3: [".mp3"],
  mp4: [".m4a", ".mp4", ".alac"],
  wav: [".wav", ".wave"],
  aiff: [".aiff", ".aif"],
  ape: [".ape"],
};

/** 扩展名与嗅探 kind 同族？kind 认不出（undefined）时恒 true（不干预）。 */
export function extMatchesSniff(ext: string, kind: string): boolean {
  const fam = EXT_FAMILY_BY_SNIFF[kind];
  if (!fam) return true;
  return fam.includes(ext.toLowerCase());
}

/** 生成一段可读的「内容 vs 扩展名」诊断串（日志/告警用）。 */
export function describeSniffMismatch(ext: string, kind: string): string {
  const msg = `内容嗅探=${kind}，扩展名=${ext || "(无)"} —— 按内容解析`;
  log(msg);
  return msg;
}
