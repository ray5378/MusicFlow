// 群组「测试延迟」——每 5 秒一次极短咔哒声,只有该群组内的播放器出声。
//
// 为什么落在「组队列 + 单曲循环」上,而不是直接给桥喂一条音:
//   - 组播放的唯一权威入口是 QueueController(airplay 桥 / sendspin 泵 / DLNA 都从
//     组玩家取流)。自建一条裸音流会让三条链路各长一套旁路,且与组时间线脱钩。
//   - playMode="one" 让 5 分钟样本播完由既有自动推进原地重播 —— 无需自己做定时器,
//     循环语义与用户平时的单曲循环完全同源。
//   - 代价:整队会被替换。停止时按快照(items/index/playMode/进度)恢复,测试期间
//     若组本来在放歌,会被这次测试打断(这是「必生效」的可听代价,已与用户确认)。
//
// 音频来源:临时 songs 行(固定 id)指向生成到数据目录的 WAV。出流仍走既有
// serveCastStream(按 songId 查 songs 表),不必给 DLNA / AirPlay / sendspin
// 任何一条链路加直链旁路。停止后删除该行,不留曲库垃圾。
//
// 样本参数:16kHz 单声道 16bit,峰值约 -5dB,咔哒本体 20ms(前 1.5ms 全幅、
// 之后 3ms 指数衰减)——够短(不掩盖 10~30ms 级的人耳对齐),又能听清。
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { playHistory, playlistSongs, songs, userFavoriteSongs } from "../../db/schema.js";
import { getDataDir } from "../../utils/env.js";
import { createLogger } from "../../utils/logger.js";
import { getQueueController } from "../player/index.js";
import type { PlayMode, QueueItem } from "../player/types.js";
import { getGroupStatus } from "./protocolPlayer.js";

const log = createLogger("Group");

/** 测试音的 songs 行 id(固定:重启后残留的旧行直接覆盖)。 */
const TONE_SONG_ID = "mf-delay-test";
/** 咔哒间隔(秒)。 */
const CLICK_INTERVAL_SEC = 5;
/** 样本时长(秒)= 60 次咔哒一轮;播完由 playMode="one" 原地重播。 */
const TONE_DURATION_SEC = 300;
/** 采样率(单声道 16bit):16k 足够表现清脆的咔哒,5 分钟仅 ~9.6MB。 */
const TONE_RATE = 16_000;
/** 咔哒时长(ms)。 */
const CLICK_MS = 20;

interface PrevQueueState {
  items: QueueItem[];
  index: number;
  playMode: PlayMode;
  contentContext?: string;
  /** 起测时的播放进度(秒),停止后恢复用。 */
  positionSec: number;
  /** 起测时该组是否真在出声(PLAYING)。 */
  wasPlaying: boolean;
  /** 起测时是否处于暂停。 */
  wasPaused: boolean;
}

/** groupId → 起测前的队列现场(仅内存,进程重启即丢失=不恢复)。 */
const activeTests = new Map<string, PrevQueueState>();

/** 测试音文件路径(数据目录下,跨重启复用同一份)。 */
function toneFilePath(): string {
  return join(getDataDir(), "delay-test", `click-${CLICK_INTERVAL_SEC}s.wav`);
}

/** 生成 WAV(若已存在且尺寸正确则跳过)。LCG 噪声源保证同一份文件可复现。 */
function ensureToneFile(): string {
  const file = toneFilePath();
  const expectSize = 44 + TONE_DURATION_SEC * TONE_RATE * 2;
  if (existsSync(file) && statSync(file).size === expectSize) return file;
  mkdirSync(join(getDataDir(), "delay-test"), { recursive: true });

  const frames = TONE_DURATION_SEC * TONE_RATE;
  const pcm = Buffer.alloc(frames * 2);
  let seed = 0x1234_5678;
  const nextNoise = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    return (seed / 0x7fff_ffff) * 2 - 1;
  };
  const attackSec = 0.0015;
  const decaySec = 0.003;
  const clickFrames = Math.round((CLICK_MS / 1000) * TONE_RATE);
  for (let t = 0; t < TONE_DURATION_SEC; t += CLICK_INTERVAL_SEC) {
    const start = t * TONE_RATE;
    for (let i = 0; i < clickFrames && start + i < frames; i++) {
      const sec = i / TONE_RATE;
      const env = sec < attackSec ? 1 : Math.exp(-(sec - attackSec) / decaySec);
      const v = Math.max(-1, Math.min(1, nextNoise() * env * 0.55));
      pcm.writeInt16LE(Math.round(v * 32767), (start + i) * 2);
    }
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(TONE_RATE, 24);
  header.writeUInt32LE(TONE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  writeFileSync(file, Buffer.concat([header, pcm]));
  log.info(`[delay-test] 生成测试音 ${file} (${TONE_DURATION_SEC}s, ${CLICK_INTERVAL_SEC}s 一次)`);
  return file;
}

/** 写入/刷新临时 songs 行(出流侧按 songId 查这一行)。 */
function ensureToneRow(file: string): void {
  const now = new Date().toISOString();
  const row = {
    id: TONE_SONG_ID,
    title: "延迟测试音",
    path: `l:delaytest:${file}`,
    type: "local",
    suffix: "wav",
    contentType: "audio/wav",
    duration: TONE_DURATION_SEC,
    size: statSync(file).size,
    createdAt: now,
    updatedAt: now,
  };
  // 用 upsert 而不是「先删后插」:play_history 等表对 songs.id 是 NO ACTION 外键,
  // 前端 scrobble 会给测试音记一条历史 ⇒ 删主行必然抛 FOREIGN KEY constraint failed
  // (2026-11-01 实测:第二次点「测试延迟」就复现)。upsert 不删行,天然绕开。
  db.insert(songs)
    .values(row)
    .onConflictDoUpdate({
      target: songs.id,
      set: {
        title: row.title,
        path: row.path,
        type: row.type,
        suffix: row.suffix,
        contentType: row.contentType,
        duration: row.duration,
        size: row.size,
        updatedAt: row.updatedAt,
      },
    })
    .run();
}

function removeToneRow(): void {
  // 顺序同 deleteSongDb:先清引用行(playlist_songs / user_favorite_songs / play_history),
  // 再删 songs 主行 —— 反了会因外键 NO ACTION 直接抛错,测试音行就永远删不掉。
  db.delete(playlistSongs).where(eq(playlistSongs.songId, TONE_SONG_ID)).run();
  db.delete(userFavoriteSongs).where(eq(userFavoriteSongs.songId, TONE_SONG_ID)).run();
  db.delete(playHistory).where(eq(playHistory.songId, TONE_SONG_ID)).run();
  db.delete(songs).where(eq(songs.id, TONE_SONG_ID)).run();
}

/** 该组是否正在测试(前端按钮回显)。 */
export function isGroupDelayTestActive(groupId: string): boolean {
  return activeTests.has(groupId);
}

export interface StartDelayTestResult {
  running: boolean;
  intervalMs: number;
  clickMs: number;
  durationSec: number;
}

/**
 * 开始该组的延迟测试。只有该组成员出声(出流走组玩家,不碰其它组/单机)。
 * 已在测试则幂等返回(不重复替换队列)。
 */
export async function startGroupDelayTest(groupId: string, baseUrl: string): Promise<StartDelayTestResult> {
  const base = { intervalMs: CLICK_INTERVAL_SEC * 1000, clickMs: CLICK_MS, durationSec: TONE_DURATION_SEC };
  if (activeTests.has(groupId)) return { running: true, ...base };

  const file = ensureToneFile();
  ensureToneRow(file);

  const qc = getQueueController();
  const snap = qc.snapshot(groupId);
  const prev: PrevQueueState = {
    items: snap.items,
    index: snap.currentIndex,
    playMode: snap.playMode,
    contentContext: qc.getContentContext(groupId),
    positionSec: 0,
    wasPlaying: false,
    wasPaused: false,
  };
  // 只要组里已装载队列,就记下当时的播放状态:起测前没在播的队列,停止时只还原
  // 队列数据、绝不顺手起播(否则用户「点测试→停测试」会莫名开始放歌)。
  if (snap.items.length > 0) {
    try {
      const st = await getGroupStatus(groupId);
      prev.positionSec = Math.max(0, Math.floor(st.position || 0));
      prev.wasPaused = st.state === "PAUSED";
      prev.wasPlaying = st.state === "PLAYING";
    } catch { /* 现场读不到就按「没在播」处理,只还原队列数据 */ }
  }

  const item: QueueItem = {
    songId: TONE_SONG_ID,
    title: "延迟测试音",
    mime: "audio/wav",
    duration: TONE_DURATION_SEC,
  };
  try {
    await qc.playFrom(groupId, [item], 0, baseUrl);
    qc.setPlayMode(groupId, "one");
  } catch (e) {
    // 起播失败:队列可能已被换成测试音,还原起测前的现场(恢复不成就保持现状)。
    removeToneRow();
    await restorePrevQueue(qc, groupId, baseUrl, prev);
    throw e;
  }
  activeTests.set(groupId, prev);
  log.info(`[delay-test] 开始 group=${groupId} interval=${CLICK_INTERVAL_SEC}s (起测前队列项=${prev.items.length})`);
  return { running: true, ...base };
}

/** 把起测前的队列现场放回:
 *  - 起测前在播/暂停 ⇒ 重新按原下标起播,并补回进度(暂停则再暂停);
 *  - 只是装载着没在播 ⇒ 只还原队列数据与游标,绝不顺手起播;
 *  - 起测前没有队列 ⇒ 清掉测试音留下的单曲队列(设备已由调用方停过)。 */
async function restorePrevQueue(
  qc: ReturnType<typeof getQueueController>,
  groupId: string,
  baseUrl: string,
  prev: PrevQueueState,
): Promise<boolean> {
  if (prev.items.length === 0) {
    qc.clear(groupId, { skipDeviceStop: true });
    return false;
  }
  const index = Math.max(0, Math.min(prev.items.length - 1, prev.index));
  if (prev.wasPlaying || prev.wasPaused) {
    // 先切 "one":playFrom 对 startIndex=0 的 shuffle 队列会随机挑首,直接按原下标恢复会被打乱。
    qc.setPlayMode(groupId, "one");
    await qc.playFrom(groupId, prev.items, index, baseUrl, prev.contentContext);
    qc.setPlayMode(groupId, prev.playMode);
    if (prev.wasPaused) await qc.transport(groupId, "pause");
    else if (prev.positionSec > 0) await qc.transport(groupId, "seek", prev.positionSec);
  } else {
    qc.setQueue(groupId, prev.items, index, baseUrl, prev.contentContext);
    qc.setPlayMode(groupId, prev.playMode);
    qc.stopPlayback(groupId); // setQueue 会置 isActive=true,这里还原成「停止」现场
  }
  return true;
}

/**
 * 停止该组测试:先停设备/冻结队列,再把起测前的队列现场(若存在)恢复回去。
 * 不在测试中则幂等返回。
 */
export async function stopGroupDelayTest(groupId: string, baseUrl: string): Promise<{ running: boolean; restored: boolean }> {
  const prev = activeTests.get(groupId);
  if (!prev) return { running: false, restored: false };
  activeTests.delete(groupId);

  const qc = getQueueController();
  qc.stopPlayback(groupId);
  try {
    await qc.transport(groupId, "stop");
  } catch (e: any) {
    log.warn(`[delay-test] group=${groupId} 停设备失败(继续恢复): ${e?.message || e}`);
  }

  let restored = false;
  try {
    restored = await restorePrevQueue(qc, groupId, baseUrl, prev);
  } catch (e: any) {
    log.warn(`[delay-test] group=${groupId} 恢复起测前队列失败(保持停止): ${e?.message || e}`);
  }
  if (activeTests.size === 0) removeToneRow();
  log.info(`[delay-test] 停止 group=${groupId} restored=${restored}`);
  return { running: false, restored };
}
