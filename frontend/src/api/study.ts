// 学习模块(P1 Web)前端接口封装。全部走 /rest/api/v1/study/*,与音乐面隔离。
import api from "@/api";
import type { Song } from "@/stores/player";

export interface StudySource {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  songCount: number;
}

export interface StudyDirEntry {
  name: string;
  relPath: string;
  isDir: boolean;
  size?: number;
  mtimeMs?: number;
  /** 已入库文件的歌曲 id(未点播过的文件没有) */
  songId?: string;
  durationSec?: number;
  positionSec?: number;
  finished?: boolean;
  /** 0~1 */
  progress?: number;
}

export interface StudySong extends Song {
  kind?: string;
  sourceId?: string;
  relDir?: string;
  /** 源文件名(含扩展名),学习歌单列表按此展示;缺失时回退 title。 */
  fileName?: string;
  /** 播放来源歌单:存在时播放会额外上报「整单续播」位置。 */
  playlistId?: string;
  playlistName?: string;
  positionSec?: number;
  durationSec?: number;
  progress?: number;
  updatedAt?: string;
  entryId?: string;
}

export interface StudyPlaylist {
  id: string;
  name: string;
  owner: string;
  public: boolean;
  songCount: number;
  duration: number;
  coverArt?: string;
  comment?: string;
  /** 所属文件夹名;空串=根目录。 */
  folder?: string;
  created?: string;
  changed?: string;
}

/** 学习歌单列表结果:items + 当前用户可见的文件夹名。 */
export interface StudyPlaylistList {
  items: StudyPlaylist[];
  folders: string[];
}

/** 学习歌单导出文件(与音乐歌单导出同构:app + version + tracks)。 */
export interface StudyPlaylistExportTrack {
  songId?: string;
  title?: string;
  artist?: string;
  album?: string;
  relDir?: string;
  relPath?: string;
  sourceId?: string;
  sourceName?: string;
  duration?: number;
}

export interface StudyPlaylistExportFile {
  app?: string;
  version?: number;
  exportedAt?: string;
  exportAll?: boolean;
  name?: string;
  comment?: string;
  tracks?: StudyPlaylistExportTrack[];
  playlists?: Array<{ name: string; comment?: string; tracks?: StudyPlaylistExportTrack[] }>;
}

export interface StudyPlaylistImportResult {
  success: boolean;
  created: number;
  merged: number;
  trackCount: number;
  matched: number;
  unmatched: number;
  playlists: Array<{ id: string; name: string; added: number; unmatched: number }>;
}

export async function fetchStudySources(): Promise<StudySource[]> {
  const res = await api.get("/rest/api/v1/study/sources");
  return res.data.items || [];
}

export async function fetchStudyDir(sourceId: string, path: string): Promise<StudyDirEntry[]> {
  const res = await api.get("/rest/api/v1/study/dir", { params: { sourceId, path } });
  return res.data.items || [];
}

export async function resolveStudyFile(sourceId: string, path: string): Promise<StudySong> {
  const res = await api.post("/rest/api/v1/study/resolve", { sourceId, path });
  return res.data.song;
}

/** 批量点播入库(播放全部):返回按入参顺序排列的结果,失败项带 error。 */
export async function resolveStudyFiles(
  sourceId: string,
  paths: string[],
): Promise<Array<{ path: string; song?: StudySong; error?: string }>> {
  const res = await api.post("/rest/api/v1/study/resolve-batch", { sourceId, paths });
  return res.data.items || [];
}

/** 继续学习:单条音频记录 + 学习歌单续播记录(可整单从上次位置续播)。 */
export interface ContinueLearningResult {
  items: StudySong[];
  playlistItems: StudySong[];
}

export async function fetchContinueLearning(limit = 20): Promise<ContinueLearningResult> {
  const res = await api.get("/rest/api/v1/study/continue", { params: { limit } });
  return { items: res.data.items || [], playlistItems: res.data.playlistItems || [] };
}

/** 上报学习歌单播放位置(整单续播用;曲目必须属于该歌单)。 */
export async function reportStudyPlaylistProgress(
  playlistId: string,
  songId: string,
  positionSec: number,
  durationSec: number,
): Promise<void> {
  await api.put(`/rest/api/v1/study/playlists/${encodeURIComponent(playlistId)}/progress`, {
    songId, positionSec, durationSec,
  });
}

/** 删除一条学习记录(仅影响继续学习/进度,不删除音频文件)。 */
export async function deleteStudyProgress(songId: string): Promise<void> {
  await api.delete(`/rest/api/v1/study/progress/${encodeURIComponent(songId)}`);
}

/** 清空当前用户全部学习记录(仅影响继续学习/进度,不删除音频文件)。 */
export async function clearStudyProgress(): Promise<void> {
  await api.delete("/rest/api/v1/study/progress");
}

export async function fetchRecentStudy(limit = 50, sourceId = ""): Promise<StudySong[]> {
  const res = await api.get("/rest/api/v1/study/recent", { params: { limit, sourceId: sourceId || undefined } });
  return res.data.items || [];
}

export async function searchStudy(q: string, limit = 100): Promise<StudySong[]> {
  const res = await api.get("/rest/api/v1/study/search", { params: { q, limit } });
  return res.data.items || [];
}

export async function fetchStudyPlaylists(q = ""): Promise<StudyPlaylistList> {
  const res = await api.get("/rest/api/v1/study/playlists", { params: q ? { q } : undefined });
  return { items: res.data.items || [], folders: res.data.folders || [] };
}

export async function createStudyPlaylist(name: string, folder = ""): Promise<string> {
  const res = await api.post("/rest/api/v1/study/playlists", { name, folder });
  return res.data.id;
}

export async function deleteStudyPlaylist(id: string): Promise<void> {
  await api.delete(`/rest/api/v1/study/playlists/${encodeURIComponent(id)}`);
}

export async function updateStudyPlaylist(
  id: string,
  patch: { name?: string; comment?: string; public?: boolean; folder?: string },
): Promise<void> {
  await api.put(`/rest/api/v1/study/playlists/${encodeURIComponent(id)}`, patch);
}

// ==================== 学习歌单文件夹 ====================

export async function fetchStudyPlaylistFolders(): Promise<string[]> {
  const res = await api.get("/rest/api/v1/study/playlist-folders");
  return res.data.items || [];
}

export async function createStudyPlaylistFolder(name: string, parent = ""): Promise<void> {
  await api.post("/rest/api/v1/study/playlist-folders", { name, parent });
}

export async function renameStudyPlaylistFolder(path: string, next: string): Promise<void> {
  await api.post("/rest/api/v1/study/playlist-folders/rename", { path, name: next });
}

export async function deleteStudyPlaylistFolder(path: string): Promise<void> {
  await api.post("/rest/api/v1/study/playlist-folders/delete", { path });
}

/** 清掉某学习源的目录缓存(源配置/远端内容变化后强制重新列目录)。 */
export async function refreshStudySource(sourceId: string): Promise<void> {
  await api.post("/rest/api/v1/study/refresh", null, { params: { sourceId } });
}

export async function fetchStudyPlaylistTracks(
  id: string,
): Promise<{ name: string; items: StudySong[] }> {
  const res = await api.get(`/rest/api/v1/study/playlists/${encodeURIComponent(id)}/tracks`);
  return { name: res.data.name || "", items: res.data.items || [] };
}

export async function addStudyPlaylistTracks(id: string, add: string[]): Promise<void> {
  await api.post(`/rest/api/v1/study/playlists/${encodeURIComponent(id)}/tracks`, { add });
}

export async function removeStudyPlaylistTracks(id: string, remove: string[]): Promise<void> {
  await api.post(`/rest/api/v1/study/playlists/${encodeURIComponent(id)}/tracks`, { remove });
}

/** 导入学习歌单文件:同名歌单合并,其余新建;folder 非空时导入到该文件夹。 */
export async function importStudyPlaylists(
  native: StudyPlaylistExportFile,
  folder = "",
): Promise<StudyPlaylistImportResult> {
  const res = await api.post("/rest/api/v1/study/playlists/import", { native, folder });
  return res.data;
}
