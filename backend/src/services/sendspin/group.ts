// ==================== 组模型 + 组音量分 ====================
//
// 对照 MA `group volume`(clamp 补偿法)与 aiosendspin group.py。维护组内 player 的
// 独立 volume/mute,并计算「组公共播放量」与「每条流发送余量」。

export type PlayerGain = { volume: number; muted: boolean };

/** clamp 补偿:成员音量分别钳制到 [0,100],mute → 0。组公共播放量为 max。 */
export function distributeGroupVolume(members: PlayerGain[]): {
  members: (PlayerGain & { effective: number })[];
  scale: number;
  stagger: number;
} {
  if (members.length === 0) return { members: [], scale: 1, stagger: 0 };
  const out = members.map((m) => {
    const effective = m.muted ? 0 : clamp(m.volume, 0, 100);
    return { ...m, effective };
  });
  return { members: out, scale: 1, stagger: 0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 单个音频块从服务端发出到「应被设备播出」的余量(**微秒**)。
 *
 * ⚠️ 单位是微秒,不是毫秒。协议字段 `send_ahead` 的权威定义见 aiosendspin:
 *   - `models/player.py`:`send_ahead` = "Microseconds from server transmit to timestamp_us"
 *   - `models/player.py` `compute_send_ahead(ts_us, now_us)` = `ts_us - now_us`(微秒差)
 *   - `server/push_stream.py` `DEFAULT_INITIAL_DELAY_US = 250_000  # 250ms`
 *   - 全链路命名均为 `_us` 后缀(`_role_send_ahead_us` / `_min_send_ahead_us`)
 * 曾把它当毫秒填 800 → 设备认为「0.8ms 后就要输出」→ 目标时刻已过 → underrun。
 *
 * ## 设备缺省(未上报 client/state 时的保守值)
 *
 * MA 的合成公式(`_role_send_ahead_us`):
 *   `send_ahead = max(min_buffer_us, required_lead_time_us) + output_delay_us`
 *
 * 设备未上报时用一组**保守缺省**(宁可多留余量导致起播稍慢,也不能少留导致断流):
 *   - min_buffer  : 800ms —— 老版本硬编码值,对 ESP32 类设备实测够用
 *   - required_lead: 0(未知启动开销时不额外加)
 *   - output_delay : 0(未知链路延迟时不额外加)
 * 即缺省 send_ahead = 800ms,与改动前行为**完全一致**(向后兼容旧固件)。
 */
export const DEFAULT_MIN_BUFFER_MS = 800;

export type SendAheadInput = {
  latencyFuncMs?: number;
  /** 设备上报的最低缓冲水位(ms);未上报用缺省。 */
  minBufferMs?: number;
  /** 设备上报的启动提前量需求(ms)。 */
  requiredLeadTimeMs?: number;
  /** 设备上报的输出链路固有延迟(ms)。 */
  outputDelayMs?: number;
};

/** 上报值是否算「有效水位」。0 / 负数 / 非有限值一律视为「未提供」。
 *
 *  ⚠️ 不能用 `??` 判缺省 —— ESPHome 固件的 `client/state` 会把三个参数**全报 0**
 *  (实测 2026-09-17:`output_delay=0ms required_lead=0ms min_buffer=0ms` 每周期都在报)。
 *  0 的语义是「我不需要任何余量」,按 MA 公式直接取 0 → send_ahead=0 → 设备认为
 *  目标时刻已过、立即吐字节 → 缓冲永远空 → underrun 无声。
 *  设备报 0 是**表达能力缺失**(ESPHome 尚未实现这些量),不是真实诉求,
 *  必须回落缺省(宁可起播稍慢也不断流)。 */
function positiveOr(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 组公共 send_ahead(微秒):取全部成员的最大值(MA `_min_send_ahead_us` 语义 ——
 *  名字叫 min 实为「所有活跃 audio role 的最大值」,因为余量必须满足最慢的那个)。
 *
 *  ⚠️ 空成员必须返回**缺省值**而非 0:0 表示「本块应立即输出」,正是 underrun 的成因。
 *  组临时为空(成员正在重连)时若下发 0,重连后的首块会立刻被判「目标时刻已过」。 */
export function computeCommonSendAhead(members: SendAheadInput[]): number {
  if (members.length === 0) return DEFAULT_MIN_BUFFER_MS * 1000;
  let maxUs = 0;
  for (const m of members) {
    const minBuffer = positiveOr(m.minBufferMs, DEFAULT_MIN_BUFFER_MS);
    // MA:live 流不含 required_lead;我们恒为 live 推流,但设备显式报了有效值就以它兜底,
    // 取二者较大值(保守:满足缓冲与启动开销中更严的那个)。
    const lead = Math.max(minBuffer, positiveOr(m.requiredLeadTimeMs, 0));
    const outDelay = positiveOr(m.outputDelayMs, 0);
    const us = (lead + outDelay) * 1000;
    if (us > maxUs) maxUs = us;
  }
  return maxUs;
}

export type GroupProps = {
  id: string;
  volume: number;
  muted: boolean;
  positionMs: number;
  sendAhead: number;
};

export class SendspinGroup {
  id: string;
  volume = 100;
  muted = false;
  positionMs = 0;
  members = new Set<string>();

  get props(): GroupProps {
    return {
      id: this.id,
      volume: this.volume,
      muted: this.muted,
      positionMs: this.positionMs,
      sendAhead: computeCommonSendAhead([]),
    };
  }

  constructor(id: string) {
    this.id = id;
  }
}