// ==================== useEntitySearch: 实体搜索共享逻辑 ====================
//
// 音乐 / 艺术家 / 专辑三个页面共用的「搜索来源下拉 + 远程搜索」逻辑,与歌单页
// (Playlists/index.vue)同一套交互:前面一个「搜索」文字 + 按钮(默认「本地」),
// 点击下拉列出「本地 + 已启用且声明对应能力的插件」——插件没声明该能力,providers
// 列表里就不会出现它(下拉不显示),核心只按能力查询,不写死插件 id。
//
// kind: "song" | "artist" | "album" → /rest/api/v1/{kind}-search/*
//   song   → songSearch   能力(searchSongs,结果可「加入库」为可播在线歌曲)
//   artist → artistSearch 能力(searchArtists,结果仅展示)
//   album  → albumSearch  能力(searchAlbums,结果可「加入库」为专辑歌单)
//
// 页面职责:输入框 debounce 后分发(远程模式调 doRemoteSearch,本地模式刷新本地列表)、
// 渲染各自的结果区;本地刷新函数经 setLocalLoader 注入。

import { ref, computed } from "vue";
import { ElMessage } from "element-plus";
import api from "@/api";
import { waitAsyncTask } from "@/utils/asyncTask";
import { usePlayerStore, Song } from "@/stores/player";

export type EntitySearchKind = "song" | "artist" | "album";

export interface EntitySearchProvider {
  id: string;
  name: string;
  platforms: string[];
  platformLabels: Record<string, string>;
}

/** 远程搜索结果(歌曲) → 可播放 Song:streamUrl 指向 /rest/stream-remote,未入库也能播。
 *  原始 item 挂到 song._item 供「加入库」等需要原始字段的操作回取。 */
export function remoteItemToSong(item: any, providerId: string): Song {
  const qs = new URLSearchParams({ provider: providerId, source: item.source || "", id: item.id || "" });
  if (item.name) qs.set("title", item.name);
  if (item.artist) qs.set("artist", item.artist);
  if (item.album) qs.set("album", item.album);
  if (item.duration) qs.set("duration", String(item.duration));
  if (item.cover) qs.set("cover", item.cover);
  const song: Song = {
    id: `remote:${providerId}:${item.source || ""}:${item.id || ""}`,
    title: item.name || "",
    artist: item.artist || "",
    album: item.album || "",
    duration: item.duration || 0,
    coverArt: item.cover || undefined,
    streamUrl: `/rest/stream-remote?${qs.toString()}`,
  };
  (song as any)._item = item;
  return song;
}

/** 拉取远程集合(专辑/歌单/艺术家)的歌曲列表(只拉不导入),映射为可播放 Song。
 *  kind: "album"|"playlist"|"artist";item 需含 source/id(艺术家还可用 name)。
 *  返回空数组表示无歌曲或失败(已 toast)。 */
export async function fetchRemoteCollectionSongs(
  kind: "album" | "playlist" | "artist",
  providerId: string,
  item: any,
): Promise<Song[]> {
  if (!providerId || !item?.source) return [];
  const base = kind === "playlist" ? "/rest/api/v1/playlist-search" : `/rest/api/v1/${kind}-search`;
  const qs = new URLSearchParams({ source: item.source });
  if (item.id) qs.set("id", item.id);
  if (item.name) qs.set("name", item.name);
  try {
    const res = await api.get(`${base}/${providerId}/items?${qs.toString()}`);
    if (!res.data?.success) {
      ElMessage.error(res.data?.error || "拉取失败");
      return [];
    }
    return (res.data.items || []).map((it: any) => remoteItemToSong(it, providerId));
  } catch (e: any) {
    ElMessage.error(e?.message || "拉取失败:插件未启用或服务不可达");
    return [];
  }
}

/** 远程集合「播放」:拉歌曲列表 → 直接进播放队列(未入库,靠 streamUrl 播放)。 */
export async function playRemoteCollection(
  kind: "album" | "playlist" | "artist",
  providerId: string,
  item: any,
): Promise<number> {
  const songs = await fetchRemoteCollectionSongs(kind, providerId, item);
  if (songs.length) usePlayerStore().playQueue(songs, 0);
  return songs.length;
}

export function useEntitySearch(kind: EntitySearchKind) {
  const base = `/rest/api/v1/${kind}-search`;

  const searchMode = ref("local"); // "local" | providerId
  const searchProviders = ref<EntitySearchProvider[]>([]);
  const remoteItems = ref<any[]>([]);
  const remoteSearching = ref(false);
  const importingId = ref("");

  const isRemoteMode = computed(() => searchMode.value !== "local");
  const isLocalMode = computed(() => !isRemoteMode.value);
  const currentProvider = computed(() => searchProviders.value.find((p) => p.id === searchMode.value));
  const currentProviderName = computed(() => currentProvider.value?.name || "平台");
  // 下拉按钮文案:本地模式显示「本地」,插件模式显示插件名
  const currentSourceLabel = computed(() => (isRemoteMode.value ? currentProvider.value?.name || "本地" : "本地"));

  // 页面注入:切回本地模式 / 本地搜索时刷新本地列表
  let localLoader: () => void = () => {};
  function setLocalLoader(fn: () => void) {
    localLoader = fn;
  }

  // 页面注入:远程导入成功后的回调(如刷新本地列表)
  let afterRemoteImport: () => void = () => {};
  function setAfterRemoteImport(fn: () => void) {
    afterRemoteImport = fn;
  }

  /** 已启用且声明对应能力的插件列表(前端下拉数据源,动态)。 */
  async function loadSearchProviders() {
    try {
      const res = await api.get(`${base}/providers`);
      searchProviders.value = res.data.providers || [];
    } catch {
      searchProviders.value = [];
    }
  }

  /** 下拉命令:本地=local,其余=对应插件 id。切回本地刷新列表;切插件清空远程结果。 */
  function onSearchSourceCommand(cmd: string) {
    if (searchMode.value === cmd) return;
    searchMode.value = cmd;
    remoteItems.value = [];
    importingId.value = "";
    if (searchMode.value === "local") localLoader();
  }

  /** 远程搜索(输入 debounce 后由页面调用)。本地模式或无词时清空。 */
  async function doRemoteSearch(q: string) {
    const query = String(q || "").trim();
    if (!query || searchMode.value === "local") {
      remoteItems.value = [];
      return;
    }
    remoteSearching.value = true;
    try {
      const res = await api.post(`${base}/${searchMode.value}/search`, { q: query });
      if (res.data?.success) {
        remoteItems.value = res.data.items || [];
      } else {
        remoteItems.value = [];
        ElMessage.error(res.data?.error || "搜索失败");
      }
    } catch {
      remoteItems.value = [];
      ElMessage.error("搜索失败:插件未启用或服务不可达");
    } finally {
      remoteSearching.value = false;
    }
  }

  /** 歌曲导入(音乐页):把搜索结果歌曲直接入库为可播在线歌曲。 */
  async function importSongs(songs: any[]) {
    if (!Array.isArray(songs) || !songs.length) return;
    if (importingId.value) return;
    importingId.value = "all";
    try {
      const res = await api.post(`${base}/${searchMode.value}/import`, { songs });
      if (res.data?.alreadyRunning) {
        ElMessage.warning("正在导入中,请稍候");
        return;
      }
      if (!res.data?.success || !res.data.taskId) {
        ElMessage.error(res.data?.error || "导入失败");
        return;
      }
      const r = await waitAsyncTask(res.data.taskId, { intervalMs: 800 });
      if (r?.success) {
        ElMessage.success(`已加入库:${r.added} 首${r.deduped ? `,去重 ${r.deduped}` : ""}`);
        afterRemoteImport();
      } else {
        ElMessage.error(r?.error || "导入失败");
      }
    } catch (e: any) {
      ElMessage.error(e?.message || "导入失败:插件未启用或服务不可达");
    } finally {
      importingId.value = "";
    }
  }

  /** 专辑导入(专辑页):拉整专 → 以「专辑歌单」形式入库(幂等)。 */
  async function importAlbum(item: any) {
    const key = `${item.source}:${item.id}`;
    if (!item?.source || !item?.id) return;
    if (importingId.value === key) return;
    importingId.value = key;
    try {
      const res = await api.post(`${base}/${searchMode.value}/import`, {
        source: item.source,
        id: item.id,
        name: item.name,
        cover: item.cover,
      });
      if (res.data?.alreadyRunning) {
        ElMessage.warning("该专辑正在导入中,请稍候");
        return;
      }
      if (!res.data?.success || !res.data.taskId) {
        ElMessage.error(res.data?.error || "导入失败");
        return;
      }
      const r = await waitAsyncTask(res.data.taskId, { intervalMs: 800 });
      if (r?.success) {
        item._imported = true;
        ElMessage.success(`已加入库:${r.name}(${r.trackCount}首,匹配 ${r.added})`);
        afterRemoteImport();
      } else {
        ElMessage.error(r?.error || "导入失败");
      }
    } catch (e: any) {
      ElMessage.error(e?.message || "导入失败:插件未启用或服务不可达");
    } finally {
      importingId.value = "";
    }
  }

  return {
    searchMode,
    searchProviders,
    remoteItems,
    remoteSearching,
    importingId,
    isLocalMode,
    isRemoteMode,
    currentProviderName,
    currentSourceLabel,
    loadSearchProviders,
    onSearchSourceCommand,
    doRemoteSearch,
    importSongs,
    importAlbum,
    setLocalLoader,
    setAfterRemoteImport,
  };
}
