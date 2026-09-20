// 音频测量值（audio_analysis 表）的读写。
// 与同目录 loudness.ts 的分工：**那边是纯函数不碰 DB，这边才落库**。
//
// D8 纪律 —— 只有「自持源」的测量值才写库：
//   local / webdav 的行背后是同一个文件，今天测的值明天还成立；
//   web（网络源）每次取到的字节都不保证一致（可能换了 CDN 转码版本），
//   写下来下次播放时会被当成「这首已经测过」而误用，反而是错的。
//   所以网络源一律解析完就丢 —— 永远走实时 loudnorm（见 plan §4 / D8）。
// 「自持源」的口径与 services/source/preferredSource.ts 完全一致：
//   inArray(songs.type, ["local", "webdav"])。
import { sqlite } from "../../db/index.js";
import type { Statement } from "better-sqlite3";
import { parseLoudnorm } from "./loudness.js";

/** 允许回写的源类型。与播放优选同一把尺子，别在两处维护两套名单。 */
export const ANALYSIS_PERSIST_TYPES = ["local", "webdav"] as const;

/** 默认按 local 处理（项目惯例：`song.type || "local"`，见 preferredSource.ts:37）。 */
export function shouldPersistAnalysis(rowType: string | null | undefined): boolean {
  const t = (rowType ?? "local") || "local";
  return (ANALYSIS_PERSIST_TYPES as readonly string[]).includes(t);
}

/** 一条完整的测量值；序列类字段是纯 number 列表（入库时序列化成 JSON 文本）。 */
export interface AnalysisData {
  loudnessIntegrated: number | null;
  loudnessAlbum: number | null;
  loudnessRange: number | null;
  truePeak: number | null;
  bpm: number | null;
  beats: number[] | null;
  downbeats: number[] | null;
  beatsPerBar: number | null;
  key: string | null;
  mode: string | null;
  rmsEnergy: number[] | null;
  spectralCentroid: number[] | null;
  energy: number | null;
  /** 高层描述子(MA 全对齐,0.0-1.0;远期 L1/L2 用,现阶段只存不用)。 */
  danceability: number | null;
  valence: number | null;
  arousal: number | null;
  speechiness: number | null;
  instrumentalness: number | null;
  acousticness: number | null;
  brightness: number | null;
  harmonicComplexity: number | null;
  roughness: number | null;
  rhythmicRegularity: number | null;
  /** 提供方私有扩展(MA extra_data 同构,JSON 文本透存)。 */
  extraData: string | null;
}

export interface AnalysisRecord extends AnalysisData {
  rowId: string;
  measuredAt: string;
}

/** 合并语义照 MA `AudioAnalysisData.update()` —— 非 null 字段覆盖，其余保留。 */
type DbRow = {
  row_id: string;
  loudness_integrated: number | null;
  loudness_album: number | null;
  loudness_range: number | null;
  true_peak: number | null;
  bpm: number | null;
  beats: string | null;
  downbeats: string | null;
  beats_per_bar: number | null;
  key: string | null;
  mode: string | null;
  rms_energy: string | null;
  spectral_centroid: string | null;
  energy: number | null;
  danceability: number | null;
  valence: number | null;
  arousal: number | null;
  speechiness: number | null;
  instrumentalness: number | null;
  acousticness: number | null;
  brightness: number | null;
  harmonic_complexity: number | null;
  roughness: number | null;
  rhythmic_regularity: number | null;
  extra_data: string | null;
  measured_at: string | null;
};

const SEQ_FIELDS = ["beats", "downbeats", "rmsEnergy", "spectralCentroid"] as const;

function seqToDb(v: number[] | null): string | null {
  return Array.isArray(v) ? JSON.stringify(v) : null;
}

function seqFromDb(v: string | null): number[] | null {
  if (!v) return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}

function numFromDb(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function dbToRecord(row: DbRow): AnalysisRecord {
  return {
    rowId: row.row_id,
    loudnessIntegrated: numFromDb(row.loudness_integrated),
    loudnessAlbum: numFromDb(row.loudness_album),
    loudnessRange: numFromDb(row.loudness_range),
    truePeak: numFromDb(row.true_peak),
    bpm: numFromDb(row.bpm),
    beats: seqFromDb(row.beats),
    downbeats: seqFromDb(row.downbeats),
    beatsPerBar: numFromDb(row.beats_per_bar),
    key: row.key ?? null,
    mode: row.mode ?? null,
    rmsEnergy: seqFromDb(row.rms_energy),
    spectralCentroid: seqFromDb(row.spectral_centroid),
    energy: numFromDb(row.energy),
    danceability: numFromDb(row.danceability),
    valence: numFromDb(row.valence),
    arousal: numFromDb(row.arousal),
    speechiness: numFromDb(row.speechiness),
    instrumentalness: numFromDb(row.instrumentalness),
    acousticness: numFromDb(row.acousticness),
    brightness: numFromDb(row.brightness),
    harmonicComplexity: numFromDb(row.harmonic_complexity),
    roughness: numFromDb(row.roughness),
    rhythmicRegularity: numFromDb(row.rhythmic_regularity),
    extraData: typeof row.extra_data === "string" ? row.extra_data : null,
    measuredAt: row.measured_at ?? "",
  };
}

interface Statements {
  select: Statement;
  insert: Statement;
  del: Statement;
  /** 查 songs.type（判 D8 是否需要回写）。P0-4 边播边测每条消息都调，必须走缓存。 */
  songType: Statement;
}

// prepared stmt 惰性建：模块加载时表可能尚未建好（import 顺序不定），
// 且这样也避免在 import 期就锁定 schema。
let cached: Statements | null = null;
function stmts(): Statements {
  if (cached) return cached;
  cached = {
    select: sqlite.prepare("SELECT * FROM audio_analysis WHERE row_id = ?"),
    insert: sqlite.prepare(`
      INSERT INTO audio_analysis (
        row_id, loudness_integrated, loudness_album, loudness_range, true_peak,
        bpm, beats, downbeats, beats_per_bar, key, mode,
        rms_energy, spectral_centroid, energy,
        danceability, valence, arousal, speechiness, instrumentalness,
        acousticness, brightness, harmonic_complexity, roughness,
        rhythmic_regularity, extra_data, measured_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(row_id) DO UPDATE SET
        loudness_integrated = excluded.loudness_integrated,
        loudness_album = excluded.loudness_album,
        loudness_range = excluded.loudness_range,
        true_peak = excluded.true_peak,
        bpm = excluded.bpm,
        beats = excluded.beats,
        downbeats = excluded.downbeats,
        beats_per_bar = excluded.beats_per_bar,
        key = excluded.key,
        mode = excluded.mode,
        rms_energy = excluded.rms_energy,
        spectral_centroid = excluded.spectral_centroid,
        energy = excluded.energy,
        danceability = excluded.danceability,
        valence = excluded.valence,
        arousal = excluded.arousal,
        speechiness = excluded.speechiness,
        instrumentalness = excluded.instrumentalness,
        acousticness = excluded.acousticness,
        brightness = excluded.brightness,
        harmonic_complexity = excluded.harmonic_complexity,
        roughness = excluded.roughness,
        rhythmic_regularity = excluded.rhythmic_regularity,
        extra_data = excluded.extra_data,
        measured_at = excluded.measured_at
    `),
    del: sqlite.prepare("DELETE FROM audio_analysis WHERE row_id = ?"),
    songType: sqlite.prepare("SELECT type FROM songs WHERE id = ?"),
  };
  return cached;
}

/**
 * 写入（或部分更新）一行的测量值。
 *
 * 语义照 MA `AudioAnalysisData.update()`：**非 null 字段覆盖，null 表示「这次没测这项」，
 * 不把旧值清掉** —— 例如边播边测只填得响度，就不应该把之前量化好的 bpm/beats 抹了。
 *
 * @param rowType songs.type；不是自持源（web 等）时直接不写并返回 false。
 */
export function saveAnalysis(
  rowId: string,
  rowType: string | null | undefined,
  patch: Partial<AnalysisData>,
): boolean {
  if (!rowId) return false;
  // D8：网络源一律不回写，解析完就没了。
  if (!shouldPersistAnalysis(rowType)) return false;

  const prev = stmts().select.get(rowId) as DbRow | undefined;
  const base: AnalysisData = prev
    ? {
        loudnessIntegrated: numFromDb(prev.loudness_integrated),
        loudnessAlbum: numFromDb(prev.loudness_album),
        loudnessRange: numFromDb(prev.loudness_range),
        truePeak: numFromDb(prev.true_peak),
        bpm: numFromDb(prev.bpm),
        beats: seqFromDb(prev.beats),
        downbeats: seqFromDb(prev.downbeats),
        beatsPerBar: numFromDb(prev.beats_per_bar),
        key: prev.key ?? null,
        mode: prev.mode ?? null,
        rmsEnergy: seqFromDb(prev.rms_energy),
        spectralCentroid: seqFromDb(prev.spectral_centroid),
        energy: numFromDb(prev.energy),
        danceability: numFromDb(prev.danceability),
        valence: numFromDb(prev.valence),
        arousal: numFromDb(prev.arousal),
        speechiness: numFromDb(prev.speechiness),
        instrumentalness: numFromDb(prev.instrumentalness),
        acousticness: numFromDb(prev.acousticness),
        brightness: numFromDb(prev.brightness),
        harmonicComplexity: numFromDb(prev.harmonic_complexity),
        roughness: numFromDb(prev.roughness),
        rhythmicRegularity: numFromDb(prev.rhythmic_regularity),
        extraData: typeof prev.extra_data === "string" ? prev.extra_data : null,
      }
    : emptyAnalysis();

  const merged: AnalysisData = { ...base };
  for (const k of Object.keys(base) as (keyof AnalysisData)[]) {
    const v = patch[k];
    if (v === undefined || v === null) continue;
    (merged as any)[k] = v;
  }

  const s = stmts().insert;
  s.run(
    rowId,
    merged.loudnessIntegrated,
    merged.loudnessAlbum,
    merged.loudnessRange,
    merged.truePeak,
    merged.bpm,
    seqToDb(merged.beats),
    seqToDb(merged.downbeats),
    merged.beatsPerBar,
    merged.key,
    merged.mode,
    seqToDb(merged.rmsEnergy),
    seqToDb(merged.spectralCentroid),
    merged.energy,
    merged.danceability,
    merged.valence,
    merged.arousal,
    merged.speechiness,
    merged.instrumentalness,
    merged.acousticness,
    merged.brightness,
    merged.harmonicComplexity,
    merged.roughness,
    merged.rhythmicRegularity,
    typeof merged.extraData === "string" ? merged.extraData : null,
    new Date().toISOString(),
  );
  return true;
}

function emptyAnalysis(): AnalysisData {
  return {
    loudnessIntegrated: null,
    loudnessAlbum: null,
    loudnessRange: null,
    truePeak: null,
    bpm: null,
    beats: null,
    downbeats: null,
    beatsPerBar: null,
    key: null,
    mode: null,
    rmsEnergy: null,
    spectralCentroid: null,
    energy: null,
    danceability: null,
    valence: null,
    arousal: null,
    speechiness: null,
    instrumentalness: null,
    acousticness: null,
    brightness: null,
    harmonicComplexity: null,
    roughness: null,
    rhythmicRegularity: null,
    extraData: null,
  };
}

/** 读一条测量值；没有返回 null。 */
export function loadAnalysis(rowId: string): AnalysisRecord | null {
  if (!rowId) return null;
  const row = stmts().select.get(rowId) as DbRow | undefined;
  return row ? dbToRecord(row) : null;
}

/** 删一行的测量值（如 songs 行被删除）。不存在也算成功。 */
export function deleteAnalysis(rowId: string): void {
  if (!rowId) return;
  stmts().del.run(rowId);
}

/**
 * 批量删：给「扫描差集清理」与「同一事务删 songs 行」用。
 * 调用方负责保证在**源探测成功**之后才调用（避免一次源抖动抹掉整库测量值，见 P0-6）。
 */
export function deleteAnalysisMany(rowIds: readonly string[]): number {
  const stmt = stmts().del;
  const tx = sqlite.transaction((ids: readonly string[]) => {
    let n = 0;
    for (const id of ids) {
      if (!id) continue;
      n += stmt.run(id).changes;
    }
    return n;
  });
  return tx(rowIds);
}

/**
 * 播完上报入口(P0-4):播放结束时把该路 loudnorm 的 stderr 交给它,
 * 解析 input_i/input_tp → 按行类型门控 → 入库(合并语义,不清掉 bpm 等旧字段)。
 *
 *  - 行不存在/读库异常 → false;网络源行 → 解析完即弃,false(DB 无记录);
 *  - 解析失败/-inf(数字静音) → false,不入库;
 *  - 只返回是否入库,不抛错 —— 调用方(各通道"流结束"处)无需为它加 try。
 *
 * 注意:P1 管道就绪前,没有任何通道会调它(链上还没有 loudnorm)。
 * P1 起各通道在流结束处传自家 loudnorm stderr 即可,签名稳定。
 */
export function reportPlaybackLoudness(
  rowId: string,
  stderr: string | Uint8Array | Buffer,
): boolean {
  try {
    if (!rowId) return false;
    const row = stmts().songType.get(rowId) as { type?: string | null } | undefined;
    // 行没了(如播完即被删):无处可挂,不写。
    if (!row) return false;
    // D8:网络源一律不回写。
    if (!shouldPersistAnalysis(row.type)) return false;
    const m = parseLoudnorm(stderr);
    if (!m) return false;
    return saveAnalysis(rowId, row.type, {
      loudnessIntegrated: m.inputI,
      truePeak: m.inputTp,
    });
  } catch {
    return false;
  }
}
