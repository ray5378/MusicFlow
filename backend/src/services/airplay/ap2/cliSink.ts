// ==================== cliairplay 会话(cli 通道,AP2 发送端)====================
//
// 一个设备一个常驻 `cliairplay` 进程,生命周期与 RAOP 会话对等:
//
//   PCM(进程 stdin, 44.1k/2ch/s16 交错)   ← 本类按 1x 实时节拍持续写入
//   cmdpipe(FIFO) 里的 KEY=VALUE 行        ← START_UNIX_MS / ACTION / VOLUME / 元数据
//   stdout+stderr 的 [STATUS] 行           ← connected / latency / started / flushed / eof
//
// **为什么不用自研 RAOP**:配对(SRP/HAP)、加密 RTSP、二进制 plist SETUP、AAC/ALAC 帧
// 封装、PTP gRANDMASTER 全部由二进制实现,与 Music Assistant 走同一条路。本类只负责
// 「把 pump 时间线上的 PCM 按正确时刻喂进去」,也就是 MA 里 `stream_session.py` 的角色。
//
// ## 与 RAOP 路径的同步模型差异(必须理解,否则会调错)
//
// RAOP 路径:每 7.98ms 拉一次 `BridgeRing.producer(lead)` 得 1408B,打成 RTP 包**自带
// 时间戳**发出去,接收端按包时间戳落位。
//
// cli 路径:二进制**不认单包时间戳**,它认的是"这批样本流的第 1 个样本应当在
// `START_UNIX_MS` 可听"。于是同步靠两件事:
//   1. `producer(lead)` 里的 lead 是**常量**(= 设备 queue depth + 余量),保证"此刻写入的
//      样本"正好是"lead 之后该听到的内容";
//   2. `START_UNIX_MS` = 第一批写入时的墙钟 + 同一个 lead,把这个常量 lead 钉到绝对时刻。
// 两者用同一个 lead,时间线就自洽;组内所有成员共用 pump 的时间线,于是"同一时刻听到
// 同一段内容"是结构保证 —— 与 RAOP 桥接完全同源,只是锚点交付方式不同。
//
// 二进制回执 `[STATUS] started requested_unix_ms=A at_unix_ms=B` 若 B≠A(锚点被前移到
// 最早可行时刻),我们把差值补进 lead,下一批自然取到正确位置;ring 内部超过 50ms 的
// 跳位会重锚(有一次轻微跳变,但时间线不至于永久偏移)。200ms 余量下实测不发生。
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { once } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createLogger } from "../../../utils/logger.js";
import type { PcmProducer } from "../raop.js";
import { ptpDaemon } from "./ptpDaemon.js";

const log = createLogger("AIRPLAY-AP2");

/** 单批输出 = 352 帧 @44.1k = 1408B,与 RAOP 的 chunk 同尺寸(ring 的 producer 就吐这个)。 */
const CHUNK_FRAMES = 352;
/** 单批时长(微秒):352/44100*1e6 ≈ 7982us。 */
const CHUNK_US = Math.round((CHUNK_FRAMES / 44100) * 1e6);
/** 锚点安全余量:START 定在「写入时刻 + 设备 queue depth + 余量」。
 *  README 要求 >= 250ms(native)、>= 200ms(RAOP);这里统一 250ms。 */
const ANCHOR_MARGIN_MS = 250;
/** 等 `[STATUS] latency` 的上限:拿不到就用二进制默认 600ms 兜底(仍然能出声,只是同步精度差)。 */
const LATENCY_WAIT_MS = 8_000;
/** 建立 cmdpipe 写端的重试上限:cli 进程可能还没打开 FIFO 读端(无读者 → ENXIO)。 */
const PIPE_OPEN_RETRY_MS = 5_000;
/** 节拍落后超过这么多批就重定调度基准(事件循环卡顿后不要试图追赶一堆过期批次)。 */
const MAX_LAG_CHUNKS = 8;

function nowUs(): number {
  return Number(process.hrtime.bigint() / 1000n);
}

/** 稳定派生 DACP ID(16 位十进制)。配对身份由它派生 ⇒ 同一设备必须每次一致,
 *  否则 pair-verify 签名对不上(README:pairing identity is derived from it)。 */
export function deriveDacpId(deviceId: string): string {
  // FNV-1a 64 位 → 十进制补零。不引 crypto:只要稳定、分布够散即可。
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < deviceId.length; i++) {
    h ^= BigInt(deviceId.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return (h % 10000000000000000n).toString().padStart(16, "0");
}

export interface CliSinkArgs {
  deviceId: string;
  /** 设备 _airplay._tcp 的 SRV 目标地址(可路由 IP)。AP1 用 _raop._tcp 的地址。 */
  host: string;
  /** 设备 RTSP 端口:AP2 用 _airplay._tcp 的(通常 7000),AP1 用 _raop._tcp 的(5000 左右)。 */
  port: number;
  /** 强制协议。缺省按 creds/txt 自动:`airplay2`(有凭据)/ `auto`。
   *
   *  **AP1 全切后必须显式传 `raop`**:AP1 设备没有 `_airplay._tcp` TXT,靠 auto 会被
   *  二进制的"无 features 就按 AP2-native 处理"规则带偏。 */
  protocol?: "auto" | "raop" | "airplay2" | "airplay2-compat";
  /** 已序列化的 TXT:`"features=0x.. protovers=1.1 deviceid=.."`(空格分隔)。
   *  二进制的路由自动选择(RAOP / AP2 native / AP2 compat / PTP)全靠它。 */
  txt?: string;
  /** HAP 凭据(192 hex,来自 pair-setup)。缺省走 transient 配对(Sonos 等无需预配对)。 */
  creds?: string;
  /** AP1 专有:legacy Apple TV 的 RAOP 配对 secret(来自 `--pair`)。 */
  secret?: string;
  /** AP1 专有:传回接收端自己的 mDNS TXT 字段(二进制按它们决定 ALAC/加密/延迟)。 */
  raopTxt?: { et?: string; md?: string; am?: string; pk?: string; cn?: string; udn?: string };
  /** AP1 音频载荷加密(默认开,与 MA 的 CONF_ENCRYPTION 默认一致)。 */
  encrypt?: boolean;
  name?: string;
  hostname?: string;
  volume?: number;
  title?: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  /** 本次时间线的**内容起点**(秒)。
   *
   *  带进度起播(流转落点 / 客户端从中间续播)时,PCM 流本身已经从 `startSec` 处
   *  开始(服务端回环流带 `timeOffset`),但 cli 的时间线是从「第一批的可听时刻」起算的
   *  —— 不补这个基准,上报位置会从 0 开始涨,进度条、流转落点、续播位置全部错位。
   *  显式 seek 走 `seek()` 内部置基准,不需要调用方再传。 */
  startSec?: number;
  /** 生产者工厂:入参 `leadUs()` 返回当前生效的播放提前量(微秒)。
   *  **必须在启动写循环之前调用一次**,之后每次拉取都用同一个 producer 实例。 */
  makeProducer: (leadUs: () => number) => PcmProducer;
  /** 切歌/seek 时清空上游环形缓冲(与 cmdpipe FLUSH 配套)。 */
  resetSource?: () => void;
  /** 二进制路径(已自检可用)。 */
  binPath: string;
}

export interface CliSinkEndInfo {
  /** 结束时的内容落点(秒)。 */
  positionSec: number;
  durationSec: number;
  /** 二进制最后几行 stderr(诊断用,便于把 [STATUS] 与真机表现对上)。 */
  tailLog: string;
}

/** 序列化 mDNS TXT 为 `--txt` 要求的单个空格分隔串(含空白的对跳过:二进制按空格切)。 */
export function serializeTxt(txt: Record<string, string> | undefined): string {
  if (!txt) return "";
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(txt)) {
    if (!k || v === undefined || v === null) continue;
    const s = String(v);
    if (!s || /\s/.test(s)) continue;
    pairs.push(`${k}=${s}`);
  }
  return pairs.join(" ");
}

export class CliSink {
  private readonly a: CliSinkArgs;
  private proc: ChildProcess | null = null;
  private pipeFd: number | null = null;
  private pipePath = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** 设备 queue depth(warm lead),来自 `[STATUS] latency`。 */
  private baseLeadMs = 600;
  /** 锚点被前移的补偿量(微秒),叠加在 baseLeadMs 之上。 */
  private leadAdjustUs = 0;
  /** 第一批 PCM 的单调时刻(0 = 还没起播)。 */
  private t0Us = 0;
  /** 当前时间线的**内容起点**(秒):起播带进度 = startSec,seek 后 = 目标秒。
   *  positionSec = baseSec + 已播时长,否则带进度起播会从 0 开始上报。 */
  private baseSec = 0;
  /** 下一批的调度截止时刻(单调)。 */
  private nextAtUs = 0;

  private producer: PcmProducer | null = null;
  private stopped = false;
  private paused = false;
  private exiting = false;
  /** 本会话是否占用了共享 PTP 守护(用于精确配平引用计数)。 */
  private usesPtp = false;
  private startedAt = Date.now();
  private stderrTail: string[] = [];
  private stdoutBuf = "";
  private stderrBuf = "";
  private latencyResolve: (() => void) | null = null;
  private latencySeen = false;

  /** 结束回调(由 sessionRuntime 注入:判断是否仍为当前会话后上报 IDLE)。 */
  onEnd?: (info: CliSinkEndInfo) => void;

  constructor(args: CliSinkArgs) {
    this.a = args;
  }

  /** 二进制承诺的播放提前量(微秒)= queue depth + 锚点余量 + 回执补偿。 */
  private effectiveLeadUs = (): number => Math.max(0, this.baseLeadMs * 1000 + this.leadAdjustUs);

  /** 内容落点(秒)。以「第一批的可听时刻」为 0 点,pump 时间线上单调推进;
   *  `baseSec` 把这条时间线映射回**整曲**坐标(带进度起播 / seek 后)。 */
  get positionSec(): number {
    if (!this.t0Us) return 0;
    const elapsed = nowUs() - this.t0Us - this.effectiveLeadUs();
    return Math.max(0, this.baseSec + elapsed / 1e6);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** 起会话:spawn → 等 connected+latency → 建 cmdpipe → 发 START → 起写循环。
   *
   *  返回实际生效的提前量(微秒):主进程要拿它抬 send_ahead 下限,否则
   *  `BridgeRing` 每批都取到尚未生产的内容 ⇒ 整场静音(RAOP 桥接踩过同一个坑)。 */
  async start(): Promise<{ leadUs: number; sampleRate: number }> {
    const { deviceId, host, port, binPath } = this.a;
    this.pipePath = path.join(os.tmpdir(), `mf-ap2-${sanitize(deviceId)}-${process.pid}-${Date.now()}.fifo`);
    try {
      execFileSync("mkfifo", ["-m", "0600", this.pipePath], { timeout: 3_000 });
    } catch (e: any) {
      throw new Error(`AP2 命令管道创建失败(${this.pipePath}): ${e?.message || e}`);
    }

    const protocol = this.a.protocol ?? (this.a.creds ? "airplay2" : "auto");
    const args = [
      "--protocol", protocol,
      "--port", String(port || (protocol === "raop" ? 5000 : 7000)),
      "--dacp", deriveDacpId(deviceId),
      "--cmdpipe", this.pipePath,
      "--samplerate", "44100",
      "--bitdepth", "16",
      "--channels", "2",
      "--volume", String(clampVolume(this.a.volume)),
      "--debug", process.env.MUSICFLOW_AP2_DEBUG === "1" ? "5" : "3",
    ];
    if (this.a.txt) args.push("--txt", this.a.txt);
    if (this.a.creds) args.push("--auth", this.a.creds);
    if (this.a.name) args.push("--name", this.a.name);
    if (this.a.hostname) args.push("--hostname", this.a.hostname);
    // AP1(RAOP)专有参数:接收端 TXT 里的 codec/加密/延迟声明必须原样透传,
    // 否则二进制会按缺省(只发 ALAC 压缩、无加密)握手 —— 部分接收端会静音或拒流。
    const rt = this.a.raopTxt;
    if (rt) {
      if (rt.udn) args.push("--udn", rt.udn);
      if (rt.et) args.push("--et", rt.et);
      if (rt.md) args.push("--md", rt.md);
      if (rt.am) args.push("--am", rt.am);
      if (rt.pk) args.push("--pk", rt.pk);
      if (rt.cn) args.push("--cn", rt.cn);
    }
    if (this.a.secret) args.push("--secret", this.a.secret);
    // 默认加密(与 MA 的 CONF_ENCRYPTION 默认 true 一致);`MUSICFLOW_AP2_RAOP_ENCRYPT=0` 可关。
    const encrypt = this.a.encrypt ?? process.env.MUSICFLOW_AP2_RAOP_ENCRYPT !== "0";
    if (protocol === "raop" && encrypt) args.push("--encrypt");
    // PTP 默认关:统一 START 锚点已能到亚毫秒级(230 三台实测跨度 0.159ms),
    // 而 PTP 要 bind 319/320。`MUSICFLOW_AP2_PTP=1` 时改用共享 PTP 守护时钟。
    if (process.env.MUSICFLOW_AP2_PTP === "1" && protocol !== "raop") {
      args.push("--ptp", "--ptp-shared");
      // 引用计数:第一个流拉起守护,最后一个流收掉(MA 同一策略)。
      ptpDaemon.acquire();
      this.usesPtp = true;
    }
    args.push(host);

    const shown = args.filter((x) => !/^[0-9a-f]{192}$/i.test(x) && x !== "--auth");
    log.info(`[ap2] 启动 ${deviceId} protocol=${protocol} -> ${host}:${port} (${shown.join(" ")})`);
    const proc = spawn(binPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.attachReaders(proc);

    const exited = new Promise<never>((_, reject) => {
      proc.once("exit", (code, sig) => {
        if (!this.exiting) {
          reject(new Error(`cliairplay 提前退出(code=${code} sig=${sig}): ${this.stderrTail.slice(-4).join(" | ")}`));
        }
      });
      proc.once("error", (e) => reject(new Error(`cliairplay 启动失败: ${e.message}`)));
    });

    try {
      await Promise.race([this.waitLatency(), exited]);
    } catch (e) {
      this.kill();
      throw e;
    }

    // FIFO 写端:cli 进程已起来并打开了读端,但可能晚一拍,带重试。
    this.pipeFd = await this.openPipe();

    // 先定锚点,再起写循环:START 的语义是「第 1 个样本的可听时刻」,
    // 而 producer(lead) 保证第 1 批恰好是「此刻 + lead」该听的内容 —— 两边同一个 lead。
    const leadMs = this.baseLeadMs + ANCHOR_MARGIN_MS;
    this.baseLeadMs = leadMs; // 之后 effectiveLeadUs 一律以它为准(含回执补偿)
    const anchorWall = Date.now() + leadMs;
    this.send(`START_UNIX_MS=${anchorWall}`);
    this.send("ACTION=START");
    this.pushMeta();

    this.producer = this.a.makeProducer(this.effectiveLeadUs);
    this.baseSec = Math.max(0, this.a.startSec ?? 0);
    this.t0Us = nowUs();
    this.nextAtUs = this.t0Us;
    this.startedAt = Date.now();
    this.scheduleNext();

    log.info(`[ap2] ${deviceId} 已起播(lead=${Math.round(this.effectiveLeadUs() / 1000)}ms, anchor=${new Date(anchorWall).toISOString()})`);
    return { leadUs: this.effectiveLeadUs(), sampleRate: 44100 };
  }

  /** 暂停:二进制静音但连接保持(与 RAOP 的 `player.pause()` 同语义)。 */
  pause(): void {
    if (!this.pipeFd || this.stopped) return;
    this.paused = true;
    this.clearTimer();
    this.send("ACTION=PAUSE");
  }

  /** 恢复:重新锚定时间线(内容推进由 pump 负责,ring 已按新位置供数)。 */
  resume(): void {
    if (!this.pipeFd || this.stopped) return;
    if (!this.paused) return;
    this.paused = false;
    this.reanchor("resume");
    this.send("ACTION=PLAY");
  }

  /** seek:原地 FLUSH + 清上游环。**不重锚**。
   *
   *  为什么把「重锚」拆出去:单播 seek 还要换解码器(新 ffmpeg 带 -ss),顺序是
   *  FLUSH → 换 producer → 再 START。若这里先重锚,那条 START 会把**旧的**解码器
   *  数据锚到新时刻,新解码器的前几批就被判成"迟到"而跳位。
   *  组播 seek 没有解码器,调用方在同一位置补一次 `restartTimeline()` 即可。 */
  seek(seconds: number): void {
    if (!this.pipeFd || this.stopped) return;
    // 基准必须先记下来:`restartTimeline()` 只挪 t0Us(第一批的新可听时刻),
    // 不负责把内容起点从旧值改成新目标 —— 少了这一行,seek 后位置会从 0 重新涨。
    this.baseSec = Math.max(0, seconds);
    this.send("ACTION=FLUSH");
    try { this.a.resetSource?.(); } catch { /* ignore */ }
    log.info(`[ap2] ${this.a.deviceId} FLUSH@${seconds}s`);
  }

  /** 换 PCM 源(单播 seek 换解码器用):替换 producer 并重置调度基准。
   *  不自行重锚 —— 由调用方在数据源就绪后调 `restartTimeline()`。 */
  setProducer(make: (leadUs: () => number) => PcmProducer): void {
    this.producer = make(this.effectiveLeadUs);
    this.clearTimer();
    this.nextAtUs = nowUs();
    this.paused = false;
  }

  /** 重锚时间线:把「下一个待播样本」钉到 `now + lead`(START 契约)。
   *
   *  用于 resume / seek 后 / 组播新成员并入后。pump 侧已 re-anchor 并给 ring 发
   *  reset,这里只同步 cli 的锚点,两边用同一个 lead 就自洽。 */
  restartTimeline(reason: string): void {
    this.reanchor(reason);
  }

  setVolume(volume: number): void {
    this.send(`VOLUME=${clampVolume(volume)}`);
  }

  setMeta(m: { title?: string; artist?: string; album?: string; durationSec?: number }): void {
    this.a.title = m.title;
    this.a.artist = m.artist;
    this.a.album = m.album;
    this.a.durationSec = m.durationSec;
    this.pushMeta();
  }

  /** 停会话:STOP(二进制会拆连接并退出)→ 兜底 kill → 清理 FIFO。
   *
   *  `STOP` 是终结性的(读数:进程 exit 0),但设备卡住时二进制可能不返回 ⇒ 有上限。 */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.exiting = true;
    this.clearTimer();
    if (this.pipeFd !== null) {
      try { this.send("ACTION=STOP"); } catch { /* ignore */ }
    }
    const proc = this.proc;
    if (proc && !proc.killed) {
      const done = once(proc, "exit").then(() => true).catch(() => true);
      const timeout = new Promise<boolean>((res) => {
        const t = setTimeout(() => res(false), 2_000);
        t.unref?.();
      });
      const ok = await Promise.race([done, timeout]);
      if (!ok) {
        log.warn(`[ap2] ${this.a.deviceId} cliairplay 未在 2s 内退出,强制 kill`);
        this.kill();
      }
    }
    this.closePipe();
    if (this.usesPtp) { this.usesPtp = false; ptpDaemon.release(); }
    log.info(`[ap2] ${this.a.deviceId} 会话已拆除`);
  }

  // ==================== 内部 ====================

  /** 重锚:把「第 1 个尚未播的样本」重新钉到现在 + lead。
   *  pump 侧已经 re-anchor 并给 ring 发 reset,这里只同步 cliairplay 的锚点。 */
  private reanchor(reason: string): void {
    const leadMs = Math.round(this.effectiveLeadUs() / 1000);
    const anchorWall = Date.now() + leadMs;
    this.send(`START_UNIX_MS=${anchorWall}`);
    this.send("ACTION=START");
    this.t0Us = nowUs();
    this.nextAtUs = this.t0Us;
    this.paused = false;
    this.clearTimer();
    this.scheduleNext();
    log.info(`[ap2] ${this.a.deviceId} 重锚(${reason}) anchor=+${leadMs}ms`);
  }

  private scheduleNext(): void {
    if (this.stopped || this.paused) return;
    const now = nowUs();
    // 事件循环卡顿后不要试图追一堆过期批次:重定基准,producer 自己按墙钟取正确内容。
    if (now - this.nextAtUs > CHUNK_US * MAX_LAG_CHUNKS) this.nextAtUs = now;
    const delayMs = Math.max(0, (this.nextAtUs - now) / 1000);
    this.timer = setTimeout(() => { void this.pumpOnce(); }, delayMs);
    this.timer.unref?.();
  }

  private async pumpOnce(): Promise<void> {
    if (this.stopped || this.paused || !this.producer) return;
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) return;
    this.nextAtUs += CHUNK_US;
    let buf: Buffer | null = null;
    try {
      buf = await this.producer();
    } catch (e: any) {
      log.warn(`[ap2] ${this.a.deviceId} 取 PCM 失败: ${e?.message || e}`);
    }
    if (buf && buf.length > 0 && !this.stopped && !this.paused) {
      try {
        if (!stdin.write(buf)) await once(stdin, "drain").catch(() => {});
      } catch { /* 进程已退,由 exit 回调收口 */ }
    }
    this.scheduleNext();
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private send(line: string): void {
    if (this.pipeFd === null) return;
    try {
      fs.writeSync(this.pipeFd, `${line}\n`);
    } catch (e: any) {
      // EPIPE = 二进制已退出;让 exit 回调统一收口,这里不抛。
      log.debug(`[ap2] ${this.a.deviceId} 命令写入失败(${line}): ${e?.message || e}`);
    }
  }

  /** 推一次元数据(Sonos 等接收端在收到 metadata 前不出声,README 明确)。
   *  起播时二进制自己也会推一次初始集合,这里补上曲目信息让接收端显示正确。 */
  private pushMeta(): void {
    const { title, artist, album, durationSec } = this.a;
    if (!title && !artist && !album) return;
    if (title) this.send(`TITLE=${title}`);
    if (artist) this.send(`ARTIST=${artist}`);
    if (album) this.send(`ALBUM=${album}`);
    if (durationSec && durationSec > 0) this.send(`DURATION=${Math.round(durationSec)}`);
    this.send("ACTION=SENDMETA");
  }

  private openPipe(): Promise<number> {
    const deadline = Date.now() + PIPE_OPEN_RETRY_MS;
    return new Promise<number>((resolve, reject) => {
      const tryOpen = () => {
        try {
          // O_NONBLOCK:无读端时立刻 ENXIO 而不是永久阻塞,便于重试。
          const fd = fs.openSync(this.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
          resolve(fd);
        } catch (e: any) {
          // ENOENT = FIFO **本身已经不在了**(被并发拆除的会话 unlink 掉),
          // 不是「读端还没打开」。这种情况重试再久也不会出现,只会白白把
          // 5s 预算烧完 —— 2026-10-24 真机实测:组成员因此被拖 13s 后整场静音,
          // 并且把整组的起播一起拖慢。立即失败,让上层(桥接编排)按「该成员跳过 /
          // 重试一次」处理。
          const gone = e?.code === "ENOENT";
          if (gone || this.stopped || Date.now() > deadline) {
            reject(new Error(
              `AP2 命令管道无读端(${this.pipePath}): ${e?.code || e?.message}` +
                (gone ? "[FIFO 已被拆除]" : ""),
            ));
            return;
          }
          setTimeout(tryOpen, 100).unref?.();
        }
      };
      tryOpen();
    });
  }

  private closePipe(): void {
    if (this.pipeFd !== null) {
      try { fs.closeSync(this.pipeFd); } catch { /* ignore */ }
      this.pipeFd = null;
    }
    try { fs.unlinkSync(this.pipePath); } catch { /* ignore */ }
  }

  private kill(): void {
    const p = this.proc;
    if (p && !p.killed) {
      try { p.kill("SIGKILL"); } catch { /* ignore */ }
    }
    this.closePipe();
    if (this.usesPtp) { this.usesPtp = false; ptpDaemon.release(); }
  }

  /** 读 stdout/stderr:解析 [STATUS] 行;stderr 只留尾部 40 行(诊断)。
   *  README 明确:生命周期行在 stderr,`route`/`capabilities`/`latency` 在 stdout
   *  ⇒ **两个流都要读**,只读一个必然等不到 latency。 */
  private attachReaders(proc: ChildProcess): void {
    proc.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
        const line = this.stdoutBuf.slice(0, idx).trim();
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
        if (line) this.onLine(line, "stdout");
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBuf += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.stderrBuf.indexOf("\n")) >= 0) {
        const line = this.stderrBuf.slice(0, idx).trim();
        this.stderrBuf = this.stderrBuf.slice(idx + 1);
        if (line) this.onLine(line, "stderr");
      }
    });
    proc.once("exit", (code, sig) => this.onExit(code, sig));
  }

  private onLine(line: string, src: "stdout" | "stderr"): void {
    if (src === "stderr") {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    }
    if (!line.includes("[STATUS]")) {
      // 非状态行只在 debug 级别透出(二进制日志很吵)。
      log.debug(`[ap2:${this.a.deviceId}:${src}] ${line}`);
      return;
    }
    if (line.includes("latency")) {
      // `[STATUS] latency warm_lead_ms=600 render_lead_ms=.. window_ms=..`
      const m = /warm_lead_ms=(\d+)/.exec(line);
      if (m) {
        const ms = Number(m[1]);
        if (Number.isFinite(ms) && ms > 0 && ms <= 3000) {
          // 保留 `latency` 行里的真实 queue depth;ANCHOR_MARGIN 在 start() 里再叠加。
          this.baseLeadMs = ms;
        }
      }
      log.info(`[ap2:${this.a.deviceId}] ${line.replace(/^\[STATUS\]\s*/, "")}`);
      if (!this.latencySeen) { this.latencySeen = true; this.latencyResolve?.(); }
      return;
    }
    if (line.includes("started")) {
      const m = /requested_unix_ms=(\d+)\s+at_unix_ms=(\d+)/.exec(line);
      if (m) {
        const deltaMs = Number(m[2]) - Number(m[1]);
        if (Math.abs(deltaMs) > 5) {
          // 锚点被前移到最早可行时刻 ⇒ 补偿进 lead,下一批取到正确位置(时间线自愈)。
          this.leadAdjustUs += deltaMs * 1000;
          log.warn(
            `[ap2:${this.a.deviceId}] 锚点被修正 ${deltaMs}ms(请求 ${m[1]} → 实际 ${m[2]}),` +
              `lead 补偿后 ${Math.round(this.effectiveLeadUs() / 1000)}ms`,
          );
        } else {
          log.info(`[ap2:${this.a.deviceId}] 锚点精确履约(${m[2]})`);
        }
      } else if (line.includes("head_unix_ms")) {
        log.debug(`[ap2:${this.a.deviceId}] ${line}`);
      }
      return;
    }
    if (line.includes("connected")) {
      log.info(`[ap2:${this.a.deviceId}] 会话已连接`);
      return;
    }
    if (line.includes("eof")) {
      log.info(`[ap2:${this.a.deviceId}] 输入结束(eof)`);
      return;
    }
    log.debug(`[ap2:${this.a.deviceId}] ${line}`);
  }

  private waitLatency(): Promise<void> {
    if (this.latencySeen) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.latencyResolve = resolve;
      const t = setTimeout(() => {
        if (!this.latencySeen) {
          // 二进制没给 latency 行:用默认 600ms 继续(能出声,同步精度略降)。
          log.warn(`[ap2:${this.a.deviceId}] 未在 ${LATENCY_WAIT_MS}ms 内收到 latency 行,按默认 600ms 继续`);
          resolve();
        }
      }, LATENCY_WAIT_MS);
      t.unref?.();
    });
  }

  private onExit(code: number | null, sig: string | null): void {
    this.clearTimer();
    this.closePipe();
    if (this.exiting) return;
    this.stopped = true;
    if (this.usesPtp) { this.usesPtp = false; ptpDaemon.release(); }
    const info: CliSinkEndInfo = {
      positionSec: this.positionSec,
      durationSec: this.a.durationSec || 0,
      tailLog: this.stderrTail.slice(-12).join("\n"),
    };
    log.info(
      `[ap2] ${this.a.deviceId} 进程退出(code=${code} sig=${sig}) 落点=${info.positionSec.toFixed(1)}s/${info.durationSec.toFixed(1)}s`,
    );
    try { this.onEnd?.(info); } catch (e: any) { log.warn(`[ap2] onEnd 回调异常: ${e?.message || e}`); }
  }
}

function clampVolume(v: number | undefined): number {
  if (!Number.isFinite(v as number)) return 50;
  return Math.min(100, Math.max(0, Math.round(v as number)));
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48);
}
