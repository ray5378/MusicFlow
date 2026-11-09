import { defineStore } from "pinia";
import { ref } from "vue";
import api from "@/api";
import { gt } from "@/locales";

type FavoriteKind = "song" | "album" | "artist";

export const useFavoritesStore = defineStore("favorites", () => {
  // 三类收藏相互独立:歌曲(id)、专辑(albumId)、艺人(artistId),互不连坐。
  const favoriteSongIds = ref<Set<string>>(new Set());
  const favoriteAlbumIds = ref<Set<string>>(new Set());
  const favoriteArtistIds = ref<Set<string>>(new Set());
  const loaded = ref(false);
  const loading = ref(false);
  // 收藏变更信号量:任何一次成功/回滚的收藏增删都自增。
  // Favorites 页监听它重载列表,实现「点击我喜欢后实时更新,无需强制刷新」。
  const revision = ref(0);

  // 在途单飞去重:并发调用共享同一个 promise。
  // 背景:MainLayout 同一处既直接调 loadFavorites()、又通过 preloadHome() 再调一次,
  // 旧实现只有 `if (loaded) return` 没有在途去重,导致同一个收藏请求被并发请求两次
  // 并互相排队(实测第二次排队 q≈689ms)。finally 里清空以允许后续重新加载。
  let inflight: Promise<void> | null = null;

  async function loadFavorites() {
    if (loaded.value) return;
    if (inflight) return inflight;
    const p = (async () => {
      loading.value = true;
      try {
        // 只取 id 集合的轻量端点(2026-11-09):收藏状态只需要 id,而标准 getStarred2
        // 会回完整歌曲/专辑/艺人对象(800+ 收藏实测 ~187KB、~280ms)。标准接口保持不变,
        // 第三方 Subsonic 客户端与收藏页仍走 getStarred2。
        const res = await api.get("/rest/api/v1/favorites/ids");
        const ids = res.data["subsonic-response"]?.favoriteIds || {};
        favoriteSongIds.value = new Set(ids.song || []);
        favoriteAlbumIds.value = new Set(ids.album || []);
        favoriteArtistIds.value = new Set(ids.artist || []);
        loaded.value = true;
      } catch { /* ignore */ }
      finally { loading.value = false; inflight = null; }
    })();
    inflight = p;
    return p;
  }

  function isFavorite(songId: string): boolean {
    return favoriteSongIds.value.has(songId);
  }
  function isAlbumFavorite(albumId: string): boolean {
    return favoriteAlbumIds.value.has(albumId);
  }
  function isArtistFavorite(artistId: string): boolean {
    return favoriteArtistIds.value.has(artistId);
  }

  function setOf(kind: FavoriteKind): Set<string> {
    return kind === "song" ? favoriteSongIds.value : kind === "album" ? favoriteAlbumIds.value : favoriteArtistIds.value;
  }
  function paramOf(kind: FavoriteKind): string {
    return kind === "song" ? "id" : kind === "album" ? "albumId" : "artistId";
  }

  // Optimistic toggle: update UI immediately, sync with server
  async function toggleFavoriteOf(kind: FavoriteKind, itemId: string): Promise<boolean> {
    const set = setOf(kind);
    const willFav = !set.has(itemId);
    if (willFav) set.add(itemId);
    else set.delete(itemId);
    try {
      await api.get(`/rest/${willFav ? "star" : "unstar"}?${paramOf(kind)}=${itemId}`);
    } catch {
      // rollback on failure
      if (willFav) set.delete(itemId);
      else set.add(itemId);
      throw new Error(gt("common.operationFailed"));
    }
    // 服务端已确认,Set 反映最新状态;标记未加载,下次 loadFavorites 重新与后端同步。
    loaded.value = false;
    revision.value++;
    return willFav;
  }

  function toggleFavorite(songId: string): Promise<boolean> {
    return toggleFavoriteOf("song", songId);
  }
  function toggleAlbumFavorite(albumId: string): Promise<boolean> {
    return toggleFavoriteOf("album", albumId);
  }
  function toggleArtistFavorite(artistId: string): Promise<boolean> {
    return toggleFavoriteOf("artist", artistId);
  }

  async function removeFavoriteOf(kind: FavoriteKind, itemId: string) {
    const set = setOf(kind);
    set.delete(itemId);
    try { await api.get(`/rest/unstar?${paramOf(kind)}=${itemId}`); } catch { set.add(itemId); throw new Error(gt("common.operationFailed")); }
    loaded.value = false;
    revision.value++;
  }

  function removeFavorite(songId: string) {
    return removeFavoriteOf("song", songId);
  }
  function removeAlbumFavorite(albumId: string) {
    return removeFavoriteOf("album", albumId);
  }
  function removeArtistFavorite(artistId: string) {
    return removeFavoriteOf("artist", artistId);
  }

  // Clear all cached favorites (called on logout to free memory)
  function clearFavorites() {
    favoriteSongIds.value = new Set();
    favoriteAlbumIds.value = new Set();
    favoriteArtistIds.value = new Set();
    loaded.value = false;
    revision.value++;
  }

  /**
   * 应用「其它端」的收藏变更(服务端 song_starred 定向推送)。
   *
   * 纯本地同步:不写服务端、不调接口 —— 服务端已经是变更来源,回写会打回环。
   * 幂等且**只在真的变了才 bump revision**,否则本端自己点红心时服务端把同一
   * 状态又推回来,会导致 Favorites 页多余的整页重载。
   */
  function applyExternalStarred(
    songIds: string[],
    starred: boolean,
    albumIds: string[] = [],
    artistIds: string[] = [],
  ): void {
    let changed = false;
    const apply = (set: Set<string>, ids: string[]) => {
      for (const id of ids) {
        if (!id) continue;
        if (starred && !set.has(id)) { set.add(id); changed = true; }
        else if (!starred && set.has(id)) { set.delete(id); changed = true; }
      }
    };
    apply(favoriteSongIds.value, songIds);
    apply(favoriteAlbumIds.value, albumIds);
    apply(favoriteArtistIds.value, artistIds);
    if (changed) revision.value++;
  }

  return {
    favoriteSongIds, favoriteAlbumIds, favoriteArtistIds, revision, loaded, loading,
    loadFavorites, isFavorite, isAlbumFavorite, isArtistFavorite,
    toggleFavorite, toggleAlbumFavorite, toggleArtistFavorite,
    removeFavorite, removeAlbumFavorite, removeArtistFavorite, clearFavorites,
    applyExternalStarred,
  };
});
