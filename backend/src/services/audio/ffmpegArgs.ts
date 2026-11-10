// ==================== ffmpeg 参数拼装(纯函数,零依赖) ====================
//
// 从 `pipeline.ts` 拆出来的「无副作用参数骨架」:解码段 / 输出段滤镜 / 通道编码参数。
//
// 为什么要拆:airplay 子进程(纯协议推流)的 decoder.ts / transcode.ts 只需要这几个
// 纯函数,而 pipeline.ts 的 `resolveLoudnessAf` 需要读设置与测量值(analysisStore /
// normalization → db/index,模块加载即 new Database)。子进程一旦 import 到那条链,
// 就会在 import 期多开一条 SQLite 连接 —— 违背 SPEC「每进程一个 SQLite 连接」。
//
// 拆分口径 = 只依赖 node 内建 / 纯字符串运算;凡是需要 DB、设置或上层服务的一律留在
// pipeline.ts。既有引用不用改:pipeline.ts 原样 re-export 本文件的全部导出。

/** ① 解码段参数请求。 */
export interface DecodeRequest {
  /** 已合规的输入(SPEC §1.8:本地文件路径或回环 token URL)。 */
  input: string;
  /** seek 起播偏移(秒):-ss 放 -i 之前(输入定位快,见 plan §4 接口约定)。 */
  timeOffsetSec?: number;
  /** http 输入的鉴权头(ffmpeg `-headers`,放 -i 之前;回环 token 通常不需要)。 */
  headers?: Record<string, string>;
  /** 强制输入格式(测试用 lavfi 等;生产靠扩展名/协议自动识别)。 */
  inputFormat?: string;
  /** 出流 ffmpeg 的 `-af` 链(响度→DSP→限制器,调用方按 loudnessFilter 等拼好)。 */
  af?: string[];
  /**
   * 输出封装(默认 f32le 交给下游编码层;AirPlay RAOP 要 s16le 直出)。
   * 注意:dither 仍走 af 里的 osf(见 outputFilters),这里只定容器格式。
   */
  outputFormat?: "f32le" | "s16le";
  /**
   * 过渡期强制输出采样率/声道(以 `-ar/-ac` 输出选项追加,行为与旧硬编码一致)。
   * sendspin 在 P1-4 确认编码层/pump 数学支持变采样率前,传 48000/2 保持
   * 下游所有 48k 立体声不变式;确认后去掉,真正跟随源。
   */
  forceRate?: number;
  forceChannels?: number;
  /**
   * 是否为 http(s) 输入追加 HTTP 重连参数(缺省 true,与 MA 行为一致)。
   * **仅 AirPlay 传 false**:它的输入是**本机回环**出流地址(`/rest/airplay/stream/:token`),
   * 不存在需要兜底的网络抖动;而 ffmpeg 对「无 Content-Length 的 chunked 流」在断开时
   * 没有可续接的位置信息,`-reconnect_streamed` 会**从 0 重读同一地址** ——
   * 听感就是「一首歌播到一半又从头开始」(2026-10-20 240 现网实测)。
   * 回环输入断流必须**当场失败**,由会话层走既有的失败/重试路径。
   */
  reconnect?: boolean;
}

/**
 * MA `_INPUT_READ_ARGS`(helpers/ffmpeg.py:43-50):ffmpeg 把这些套在**单个** -i 前,
 * 不是全局命令行 —— 每个输入都得自带一份。小 probesize/analyzeduration 让格式探测
 * 不再等满 5MB 默认值(起播/切歌更快);protocol_whitelist 按 MA 白名单收口。
 */
export const INPUT_READ_ARGS = [
  "-protocol_whitelist",
  "file,hls,http,https,tcp,tls,crypto,pipe,data,fd,rtp,udp,concat",
  "-probesize",
  "8096",
  "-analyzeduration",
  "500000",
] as const;

/**
 * MA `get_ffmpeg_args` 里对 `input_path.startswith("http")` 且 extra 无 `-f` 的输入
 * 追加的 HTTP 重连参数(ffmpeg.py:550-569)。我们回环 token / 远程源同构。
 */
export const HTTP_RECONNECT_ARGS = [
  "-reconnect",
  "1",
  "-reconnect_delay_max",
  "10",
  "-reconnect_streamed",
  "1",
  "-reconnect_on_network_error",
  "0",
  "-reconnect_on_http_error",
  "5xx,429",
] as const;

/**
 * 解码段参数:输出 F32 交错 PCM 到 stdout。
 * 刻意**不加 -ar/-ac**(采样率/声道跟随源,重采样下沉到⑥);
 * `-vn -sn -dn -map 0:a:0` 只取首音频流(封面/字幕不进管道)。
 * 全局 `-nostats -ignore_unknown` + 每输入 `INPUT_READ_ARGS` 对齐 MA(P0)。
 */
export function decodeArgs(req: DecodeRequest): string[] {
  // loudnorm 的 JSON 报告走 info 级打印(print_format=json 在流结束时输出):
  // 链里有它就必须把 loglevel 提到 info,否则 P0-4 拿不到测量值;
  // 无则保持 error(静默,沿用旧行为)。
  const needsInfo = (req.af ?? []).some(f => f.includes("loudnorm"));
  // MA 全局参数序:ffmpeg -hide_banner -loglevel <lv> -nostats -ignore_unknown
  const args = ["-hide_banner", "-loglevel", needsInfo ? "info" : "error", "-nostats", "-ignore_unknown"];
  if (req.timeOffsetSec !== undefined && Number.isFinite(req.timeOffsetSec) && req.timeOffsetSec > 0) {
    args.push("-ss", String(req.timeOffsetSec));
  }
  if (req.headers && Object.keys(req.headers).length > 0) {
    const lines = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`);
    args.push("-headers", lines.join("\r\n"));
  }
  args.push(...INPUT_READ_ARGS);
  // MA:仅 http(s) 输入且未显式 -f 时补重连(本地路径 / lavfi 测试不带)。
  // `reconnect === false` 时显式不加 —— 见 DecodeRequest.reconnect 的说明(AirPlay 回环输入)。
  if (req.reconnect !== false && !req.inputFormat && /^https?:\/\//i.test(req.input)) {
    args.push(...HTTP_RECONNECT_ARGS);
  }
  if (req.inputFormat) args.push("-f", req.inputFormat);
  args.push("-i", req.input, "-vn", "-sn", "-dn", "-map", "0:a:0");
  if (req.af && req.af.length > 0) {
    args.push("-af", req.af.join(","));
  }
  if (req.forceRate !== undefined && Number.isFinite(req.forceRate) && req.forceRate > 0) {
    args.push("-ar", String(Math.round(req.forceRate)));
  }
  if (req.forceChannels !== undefined && Number.isFinite(req.forceChannels) && req.forceChannels > 0) {
    args.push("-ac", String(Math.round(req.forceChannels)));
  }
  args.push("-f", req.outputFormat ?? "f32le", "pipe:1");
  return args;
}

/** 是否回环地址(本机回环直连不经过代理/DNS,天然合规,不再包)。
 *  导出供各通道解码器做失败 fast 的前置断言(SPEC §1.8)。 */
export function isLoopbackUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

// ==================== ⑥ 输出(重采样 + dither + 编码) ====================
export interface OutputRequest {
  /** 源采样率/位深(解码段跟随源的实际值;未知传 null → 保守处理)。 */
  sourceRate: number | null;
  sourceBits: number | null;
  targetRate: number;
  targetBits: number;
  /** 链中有 loudnorm → 重采样必须降级 swr(ffmpeg ticket 11323,照 MA 处理)。 */
  hasLoudnorm: boolean;
  /**  libsoxr 可用时走 soxr 高精度(MA 默认);不可用/未知 → swr。 */
  soxrAvailable?: boolean;
  /** 协议硬性采样率(如 RAOP 恒 44100):设置即无视 sourceRate 恒发 aresample。
   *  与"跟随源"冲突时以它为准,调用方必须在注释写明协议依据。 */
  forceRate?: number;
  /** 协议硬性声道布局(如 RAOP/ESP32 恒 stereo):设置即追加 aformat。 */
  forceChannels?: "stereo" | "mono";
}

/**
 * 输出段滤镜链(按需组装,顺序固定:重采样 → dither):
 * - 采样率相同 → 不加 aresample(MA:只在需要时加);
 * - 链中有 loudnorm 或无 soxr → swr,否则 soxr precision=30;
 * - 仅当 输入位深>16 且 输出==16 → osf=s16:dither_method=triangular_hp
 *   (是 triangular_hp,不是 triangular)。
 */
export function outputFilters(req: OutputRequest): string[] {
  const forced = req.forceRate !== undefined && Number.isFinite(req.forceRate) && req.forceRate > 0;
  const rateDiffers =
    forced ||
    (typeof req.sourceRate === "number" &&
      Number.isFinite(req.sourceRate) &&
      req.sourceRate > 0 &&
      req.sourceRate !== req.targetRate);
  const needDither =
    typeof req.sourceBits === "number" &&
    Number.isFinite(req.sourceBits) &&
    (req.sourceBits as number) > 16 &&
    req.targetBits === 16;
  if (!rateDiffers && !needDither && !req.forceChannels) return [];
  // 与 MA 同构:单个 aresample 承载 resample＋osr＋osf,分开写会跑两遍重采样。
  // 无需变采样率时不带 resampler 参数(只做 osf 转换)。
  // forceChannels 是另一个 filter(aformat),独立元素。
  const out: string[] = [];
  if (rateDiffers || needDither) {
    const opts: string[] = [];
    if (rateDiffers) {
      const rate = forced ? Math.round(req.forceRate as number) : req.targetRate;
      const resampler = !req.hasLoudnorm && req.soxrAvailable !== false ? "soxr:precision=30" : "swr";
      opts.push(`resampler=${resampler}`, `osr=${rate}`);
    }
    if (needDither) {
      opts.push("osf=s16", "dither_method=triangular_hp");
    }
    out.push(`aresample=${opts.join(":")}`);
  }
  if (req.forceChannels) {
    out.push(`aformat=channel_layouts=${req.forceChannels}`);
  }
  return out;
}

/** 通道编码参数(flac 无损 / mp3 320 / aac 256;DLNA 拒 FLAC 回退 mp3 由调用方决策)。 */
export function codecArgs(codec: "flac" | "mp3" | "aac" | "opus" | "pcm", bitrateKbps?: number): string[] {
  switch (codec) {
    case "mp3":
      return ["-c:a", "libmp3lame", "-b:a", `${bitrateKbps ?? 320}k`];
    case "aac":
      return ["-c:a", "aac", "-b:a", `${bitrateKbps ?? 256}k`];
    case "opus":
      return ["-c:a", "libopus", "-b:a", `${bitrateKbps ?? 128}k`];
    case "flac":
      return ["-c:a", "flac"];
    case "pcm":
      return ["-c:a", "pcm_s16le"];
  }
}
