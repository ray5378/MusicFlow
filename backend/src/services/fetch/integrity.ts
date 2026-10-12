// ==================== 下载完整性校验（MusicFetch M1） ====================
//
// 网络下载有四层「看起来成功但实际是垃圾」的情形，逐层加严、成本递增：
//   1. length    —— 字节数与预期不符（含 sha256 比对），成本最低；
//   2. magic     —— 文件头根本不是音频：服务端 302 到一个 HTML/JSON 错误页是最常见的
//                   假成功（200 + Content-Type 还常常是 text/html，但有些 CDN 会伪装）；
//   3. probe     —— music-metadata 能解析 + 有音频流 + 时长在容差内（过滤试听片段/串烧）；
//   4. decodable —— ffmpeg 全解码一遍（`-v error -i X -f null -`），唯一能抓出「头对、
//                   中间坏」的手段（M0 实测：正常 exit 0 且 stderr 空；损坏样本 exit 234）。
//
// 档位是**累加**的：选 decodable 会先跑完 length/magic/probe 三档，任一层失败即返回，
// 避免把明显是 HTML 的文件丢给 ffmpeg 白跑一遍。
//
// 所有失败都带 FetchErrorCode：
//   - `SOURCE_INVALID`   源站返回的**根本不是音频**（HTML/JSON 错误页、十几字节的
//                        `Failed to ...` 文本）—— 这是**源侧**问题，换链/重试可解，
//                        **不进永久失效白名单**（见 attempts.ts）；
//   - `DURATION_UNKNOWN` 能解析出音频流，但**拿不到时长**（有些 Ogg/Opus 容器就没写
//                        时长），无法证明是完整曲目 —— 同样**不算**文件损坏；
//   - `INTEGRITY_FAILED` 真·文件残缺 / 头对中间坏 / 完全解析不了（**永久失效类**）；
//   - `TIMEOUT`          超时（可重试，与「文件坏」是两种处置）。
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createLogger } from "../../utils/logger.js";
import { resolveFfmpeg } from "../transcode.js";
import { probeFile } from "./probe.js";
import { SNIFF_BYTES, readHead, sniffMagic } from "./sniff.js";
import { DEFAULT_QUALITY_CONFIG, type FetchErrorCode } from "./types.js";

// `sniffMagic` 的历史出口在本模块（取流侧 prefetchCache.ts 与 integrity.test.ts 都从这里
// import）。实现已下沉到 `sniff.ts`（免得与 probe.ts 形成循环依赖），此处原样再导出，
// **对外函数面不变**。
export { sniffMagic } from "./sniff.js";

const log = createLogger("FETCH_INTEGRITY");

/** 校验档位（成本递增、层层累加）。 */
export type IntegrityLevel = "length" | "magic" | "probe" | "decodable";

/** 期望值（来自 DownloadResult 与目标曲目元数据）。 */
export interface IntegrityExpect {
  /** 期望字节数 */
  bytes?: number;
  /** 期望 sha256（小写 hex） */
  sha256?: string;
  /** 期望时长（秒） */
  durationSec?: number;
  /** 时长容差（秒），缺省取 DEFAULT_QUALITY_CONFIG.durationToleranceSec */
  durationToleranceSec?: number;
}

/** 校验细节，全部可留痕（日志/排障用）。 */
export interface IntegrityDetail {
  bytes: number;
  sha256?: string;
  /** 文件头嗅探结果：mp3/flac/… 或 text/unknown */
  sniff?: string;
  durationSec?: number;
  container?: string;
  /** 是否完成全解码校验（仅 decodable 档有值） */
  decodable?: boolean;
  /** ffmpeg / 解析的 stderr 片段（失败时排障用） */
  stderr?: string;
}

export interface IntegrityResult {
  ok: boolean;
  /** 实际执行到的最高档位 */
  level: IntegrityLevel;
  code?: FetchErrorCode;
  detail: IntegrityDetail;
  warnings: string[];
}

/** 嗅探缓冲区大小：足以覆盖 ID3 头后的同步字 / ftyp / fLaC / RIFF。 */
export { SNIFF_BYTES } from "./sniff.js";
/** 默认全解码超时（毫秒）。 */
const DEFAULT_DECODE_TIMEOUT_MS = 120_000;

/** 计算 sha256（流式，避免把整首歌读进内存）。 */
export function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(file);
    s.on("data", (c) => h.update(c));
    s.on("error", (e) => reject(e));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * ffmpeg 全解码校验：`-v error -i <file> -f null -`。
 *
 * 判据（M0 实测）：正常文件 exit 0 且 stderr 为空；损坏样本 exit 234 且 stderr 有内容。
 * 任一 stderr 输出都视为失败 —— `-v error` 下正常文件是零输出的。
 */
export function isDecodable(file: string, timeoutMs: number = DEFAULT_DECODE_TIMEOUT_MS): Promise<{ ok: boolean; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveFfmpeg(), ["-v", "error", "-i", file, "-f", "null", "-"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      reject(new Error(`无法启动 ffmpeg: ${String(e)}`));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      resolve({ ok: false, stderr, timedOut: true });
    }, timeoutMs);
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
      if (stderr.length > 32 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stderr: e.message, timedOut: false });
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0 && stderr.trim() === "", stderr, timedOut: false });
    });
  });
}

/**
 * 校验下载产物。
 *
 * @param input  文件路径，或 `{ file, expect }`
 * @param level  档位，缺省 "probe"
 */
export async function verifyIntegrity(
  input: string | { file: string; expect?: IntegrityExpect },
  level: IntegrityLevel = "probe",
): Promise<IntegrityResult> {
  const req = typeof input === "string" ? { file: input, expect: undefined } : input;
  const file = req.file;
  const expect = req.expect || {};
  const warnings: string[] = [];

  let bytes = 0;
  try {
    bytes = statSync(file).size;
  } catch {
    return { ok: false, level: "length", code: "INTEGRITY_FAILED", detail: { bytes: 0 }, warnings };
  }
  const detail: IntegrityDetail = { bytes };

  // ---- ① length：字节数（+ 可选 sha256）----
  if (typeof expect.bytes === "number" && expect.bytes >= 0 && bytes !== expect.bytes) {
    detail.sha256 = undefined;
    return {
      ok: false, level: "length", code: "INTEGRITY_FAILED",
      detail, warnings: [...warnings, `字节数不符: 期望 ${expect.bytes},实际 ${bytes}`],
    };
  }
  if (expect.sha256) {
    try {
      detail.sha256 = await sha256Of(file);
      if (detail.sha256.toLowerCase() !== expect.sha256.toLowerCase()) {
        return {
          ok: false, level: "length", code: "INTEGRITY_FAILED",
          detail, warnings: [...warnings, "sha256 不符"],
        };
      }
    } catch (e) {
      return {
        ok: false, level: "length", code: "INTEGRITY_FAILED",
        detail, warnings: [...warnings, `sha256 计算失败: ${e instanceof Error ? e.message : String(e)}`],
      };
    }
  }
  if (level === "length") return { ok: true, level, detail, warnings };

  // ---- ② magic：文件头必须是音频（挡 HTML/JSON 错误页这类假成功）----
  let head: Buffer;
  try {
    head = readHead(file, SNIFF_BYTES);
  } catch (e) {
    return {
      ok: false, level: "magic", code: "INTEGRITY_FAILED",
      detail, warnings: [...warnings, `读取文件头失败: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  const sniff = sniffMagic(head);
  detail.sniff = sniff.kind;
  if (!sniff.audio) {
    // 非音频响应体是**源侧**问题（错误页 / 十几字节的失败文本），换链或重试就可能好，
    // 与「文件残缺」是两回事：用 INTEGRITY_FAILED 会被 attempts.ts 的永久失效白名单
    // 收进去，于是「源站偶发挂掉」被算成「这首歌死了」，连续两次就被 deadSongPurge
    // 移出曲库（就是 2026-10-11 那类「歌莫名消失」）。故单开 SOURCE_INVALID。
    return {
      ok: false, level: "magic", code: "SOURCE_INVALID",
      detail, warnings: [...warnings, `文件头不是音频(sniff=${sniff.kind})，源站返回的疑似错误页/非音频内容`],
    };
  }
  if (level === "magic") return { ok: true, level, detail, warnings };

  // ---- ③ probe：能解析 + 时长在容差内 ----
  let media;
  try {
    media = await probeFile(file, { useCache: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code: FetchErrorCode = (e as { code?: FetchErrorCode })?.code || "INTEGRITY_FAILED";
    return { ok: false, level: "probe", code, detail, warnings: [...warnings, msg] };
  }
  detail.durationSec = media.durationSec;
  detail.container = media.container;
  if (typeof expect.durationSec === "number" && expect.durationSec > 0) {
    const tol = typeof expect.durationToleranceSec === "number"
      ? expect.durationToleranceSec
      : DEFAULT_QUALITY_CONFIG.durationToleranceSec;
    if (media.durationSec === undefined) {
      // 「解析得到音频流但读不出时长」≠ 文件坏：Ogg/Opus 之类容器可以不写时长，
      // 拿不到时长只说明**无法证明是完整曲目**（可能被截断，也可能是元数据缺失）。
      // 必须用 DURATION_UNKNOWN（非永久）：用 INTEGRITY_FAILED 会让这种歌被判死链
      // 移出曲库（同 DURATION_MISMATCH 的历史坑，2026-10-11 生产实测）。
      return { ok: false, level: "probe", code: "DURATION_UNKNOWN", detail, warnings: [...warnings, "拿不到时长（容器未写时长或元数据缺失）"] };
    }
    if (Math.abs(media.durationSec - expect.durationSec) > tol) {
      return {
        // 时长对不上 = 拿到的是**另一个版本**（现场版/混音），文件本身解析正常、完整。
        // 必须用 DURATION_MISMATCH，不能用 INTEGRITY_FAILED —— 后者在
        // PERMANENT_FAILURE_CODES 白名单里，会把这种「歌还在、还能在线播放」的条目
        // 判成死链移出曲库（2026-10-11 生产实测）。
        ok: false, level: "probe", code: "DURATION_MISMATCH", detail,
        warnings: [...warnings, `时长偏差超容差: 期望 ${expect.durationSec}s±${tol}s,实际 ${media.durationSec}s`],
      };
    }
  }
  if (level === "probe") return { ok: true, level, detail, warnings };

  // ---- ④ decodable：ffmpeg 全解码 ----
  const dec = await isDecodable(file);
  detail.decodable = dec.ok;
  if (!dec.ok) {
    detail.stderr = dec.stderr.slice(0, 500);
    return {
      ok: false, level: "decodable",
      code: dec.timedOut ? "TIMEOUT" : "INTEGRITY_FAILED",
      detail, warnings: [...warnings, dec.timedOut ? "全解码超时" : "全解码失败"],
    };
  }
  log.info("完整性校验通过", { file, level, bytes });
  return { ok: true, level, detail, warnings };
}
