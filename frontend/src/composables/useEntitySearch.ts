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
import { gt } from "@/locales";
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
    // 格式契约:插件可在搜索结果的 item 上携带 suffix(它最清楚自己后端输出的格式,
    // 如 mp3/flac/wav)——带则优先采用,本机播放不探测;不带则占位 mp3(仅 DLNA 队列
    // mime 推导用),本机播放会 Range 探测上游 Content-Type 确认真实格式(兼容所有格式)。
    suffix: item.suffix || "mp3",
    // 远程歌(未入库):streamUrl 指向 /rest/stream-remote 代理流。
    streamUrl: `/rest/stream-remote?${qs.toString()}`,
  };
  (song as any)._suffixKnown = !!item.suffix; // 插件是否明确给了格式(探测只发生在未给时)
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
      ElMessage.error(res.data?.error || gt("entitySearch.fetchFailed"));
      return [];
    }
    return (res.data.items || []).map((it: any) => remoteItemToSong(it, providerId));
  } catch (e: any) {
    ElMessage.error(e?.message || gt("entitySearch.fetchFailedPlugin"));
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

  // "aggregate" | "local" | providerId —— 默认「聚合」(同时搜本地库 + 全部已启用插件全网结果)
  const searchMode = ref("aggregate");
  const searchProviders = ref<EntitySearchProvider[]>([]);
  const remoteItems = ref<any[]>([]);       // 单插件远程搜索结果
  const remoteSearching = ref(false);
  const aggregateItems = ref<any[]>([]);    // 聚合搜索结果(本地由页面列表承载,此处仅全网合并)
  const aggregateSearching = ref(false);
  const importingId = ref("");

  const isAggregateMode = computed(() => searchMode.value === "aggregate");
  // 插件模式:仅单插件(排除聚合)。本地内容在 local 与 aggregate 下都展示 → isLocalMode 对两者为真。
  const isRemoteMode = computed(() => searchMode.value !== "local" && searchMode.value !== "aggregate");
  const isLocalMode = computed(() => !isRemoteMode.value);
  const currentProvider = computed(() => searchProviders.value.find((p) => p.id === searchMode.value));
  const currentProviderName = computed(() => currentProvider.value?.name || gt("playlists.providerFallback"));
  // 下拉按钮文案:聚合=「聚合」,插件=插件名,本地=「本地」
  const currentSourceLabel = computed(() => {
    if (isAggregateMode.value) return gt("music.aggregate");
    return isRemoteMode.value ? currentProvider.value?.name || gt("music.local") : gt("music.local");
  });

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

  /** 下拉命令:聚合=aggregate,本地=local,其余=插件 id。切回本地刷新列表;切来源清空各结果。 */
  function onSearchSourceCommand(cmd: string) {
    if (searchMode.value === cmd) return;
    searchMode.value = cmd;
    remoteItems.value = [];
    aggregateItems.value = [];
    importingId.value = "";
    if (searchMode.value === "local") localLoader();
  }

  /** 远程搜索(输入 debounce 后由页面调用,单插件模式)。本地/聚合或无词时清空。 */
  async function doRemoteSearch(q: string) {
    const query = String(q || "").trim();
    if (!query || !isRemoteMode.value) {
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
        ElMessage.error(res.data?.error || gt("playlists.searchFailed"));
      }
    } catch {
      remoteItems.value = [];
      ElMessage.error(gt("playlists.searchFailedPlugin"));
    } finally {
      remoteSearching.value = false;
    }
  }

  /** 聚合搜索(输入 debounce 后由页面调用,「聚合」默认模式):并发查全部已启用插件全网结果。
   *  每条结果挂 providerId/providerName,页面据此归位到对应插件的详情/导入/播放。 */
  async function doAggregateSearch(q: string) {
    const query = String(q || "").trim();
    if (!query || !isAggregateMode.value) {
      aggregateItems.value = [];
      return;
    }
    aggregateSearching.value = true;
    try {
      const res = await api.post(`${base}/aggregate/search`, { q: query });
      if (res.data?.success) {
        aggregateItems.value = res.data.items || [];
      } else {
        aggregateItems.value = [];
        ElMessage.error(res.data?.error || gt("playlists.searchFailed"));
      }
    } catch {
      aggregateItems.value = [];
      ElMessage.error(gt("playlists.aggSearchFailedPlugin"));
    } finally {
      aggregateSearching.value = false;
    }
  }

  /** 歌曲导入(音乐页):把搜索结果歌曲直接入库为可播在线歌曲。providerId 用于聚合行逐条归位(默认当前来源)。 */
  async function importSongs(songs: any[], providerId?: string) {
    if (!Array.isArray(songs) || !songs.length) return;
    if (importingId.value) return;
    importingId.value = "all";
    try {
      const res = await api.post(`${base}/${providerId || searchMode.value}/import`, { songs });
      if (res.data?.alreadyRunning) {
        ElMessage.warning(gt("entitySearch.importRunning"));
        return;
      }
      if (!res.data?.success || !res.data.taskId) {
        ElMessage.error(res.data?.error || gt("playlists.importFailed"));
        return;
      }
      const r = await waitAsyncTask(res.data.taskId, { intervalMs: 800 });
      if (r?.success) {
        ElMessage.success(`${gt("entitySearch.importedSongs", { count: r.added })}${r.deduped ? gt("entitySearch.dedupedSuffix", { deduped: r.deduped }) : ""}`);
        afterRemoteImport();
      } else {
        ElMessage.error(r?.error || gt("playlists.importFailed"));
      }
    } catch (e: any) {
      ElMessage.error(e?.message || gt("playlists.importFailedPlugin"));
    } finally {
      importingId.value = "";
    }
  }

  /** 专辑导入(专辑页):拉整专 → 以「专辑歌单」形式入库(幂等)。providerId 用于聚合行逐条归位(默认当前来源)。 */
  async function importAlbum(item: any, providerId?: string) {
    const key = `${item.source}:${item.id}`;
    if (!item?.source || !item?.id) return;
    if (importingId.value === key) return;
    importingId.value = key;
    try {
      const res = await api.post(`${base}/${providerId || searchMode.value}/import`, {
        source: item.source,
        id: item.id,
        name: item.name,
        cover: item.cover,
      });
      if (res.data?.alreadyRunning) {
        ElMessage.warning(gt("entitySearch.importingAlbum"));
        return;
      }
      if (!res.data?.success || !res.data.taskId) {
        ElMessage.error(res.data?.error || gt("playlists.importFailed"));
        return;
      }
      const r = await waitAsyncTask(res.data.taskId, { intervalMs: 800 });
      if (r?.success) {
        item._imported = true;
        ElMessage.success(gt("entitySearch.importedAlbum", { name: r.name, count: r.trackCount, added: r.added }));
        afterRemoteImport();
      } else {
        ElMessage.error(r?.error || gt("playlists.importFailed"));
      }
    } catch (e: any) {
      ElMessage.error(e?.message || gt("playlists.importFailedPlugin"));
    } finally {
      importingId.value = "";
    }
  }

  return {
    searchMode,
    searchProviders,
    remoteItems,
    remoteSearching,
    aggregateItems,
    aggregateSearching,
    importingId,
    isLocalMode,
    isRemoteMode,
    isAggregateMode,
    currentProviderName,
    currentSourceLabel,
    loadSearchProviders,
    onSearchSourceCommand,
    doRemoteSearch,
    doAggregateSearch,
    importSongs,
    importAlbum,
    setLocalLoader,
    setAfterRemoteImport,
  };
}
