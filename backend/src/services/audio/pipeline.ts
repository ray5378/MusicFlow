// ==================== 服务端统一音频管道 AudioPipeline(参数骨架/P1-1) ====================
//
// 六段流水线的参数装配层(docs/audio-pipeline-plan.md §4):
//   ① 解码(ffmpeg → F32,采样率/声道跟随源) → PCM AudioBuffer → ② 出流 ffmpeg
//      (响度 → DSP → 限制器 → 重采样/dither → 通道编码)。
// 本文件只做**纯参数拼装**(可单测、零副作用);进程拉起与泵送由各通道在 P1-2 起接入。
// 输入合规由 P1-1b 锁死(SPEC §1.8:本地路径或回环 token URL,见 resolveFfmpegInput)。
//
// 单位约定:滤镜链全部用 dB(MA 同构),限制器 `level=false` 纯天花板语义。
import type { VolumeNormalizationMode } from "./loudness.js";
import { chooseMode, computeGainDb } from "./loudness.js";
import { loadAnalysis } from "./analysisStore.js";
import { DEFAULT_TARGET_LUFS, readNormalizationSettings } from "./normalization.js";
// 纯参数骨架已拆到 ffmpegArgs.ts(无 DB/设置依赖,供 airplay 子进程的 decoder 直接用)。
// 这里 re-export,既有引用(pipeline.decodeArgs 等)逐字不变。
import { codecArgs, decodeArgs, isLoopbackUrl } from "./ffmpegArgs.js";
import type { DecodeRequest, OutputRequest } from "./ffmpegArgs.js";
export {
  codecArgs,
  decodeArgs,
  isLoopbackUrl,
  outputFilters,
  INPUT_READ_ARGS,
  HTTP_RECONNECT_ARGS,
} from "./ffmpegArgs.js";
export type { DecodeRequest, OutputRequest } from "./ffmpegArgs.js";

/**
 * D1 推荐值:目标响度(缺省 -14)。
 * **常量本体已挪到 `normalization.ts`** —— 它同时是设置项 `loudness.targetLufs` 的缺省值,
 * 与可选区间 `[TARGET_LUFS_MIN, TARGET_LUFS_MAX]` 必须同处一地(MA 也是同一个 ConfigEntry
 * 同时给出 range 与 default)。这里 re-export 只为不破坏既有引用。
 */
export { DEFAULT_TARGET_LUFS };
/** D5:限制器阈值。 */
export const LIMITER_CEILING_DB = -1;
/**
 * 离线预测量（P5-3）用的 loudnorm 参数。
 * ⚠️ 这里的 `I=-14` **与设置项 `loudness.targetLufs` 无关,也不该跟着它变**:
 * 测量批只解析 stderr 里的 JSON(`input_i` = **输入**的集成响度),`I=` 只影响输出增益,
 * 而该批的输出字节被直接丢弃 —— 即 `I=` 在这一趟里是**惰性的**。别"顺手对齐"成设置的
 * 目标值,那会让「改了目标响度 → 测量批的 ffmpeg 命令行变了 → 像是测量结果也该变」这种
 * 假因果被人照着抄。真正的目标值只在出流侧 `loudnessFilter` 里拼(MA 同构)。
 */
export const LOUDNORM_ARGS = "I=-14:TP=-2.0:LRA=10.0:offset=0.0:print_format=json";

// ==================== ② 响度 ====================

export interface LoudnessRequest {
  mode: VolumeNormalizationMode;
  /** fixed_gain / measurement 模式的静态增益 dB(调用方经 computeGainDb 算好)。 */
  gainDb?: number;
  /** 动态模式目标 LUFS(缺省 D1 推荐 -14)。 */
  targetLoudness?: number;
}

/**
 * 响度段滤镜(单个元素,调用方拼进 -af 链):
 * - dynamic → 实时 loudnorm(无测量也生效,首播即归一化);
 * - fixed_gain / measurement_only → volume=X dB 静态增益;
 * - disabled / source → null(不加滤镜;source=上游已对齐,禁二次归一)。
 */
export function loudnessFilter(req: LoudnessRequest): string | null {
  switch (req.mode) {
    case "dynamic": {
      const t = req.targetLoudness ?? DEFAULT_TARGET_LUFS;
      return `loudnorm=I=${t}:TP=-2.0:LRA=10.0:offset=0.0:print_format=json`;
    }
    case "fixed_gain":
    case "measurement_only": {
      const g = typeof req.gainDb === "number" && Number.isFinite(req.gainDb) ? req.gainDb : 0;
      return `volume=${g}dB`;
    }
    case "disabled":
    case "source":
    default:
      return null;
  }
}

// ==================== ⑤ 限制器 ====================

/**
 * 链尾限制器(MA dsp.py:218-223 同构):
 * `limit` 直接 dB 表达;`level=false` = 不做自动电平补偿、纯天花板语义。
 */
export function limiterFilter(ceilingDb: number = LIMITER_CEILING_DB): string {
  return `alimiter=limit=${ceilingDb}dB:level=false:asc=true:latency=true`;
}

// ==================== 输入合规(SPEC §1.8/P1-1b) ====================

export interface FfmpegInput {
  input: string;
  headers?: Record<string, string>;
}

/**
 * ffmpeg 输入硬合规门(原 streamEngine.resolveFfmpegInput,下沉到 audio 层):
 * http(s) 直链一律包成本进程回环 token URL —— 静态 ffmpeg 在 Alpine 解析不了
 * 域名(含 302 跳转目标),且跟 302 会把 Authorization 头带给 CDN;
 * 本地文件路径原样放行。空输入直接抛错(早失败,别等 ffmpeg 报).
 * 注意动态导入 dlna/control:audio 层不允许静态依赖上层路由模块(禁环)。
 */
export async function resolvePipelineInput(direct: FfmpegInput): Promise<FfmpegInput> {
  if (!direct.input) {
    throw new Error("ffmpeg 输入为空(本地文件路径或回环 token URL 二选一)");
  }
  if (/^https?:\/\//i.test(direct.input) && !isLoopbackUrl(direct.input)) {
    const { loopbackRawStreamUrl } = await import("../dlna/control.js");
    return { input: loopbackRawStreamUrl(direct.input, direct.headers ?? {}) };
  }
  return direct;
}

// ==================== ⑥ 输出(重采样 + dither + 编码)见 ffmpegArgs.ts ====================

export interface LoudnessAfOpts {
  /** 分析行 id(= songs.id):命中已测量走静态 volume,否则实时 loudnorm。 */
  rowId?: string;
  /** 缺省启用(D2);false = 整条 -af 不加(与旧命令逐字节一致,单测/逃生用)。 */
  enabled?: boolean;
  /** 目标 LUFS(缺省读全局设置 `loudness.targetLufs`,再缺省 -14)。 */
  targetLoudness?: number;
  /**
   * ② 段(响度归一化)**自己**的开关,缺省读全局设置 `loudness.normalization`(缺省开)。
   *
   * ⚠️ **与上面的 `enabled` 不是一回事,别混用**:
   *   - `enabled:false` 是**整条链的逃生舱**(单测对拍 / 老命令逐字节一致),
   *     `extraFilters` 与限制器一并丢弃;
   *   - `normalization:false` 只摘掉 ② 段(不加 loudnorm、也不加静态增益),
   *     **③ 段 DSP 与 ⑤ 段限制器照旧** —— 用户关掉"音量归一化"不该顺带丢掉音色与削波保护。
   */
  normalization?: boolean;
  /** 逃生舱 env 名(如 "SENDSPIN_LOUDNESS"):设为 "0" 即整条 -af 不加。 */
  escapeEnvVar?: string;
  /**
   * 是否在链尾追加限制器(缺省 true)。
   * **flow/交叉淡入必须传 false**(P3-1):两路信号相加后仍可能超 0 dBFS,
   * 限制器只能落在混合**之后**(⑤ 在 ④ 之后,plan §3.1),由 flow 的编码段统一加。
   * 若两处都加,等于对同一信号限幅两次(白烧 CPU + 第二次是空转)。
   */
  includeLimiter?: boolean;
  /**
   * ③ 段 DSP 片段(`services/audio/dsp.ts::buildFilterChain` 的产物,P4-2)。
   * 插在**响度之后、限制器之前**:顺序是 ② → ③ → ⑤(plan §3.1)——
   * DSP 必须作用在"已经一样响"的信号上,反过来的话响度归一化会把调好的音色重新抹平。
   * 注意逃生舱语义:本函数在 `enabled:false` / `escapeEnvVar=0` 时**整条返回空**,
   * 此时 `extraFilters` 也一并丢弃 —— 与 D9/D5「关闭开关 = 滤镜链为空」一致。
   */
  extraFilters?: string[];
}

/**
 * 响度段 af:[响度?,限制器](sendspin/airplay 共用同一语义,见 P1-2/P1-3):
 * - 逃生舱(`enabled:false` / `escapeEnvVar=0`)→ []（与旧命令逐字节一致）;
 * - 默认 D2:无测量走实时 loudnorm,有测量(rowId 命中)走静态 volume;
 *   目标响度与 ② 段开关缺省读**全局设置**(`loudness.targetLufs` / `loudness.normalization`);
 * - `normalization:false` 只摘 ② 段,DSP 与限制器照旧(见该字段注释);
 * - 末尾跟限制器(-1dB,MA 同构),除非 `includeLimiter:false`(flow/交叉淡入用,见该字段注释)。
 * 注意需要 DB(loadAnalysis),在测试/嵌入式场景 DB 未就绪时回落无测量。
 */
export function resolveLoudnessAf(opts: LoudnessAfOpts): string[] {
  if (opts.escapeEnvVar && process.env[opts.escapeEnvVar] === "0") return [];
  if (opts.enabled === false) return [];
  // ② 段的两个可配置值:调用方显式传的优先,否则读全局设置(`loudness.normalization` /
  // `loudness.targetLufs`)。**读在这里、不散到四个调用点**,与 `isChannelEnabled` 同一套
  // "唯一判定入口"纪律(否则 DLNA 与 AirPlay 迟早各配各的)。
  const norm = readNormalizationSettings();
  const target = opts.targetLoudness ?? norm.targetLufs;
  const normalizationOn = opts.normalization ?? norm.enabled;
  let measured: number | null = null;
  if (opts.rowId) {
    try {
      measured = loadAnalysis(opts.rowId)?.loudnessIntegrated ?? null;
    } catch {
      measured = null;
    }
  }
  // 关掉 ② 段 = `mode: "disabled"`(loudnessFilter 回 null),**不是**提前 return []——
  // 提前返回会把 ③/⑤ 一起丢掉,见 `normalization` 字段的注释。
  const mode = normalizationOn
    ? chooseMode({
        enabled: true,
        preference: "fallback_dynamic",
        targetLoudness: target,
        measuredLoudness: measured,
      })
    : "disabled";
  const out: string[] = [];
  const gainDb =
    mode === "measurement_only" || mode === "fixed_gain"
      ? computeGainDb(target, measured)
      : undefined;
  const lf = loudnessFilter({ mode, gainDb, targetLoudness: target });
  if (lf) out.push(lf);
  // ③ 段 DSP(P4-2):响度之后、限制器之前。放在这里而不是由调用方自行拼接,
  // 是为了让"②→③→⑤"这个顺序只有一个落点,不会被某个调用点接反。
  if (opts.extraFilters?.length) out.push(...opts.extraFilters);
  if (opts.includeLimiter !== false) out.push(limiterFilter());
  return out;
}

// ==================== ⑥ 通道编码决策(D4/P2-1) ====================

/** 通道输出编码。container 是 ffmpeg muxer 名(aac 用 adts),mime 是响应头。 */
export interface ChannelCodec {
  codec: "flac" | "mp3" | "aac" | "opus";
  bitrateKbps?: number;
  container: "flac" | "mp3" | "adts" | "ogg";
  mime: string;
}

/**
 * 按源后缀定**默认输出编码**(D4 跟随源族 → **D1 全局统一 FLAC**,2026-10-20):
 *
 * 除客户端**显式**要求 `format=mp3|aac` 的转码路径(那条走
 * `decideTranscode`/`serveTranscodedSong`,**不经本函数**、行为不变)外,
 * 源后缀无论 无损(flac/wav/alac/aiff/ape)、mp3、acc 系(m4a/aac)、
 * ogg 系(ogg/oga/opus)还是**未知兜底**,默认输出**一律 FLAC**。
 * 容器与编码参数沿用既有 flac 分支(`-c:a flac`),**不引入新参数** ——
 * 播放链路的输出编码目标由此(HTTP / DLNA / AirPlay 中间流)统一。
 */
export function resolveChannelCodec(suffix: string | null | undefined): ChannelCodec {
  return { codec: "flac", container: "flac", mime: "audio/flac" };
}

/**
 * DLNA 输出决策(P2-2 → **D1 收敛**,2026-10-20):**与公共决策完全一致**。
 *
 * 旧的「ogg 系(ogg/oga/opus)一律回退 mp3 320」分支(理由是老固件不认 Ogg/Opus
 * 容器)被「全局统一 FLAC」自然取代 —— FLAC 早已是现有无损源的目标格式,老固件
 * 兼容性与现状等同(Ogg 回退的存在理由不再成立)。二者必须**同源**:否则 cast 时
 * DIDL mime 与实际出流 Content-Type 会不一致。返回 ChannelCodec,两处 MIME 天然
 * 同步(P2-2 MIME 同步要求)。
 */
export function resolveDlnaOutput(suffix: string | null | undefined): ChannelCodec {
  return resolveChannelCodec(suffix);
}

export interface PipelineCommandRequest extends DecodeRequest {
  codec: ChannelCodec["codec"];
  bitrateKbps?: number;
}

/**
 * 整命令组装:解码段 ＋ af 链 ＋ 通道编码 ＋ 容器输出到 stdout(P2-1)。
 * 调用方(servePipelinedSong/serveTranscodedSong)只传声明式参数,不再手拼 ffmpeg。
 */
export function buildPipelineCommand(req: PipelineCommandRequest): string[] {
  const head = decodeArgs(req);
  // decodeArgs 尾是 ["-f","f32le","pipe:1"],出流输出替换为编码＋容器。
  head.splice(-3);
  const container =
    req.codec === "mp3" ? "mp3" : req.codec === "aac" ? "adts" : req.codec === "opus" ? "ogg" : "flac";
  return [...head, ...codecArgs(req.codec, req.bitrateKbps), "-f", container, "-"];
}
