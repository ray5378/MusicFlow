// ==================== ESPHome Native API 只读桥接(6053) ====================
//
// 职责边界是**实测推出来的**,不是拍脑袋定的 —— 2026-09-18 真机取证:
// 设备 esp32-player-meet 在 6053 上只暴露 1 个实体 `Speaker Media Player`
// (platform: speaker_source;yaml 里 sendspin 那个 media_player 没写 `name`,
//  ESPHome 不会把无 name 的实体暴露到 API)。其 featureFlags = 0x12520d ⇒
// 只有 PAUSE / STOP / VOLUME_SET / VOLUME_MUTE / VOLUME_UP,
// **没有 SEEK / NEXT_TRACK / PREVIOUS_TRACK / PLAY**。
//
// 为什么会这样:该实体背后是 speaker media pipeline,面前只有一条 PCM 流,
// 压根没有「曲目」和「队列」的概念 ⇒ 切歌/进度的权威天然在我们服务端
// (QueueController / streamEngine),起播也只能由 Sendspin `stream/start` 完成。
//
// 因此本文件的职责严格限定为两件事:
//   1) **保活**:常驻一个 Native API 客户端。`api.reboot_timeout` 的计时只认 6053
//      上的连接 —— HA 离线时,这条连接就是设备眼里那个「client」,避免它被看门狗重启。
//   2) **只读镜像**:把设备侧真实上报的 media_player state / volume 读回来,作为
//      「服务端推的流到底有没有真的播出去」的**外部判据**,不依赖服务端自证。
//
// ⚠️ 明确不做:不发任何 MediaPlayerCommand。音量尤其不要从这条链路设 —— 6053 的
//    volume 是 speaker **硬件输出音量**,与 Sendspin group volume 相乘,两边都调
//    会语义打架。音量首选仍是 Sendspin group volume。
//
// 实现要点(都是踩过的坑):
//   - PSK 字段名叫 **`psk`**(不是 `encryptionKey`);写错会走明文握手,被设备用
//     0x01 noise 指示字节打回(EncryptionRequiredError / PROTOCOL_MISMATCH)。
//   - 设备侧 `KEEPALIVE_TIMEOUT_MS = 60000` ⇒ 心跳必须 < 60s。库默认「30s idle /
//     60s stall」已满足,**不要关掉 keepAlive**。
//   - `max_send_queue` 默认 8 ⇒ **绝不订阅 logs**:日志流量大,消费慢会被设备踢。
//   - `reboot_timeout: 0s` 或由 HA 常驻时,这条连接只有低位价值,请把它当监控面用。

import { EspHomeClient } from "esphome-client";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Esphome");

/** 默认 Native API 端口。 */
export const ESPHOME_API_PORT = 6053;

/** api.proto `MediaPlayerState`。 */
const MEDIA_PLAYER_STATE_NAMES: Record<number, string> = {
  0: "NONE",
  1: "IDLE",
  2: "PLAYING",
  3: "PAUSED",
  4: "ANNOUNCING",
  5: "OFF",
  6: "ON",
};

export function mediaPlayerStateName(state: number): string {
  return MEDIA_PLAYER_STATE_NAMES[state] ?? `UNKNOWN(${state})`;
}

export interface EsphomeBridgeConfig {
  /** 总开关(插件配置 `esphome_mirror`)。 */
  enabled: boolean;
  /** 设备 `api.encryption.key`(base64,32 字节)。空则不连。 */
  psk: string;
  /** Native API 端口,通常不用改。 */
  port: number;
}

export interface MirroredMediaPlayer {
  /** 实体 key(设备侧数字 ID 的字符串形式)。 */
  key: string;
  name: string;
  /** 原始枚举值。 */
  state: number;
  /** 枚举名,如 `PLAYING`。 */
  stateName: string;
  /** 0..1,speaker 硬件输出音量(注意:不是 Sendspin group volume)。 */
  volume: number;
  muted: boolean;
  updatedAt: number;
}

export interface EsphomeDeviceMirror {
  host: string;
  deviceName: string;
  esphomeVersion: string;
  connected: boolean;
  connectedAt: number;
  lastStateAt: number;
  lastError: string;
  players: MirroredMediaPlayer[];
}

interface Entry {
  host: string;
  psk: string;
  port: number;
  cli: EspHomeClient | null;
  deviceName: string;
  esphomeVersion: string;
  connected: boolean;
  connectedAt: number;
  lastStateAt: number;
  lastError: string;
  /** key → 最新镜像状态。 */
  states: Map<string, MirroredMediaPlayer>;
  /** 已发现实体的 key → 名字(用于在状态到达前也能显示 Entity 存在)。 */
  entities: Map<string, string>;
}

/** 保活目标上限:防止动态 IP 设备换地址后无限堆积。超出后丢弃最久未 attach 的。 */
const MAX_DEVICES = 16;

function normalizePsk(psk: unknown): string {
  return typeof psk === "string" ? psk.trim() : "";
}

function normalizePort(port: unknown): number {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : ESPHOME_API_PORT;
}

class EsphomeBridge {
  private entries = new Map<string, Entry>();
  private cfg: EsphomeBridgeConfig = { enabled: false, psk: "", port: ESPHOME_API_PORT };
  /** attach 顺序(淘汰用)。 */
  private order: string[] = [];

  /** 热更新配置(插件页保存时调用)。开关/psk/端口任一变化都会重连。 */
  configure(next: Partial<EsphomeBridgeConfig>): void {
    const before = this.cfg;
    this.cfg = {
      enabled: next.enabled !== undefined ? next.enabled === true : before.enabled,
      psk: normalizePsk(next.psk ?? before.psk),
      port: normalizePort(next.port ?? before.port),
    };
    const changed =
      this.cfg.enabled !== before.enabled ||
      this.cfg.psk !== before.psk ||
      this.cfg.port !== before.port;
    if (!changed) return;
    if (!this.cfg.enabled || !this.cfg.psk) {
      log.info("ESPHome 只读桥接已停用(断开全部 6053 连接)");
      this.stop();
      return;
    }
    // PSK / 端口变了必须重建全部连接(旧 client 用的是旧凭据)。
    for (const host of [...this.entries.keys()]) this.closeEntry(host);
    for (const host of this.order) this.attach(host);
  }

  currentConfig(): EsphomeBridgeConfig {
    return { ...this.cfg };
  }

  /** 记录一个保活目标(Sendspin 设备上线时由 index.ts 调用)。幂等。
   *  未启用或缺 PSK 时只登记不连接,待配置就绪后由 configure() 补连。 */
  attach(hostRaw: string): void {
    const host = hostRaw?.trim();
    if (!host) return;
    // 已在该 host 上建过连接:幂等返回,避免重复 connect 占掉设备 slot。
    if (this.entries.has(host)) return;
    this.order = this.order.filter((h) => h !== host);
    this.order.push(host);
    while (this.order.length > MAX_DEVICES) {
      const drop = this.order.shift();
      if (drop) this.closeEntry(drop);
    }
    if (!this.cfg.enabled || !this.cfg.psk) return;
    this.spawn(host);
  }

  private spawn(host: string): void {
    const entry: Entry = {
      host,
      psk: this.cfg.psk,
      port: this.cfg.port,
      cli: null,
      deviceName: "",
      esphomeVersion: "",
      connected: false,
      connectedAt: 0,
      lastStateAt: 0,
      lastError: "",
      states: new Map(),
      entities: new Map(),
    };
    this.entries.set(host, entry);
    const cli = new EspHomeClient({
      host,
      port: this.cfg.port,
      // ⚠️ 字段名必须是 psk。写成 encryptionKey 会被静默降级为明文握手而失败。
      psk: this.cfg.psk,
      clientId: "musicflow",
      // 自动重连:backoff + jitter,设备 OTA/重启后能自愈(默认已开启,这里显式放慢首重试)。
      reconnect: { initialDelayMs: 2_000, maxDelayMs: 30_000 },
      // 心跳:默认 30s idle / 60s stall,满足设备 KEEPALIVE_TIMEOUT_MS=60000,保持默认。
      logger: {
        debug: () => {},
        info: () => {},
        warn: (...a: unknown[]) => log.warn(`[${host}] ${a.join(" ")}`),
        error: (...a: unknown[]) => log.warn(`[${host}] ${a.join(" ")}`),
      },
    });
    entry.cli = cli;

    cli.on("deviceInfo", (d: any) => {
      entry.deviceName = String(d?.name ?? "");
      entry.esphomeVersion = String(d?.esphomeVersion ?? "");
      entry.connected = true;
      entry.connectedAt = Date.now();
      entry.lastError = "";
      log.info(`6053 已连接 ${host}(${entry.deviceName} ${entry.esphomeVersion})`);
    });
    cli.on("entities", (list: any[]) => {
      for (const e of list ?? []) {
        if (e?.key === undefined) continue;
        entry.entities.set(String(e.key), String(e.name ?? e.objectId ?? e.type ?? ""));
      }
    });
    cli.on("media_player", (ev: any) => {
      const key = String(ev?.key ?? "");
      if (!key) return;
      const state = Number(ev?.state ?? 0);
      const prev = entry.states.get(key);
      entry.states.set(key, {
        key,
        name: String(ev?.entity ?? entry.entities.get(key) ?? key),
        state,
        stateName: mediaPlayerStateName(state),
        volume: Number(ev?.volume ?? prev?.volume ?? 0),
        muted: Boolean(ev?.muted ?? prev?.muted ?? false),
        updatedAt: Date.now(),
      });
      entry.lastStateAt = Date.now();
    });
      // 连接态统一走 `lifecycle`:`connect`(带 encrypted 标志)/ `disconnect`(带 cause)。
      // 库没有独立的 "error" 事件 —— 失败原因挂在 disconnect.cause 上(EspHomeError)。
      cli.on("lifecycle", (ev: any) => {
        if (ev?.kind === "connect") {
          entry.connected = true;
          entry.connectedAt = Date.now();
          entry.lastError = "";
        } else if (ev?.kind === "disconnect") {
          entry.connected = false;
          entry.lastError = ev?.cause?.message ? String(ev.cause.message) : "";
        }
      });

    // connect() 失败不抛到调用方:保活是尽力而为,不该拖垮 Sendspin 服务启动。
    cli.connect().catch((e: any) => {
      entry.lastError = String(e?.message ?? e);
      log.warn(`6053 连接失败 ${host}(将按退避重试): ${entry.lastError}`);
    });
  }

  private closeEntry(host: string): void {
    const e = this.entries.get(host);
    if (!e) return;
    try {
      e.cli?.disconnect();
    } catch { /* 忽略关闭异常 */ }
    this.entries.delete(host);
  }

  /** 断开并清空全部目标(插件停用 / 服务停止)。 */
  stop(): void {
    for (const host of [...this.entries.keys()]) this.closeEntry(host);
    this.entries.clear();
    this.order = [];
  }

  /** 全量快照:供 API 与日志消费。 */
  snapshot(): EsphomeDeviceMirror[] {
    const out: EsphomeDeviceMirror[] = [];
    for (const e of this.entries.values()) {
      // 已发现但还没收到状态事件的实体也要露出来(前端能看到「有这个 entity」)。
      const players = [...e.states.values()];
      for (const [key, name] of e.entities) {
        if (e.states.has(key)) continue;
        players.push({
          key,
          name,
          state: 0,
          stateName: mediaPlayerStateName(0),
          volume: 0,
          muted: false,
          updatedAt: 0,
        });
      }
      out.push({
        host: e.host,
        deviceName: e.deviceName,
        esphomeVersion: e.esphomeVersion,
        connected: e.connected,
        connectedAt: e.connectedAt,
        lastStateAt: e.lastStateAt,
        lastError: e.lastError,
        players,
      });
    }
    return out;
  }

  /** 单设备是否在播(read-only 判据):只看最近 30s 内上报过 PLAYING。 */
  isPlaying(host: string): boolean {
    const e = this.entries.get(host);
    if (!e) return false;
    const fresh = Date.now() - 30_000;
    return [...e.states.values()].some(
      (p) => p.state === 2 && p.updatedAt >= fresh,
    );
  }
}

export interface EsphomeProbeResult {
  host: string;
  ok: boolean;
  deviceName: string;
  esphomeVersion: string;
  players: MirroredMediaPlayer[];
  /** 失败原因。**故意不带本地化文案** —— 交给前端用 i18n key 拼装,避免后端写死语言。 */
  error: string;
  /** 失败原因的归类码,便于前端映射到不同提示。 */
  errorCode: "none" | "timeout" | "no_psk" | "no_host" | "auth" | "network" | "unknown";
}

/** 一次性握手探针(插件页「测试连接」按钮)。
 *  刻意**不复用常驻连接**:测试要用用户此刻填的 PSK 立即验证,不受已运行实例影响,
 *  也不该污染常态连接(测完立刻 disconnect,不留残余 slot)。 */
export async function probeEsphome(
  hostRaw: string,
  pskRaw: string,
  port = ESPHOME_API_PORT,
  timeoutMs = 10_000,
): Promise<EsphomeProbeResult> {
  const host = String(hostRaw || "").trim();
  const psk = String(pskRaw || "").trim();
  const empty: Omit<EsphomeProbeResult, "error" | "errorCode"> = {
    host,
    ok: false,
    deviceName: "",
    esphomeVersion: "",
    players: [],
  };
  if (!psk) return { ...empty, error: "missing psk", errorCode: "no_psk" };
  if (!host) return { ...empty, error: "no device host", errorCode: "no_host" };

  const states = new Map<string, MirroredMediaPlayer>();
  const entities = new Map<string, string>();
  let cli: EspHomeClient | null = null;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    cli = new EspHomeClient({
      host,
      port,
      psk,
      clientId: "musicflow-probe",
      // 探针是一次性的:关掉自动重连,失败就是失败,不要后台反复拨。
      reconnect: false,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    cli.on("entities", (list: any[]) => {
      for (const e of list ?? []) {
        if (e?.key === undefined) continue;
        entities.set(String(e.key), String(e.name ?? e.objectId ?? e.type ?? ""));
      }
    });
    cli.on("media_player", (ev: any) => {
      const key = String(ev?.key ?? "");
      if (!key) return;
      const state = Number(ev?.state ?? 0);
      states.set(key, {
        key,
        name: String(ev?.entity ?? entities.get(key) ?? key),
        state,
        stateName: mediaPlayerStateName(state),
        volume: Number(ev?.volume ?? 0),
        muted: Boolean(ev?.muted ?? false),
        updatedAt: Date.now(),
      });
    });

    const result = await new Promise<EsphomeProbeResult>((resolve) => {
      let deviceName = "";
      let esphomeVersion = "";
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ...empty, error: "handshake timeout", errorCode: "timeout" });
      }, timeoutMs);

      cli!.on("deviceInfo", (d: any) => {
        deviceName = String(d?.name ?? "");
        esphomeVersion = String(d?.esphomeVersion ?? "");
        // 握手走到了 deviceInfo 就算连上。再给 2.5s 收一波状态反馈给用户看,
        // 但**不阻塞成功判定**(有些设备在没有实体状态时不推)。
        setTimeout(() => {
          if (done) return;
          done = true;
          resolve({
            host,
            ok: true,
            deviceName,
            esphomeVersion,
            players: [...states.values()],
            error: "",
            errorCode: "none",
          });
        }, 2500);
      });

      cli!.connect().catch((e: any) => {
        if (done) return;
        done = true;
        const msg = String(e?.message ?? e ?? "connect failed");
        // 错误码直接判来源:PSK 错会以 cryptography/authentication 失败呈现。
        const code = /auth|psk|key|decrypt|handshake/i.test(msg) ? "auth" : /timeout|econn|enotfound|unreach/i.test(msg) ? "network" : "unknown";
        resolve({ ...empty, error: msg, errorCode: code });
      });
    });
    return result;
  } catch (e: any) {
    return { ...empty, error: String(e?.message ?? e), errorCode: "unknown" };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      cli?.disconnect();
    } catch { /* 忽略关闭异常 */ }
  }
}

export const esphomeBridge = new EsphomeBridge();
