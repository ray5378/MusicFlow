// ==================== ESPHome Native API 桥接(6053) ====================
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
// 因此本文件的职责限定为三件事:
//   1) **保活**:常驻一个 Native API 客户端。`api.reboot_timeout` 的计时只认 6053
//      上的连接 —— HA 离线时,这条连接就是设备眼里那个「client」,避免它被看门狗重启。
//   2) **只读镜像**:把设备侧真实上报的 media_player state / volume 读回来,作为
//      「服务端推的流到底有没有真的播出去」的**外部判据**,不依赖服务端自证。
//   3) **设备自身音量/静音写入**(2026-09-19 解禁,见下)。
//
// ── 关于第 3 条(为什么现在允许写音量了) ──────────────────────────────
// 早期注释写过「音量尤其不要从这条链路设」,理由是怕和 Sendspin group volume
// 语义打架。现在想清楚了:**两者并不冲突,因为它们是两个不同的旋钮** ——
//   - Sendspin group volume = 服务端推流时写的**音频采样增益**(音乐音量);
//   - 6053 的 volume       = speaker **硬件输出音量**(设备自己的电位器)。
// 实际听到的响度 = 两者相乘。用户要调设备自身音量(比如客厅那台功放旋钮太吵),
// 只能走 6053,采样增益做不到。所以此处只开放 VOLUME / MUTE 两个写入,
// **依然不发任何播放类命令**(PLAY/STOP/切歌),那是 Sendspin 的职责。
//
// ── 关于密钥(关键:per-device,不是全局一把) ─────────────────────────
// ESPHome 的 `api.encryption.key` 是**每台设备各自生成**的(Dashboard 里每台一行)。
// 早期版本在插件页放了一个全局 psk 给所有设备共用 ⇒ 装三台只有一台连得上,
// 另外两台在日志里静静失败;更糟的是「测试连接」端点取的是「任意一台已连设备的 IP」
// (`.find(Boolean)`),用户填 A 的密钥却拿 B 的门去试,必然 auth 失败,
// 让人误以为自己抄错了密钥。现改为**每台设备各自一把**,由调用方按 clientId
// 查出来后经 `syncDevice(host, psk, port)` 传入 —— host 是连接派生的(会变),
// clientId 才是稳定标识。
//
// 实现要点(都是踩过的坑):
//   - PSK 字段名叫 **`psk`**(不是 `encryptionKey`);写错会走明文握手,被设备用
//     0x01 noise 指示字节打回(EncryptionRequiredError / PROTOCOL_MISMATCH)。
//   - 设备侧 `KEEPALIVE_TIMEOUT_MS = 60000` ⇒ 心跳必须 < 60s。库默认「30s idle /
//     60s stall」已满足,**不要关掉 keepAlive**。
//   - `max_send_queue` 默认 8 ⇒ **绝不订阅 logs**:日志流量大,消费慢会被设备踢。
//   - `reboot_timeout: 0s` 或由 HA 常驻时,这条连接只有低位价值,请把它当监控面用。
//   - 命令用 `command()`(fire-and-forget)。写入是否生效由**后续 media_player
//     状态回显**验证 —— 桥本来就在镜像状态,UI 读到的就是设备真值。

import { EspHomeClient, entityId, MediaPlayerCommand } from "esphome-client";
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

export interface MirroredMediaPlayer {
  /** 实体 key(设备侧数字 ID 的字符串形式)。 */
  key: string;
  name: string;
  /** ESPHome object_id(`entityId("media_player", objectId)` 用它拼命令目标)。 */
  objectId: string;
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
  /** 这台设备有没有配自己的密钥(⚠️ 不回显密钥本身)。 */
  pskConfigured: boolean;
  /** 实际使用的端口。 */
  port: number;
  players: MirroredMediaPlayer[];
}

/** 写入类命令的结果。 */
export interface EsphomeWriteResult {
  ok: boolean;
  /** 机器可读结果码,便于前端映射提示。 */
  code: "ok" | "no-bridge" | "not-connected" | "no-entity" | "send-failed";
  /** 实际发出的实体数(一台设备可能有多个 media_player 实体)。 */
  sent: number;
}

interface EntityMeta {
  name: string;
  objectId: string;
  type: string;
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
  /** 已发现实体的 key → 元信息(用于在状态到达前也能显示 Entity 存在)。 */
  entities: Map<string, EntityMeta>;
}

/** 保活目标上限:防止动态 IP 设备换地址后无限堆积。超出后丢弃最久未 attach 的。 */
const MAX_DEVICES = 16;

function normalizePsk(psk: unknown): string {
  return typeof psk === "string" ? psk.trim() : "";
}

/** 端口:0 / 非法 → 回落 fallback(缺省 6053)。 */
function normalizePort(port: unknown, fallback = ESPHOME_API_PORT): number {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

class EsphomeBridge {
  private entries = new Map<string, Entry>();
  /** attach 顺序(淘汰用)。 */
  private order: string[] = [];

  /** 登记/更新**一台设备**的 6053 凭据。幂等。
   *
   *  - `psk` 为空 ⇒ 这台不连:断开已有连接并撤销登记(用户清掉密钥就用这条);
   *  - 凭据有变化 ⇒ 关闭旧连接再重建(旧 client 握的是旧凭据,改了必须重来);
   *  - 无变化 ⇒ 直接返回,不重复 connect(设备侧 client slot 有限)。
   *
   *  ⚠️ 没有全局开关了:填了密钥就连,没填就不连。 */
  syncDevice(hostRaw: string, pskRaw: unknown, portRaw?: unknown): void {
    const host = String(hostRaw || "").trim();
    if (!host) return;
    const psk = normalizePsk(pskRaw);
    const port = normalizePort(portRaw);

    const cur = this.entries.get(host);
    if (!psk) {
      if (cur) this.closeEntry(host);
      this.order = this.order.filter((h) => h !== host);
      return;
    }
    if (cur) {
      if (cur.psk === psk && cur.port === port) return;
      this.closeEntry(host);
    }
    this.order = this.order.filter((h) => h !== host);
    this.order.push(host);
    while (this.order.length > MAX_DEVICES) {
      const drop = this.order.shift();
      if (drop) this.closeEntry(drop);
    }
    this.spawn(host, psk, port);
  }

  /** 批量同步(启动 / 配置热更新):列表里的按各自凭据连,不在列表里的一律断开。 */
  syncAll(list: { host?: string; psk?: string; port?: number }[]): void {
    const want = new Set<string>();
    for (const it of list ?? []) {
      const host = String(it?.host || "").trim();
      if (!host) continue;
      want.add(host);
      this.syncDevice(host, it?.psk ?? "", it?.port ?? 0);
    }
    for (const host of [...this.entries.keys()]) {
      if (!want.has(host)) this.closeEntry(host);
    }
    this.order = this.order.filter((h) => want.has(h));
  }

  private spawn(host: string, psk: string, port: number): void {
    const entry: Entry = {
      host,
      psk,
      port,
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
      port,
      // ⚠️ 字段名必须是 psk。写成 encryptionKey 会被静默降级为明文握手而失败。
      psk,
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
        entry.entities.set(String(e.key), {
          name: String(e?.name ?? e?.objectId ?? e?.type ?? ""),
          // objectId 是发命令时拼 EntityId 的原料,必须留下来。
          objectId: String(e?.objectId ?? ""),
          type: String(e?.type ?? ""),
        });
      }
    });
    cli.on("media_player", (ev: any) => {
      const key = String(ev?.key ?? "");
      if (!key) return;
      const state = Number(ev?.state ?? 0);
      const prev = entry.states.get(key);
      const meta = entry.entities.get(key);
      entry.states.set(key, {
        key,
        name: String(ev?.entity ?? meta?.name ?? key),
        objectId: String(meta?.objectId ?? ""),
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

  /** 断开并清空全部目标(服务停止)。 */
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
      for (const [key, meta] of e.entities) {
        if (e.states.has(key)) continue;
        players.push({
          key,
          name: meta.name || key,
          objectId: meta.objectId,
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
        pskConfigured: !!e.psk,
        port: e.port,
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

  /** 这台设备当前镜像到的音量(0..1)与静音态;没连上返回 null。 */
  mirroredVolume(host: string): { volume: number; muted: boolean } | null {
    const e = this.entries.get(host);
    if (!e) return null;
    const p = [...e.states.values()].find((x) => x.updatedAt > 0);
    if (!p) return null;
    return { volume: p.volume, muted: p.muted };
  }

  /** 取出该设备上所有 media_player 实体的命令目标。 */
  private mediaPlayerIds(e: Entry): ReturnType<typeof entityId<"media_player">>[] {
    const ids: ReturnType<typeof entityId<"media_player">>[] = [];
    for (const meta of e.entities.values()) {
      // 没 objectId 就拼不出 EntityId;非 media_player 实体不该收到音量命令。
      if (!meta.objectId) continue;
      if (meta.type && meta.type !== "media_player") continue;
      ids.push(entityId("media_player", meta.objectId));
    }
    return ids;
  }

  /** 设**设备自身**音量(0..1,speaker 硬件输出),与音乐采样增益无关。
   *  fire-and-forget:是否生效看后续 media_player 状态回显(桥本身就在镜像)。 */
  setVolume(hostRaw: string, volume: number): EsphomeWriteResult {
    const host = String(hostRaw || "").trim();
    const e = host ? this.entries.get(host) : undefined;
    if (!e) return { ok: false, code: "no-bridge", sent: 0 };
    if (!e.connected || !e.cli) return { ok: false, code: "not-connected", sent: 0 };
    const ids = this.mediaPlayerIds(e);
    if (!ids.length) return { ok: false, code: "no-entity", sent: 0 };

    const v = Math.min(1, Math.max(0, Number(volume) || 0));
    let sent = 0;
    for (const id of ids) {
      try {
        e.cli.command(id, { volume: v });
        sent++;
      } catch (err: any) {
        log.warn(`6053 写音量失败 ${host}: ${err?.message || err}`);
      }
    }
    if (sent) log.info(`6053 写音量 ${host} → ${(v * 100).toFixed(0)}%(${sent} 个实体)`);
    return { ok: sent > 0, code: sent > 0 ? "ok" : "send-failed", sent };
  }

  /** 设**设备自身**静音。同上,只发 MUTE / UNMUTE,不碰播放类命令。 */
  setMuted(hostRaw: string, muted: boolean): EsphomeWriteResult {
    const host = String(hostRaw || "").trim();
    const e = host ? this.entries.get(host) : undefined;
    if (!e) return { ok: false, code: "no-bridge", sent: 0 };
    if (!e.connected || !e.cli) return { ok: false, code: "not-connected", sent: 0 };
    const ids = this.mediaPlayerIds(e);
    if (!ids.length) return { ok: false, code: "no-entity", sent: 0 };

    const cmd = muted ? MediaPlayerCommand.MUTE : MediaPlayerCommand.UNMUTE;
    let sent = 0;
    for (const id of ids) {
      try {
        e.cli.command(id, { command: cmd });
        sent++;
      } catch (err: any) {
        log.warn(`6053 写静音失败 ${host}: ${err?.message || err}`);
      }
    }
    if (sent) log.info(`6053 写静音 ${host} → ${muted ? "mute" : "unmute"}(${sent} 个实体)`);
    return { ok: sent > 0, code: sent > 0 ? "ok" : "send-failed", sent };
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

/** 一次性握手探针(设备行「测试连接」按钮)。
 *  刻意**不复用常驻连接**:测试要用用户此刻填的 PSK 立即验证,不受已运行实例影响,
 *  也不该污染常态连接(测完立刻 disconnect,不留残余 slot)。
 *
 *  ⚠️ host 必须由调用方**明确指定是哪台设备** —— 早期版本取「任意一台已连设备的 IP」
 *  (`.find(Boolean)`),导致填 A 的密钥却拿 B 的门去试,必然 auth 失败。 */
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
  const entities = new Map<string, EntityMeta>();
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
        entities.set(String(e.key), {
          name: String(e?.name ?? e?.objectId ?? e?.type ?? ""),
          objectId: String(e?.objectId ?? ""),
          type: String(e?.type ?? ""),
        });
      }
    });
    cli.on("media_player", (ev: any) => {
      const key = String(ev?.key ?? "");
      if (!key) return;
      const state = Number(ev?.state ?? 0);
      const meta = entities.get(key);
      states.set(key, {
        key,
        name: String(ev?.entity ?? meta?.name ?? key),
        objectId: String(meta?.objectId ?? ""),
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
