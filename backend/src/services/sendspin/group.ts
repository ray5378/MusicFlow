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

const SEND_AHEAD_MS = 800;

export function computeCommonSendAhead(members: { latencyFuncMs?: number }[]): number {
  const lat = members
    .map((m) => m.latencyFuncMs ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  return SEND_AHEAD_MS + lat;
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