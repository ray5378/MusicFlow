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

  async function loadFavorites() {
    if (loaded.value) return;
    loading.value = true;
    try {
      const res = await api.get("/rest/getStarred2?f=json");
      const starred = res.data["subsonic-response"]?.starred2 || { song: [], album: [], artist: [] };
      favoriteSongIds.value = new Set((starred.song || []).map((s: any) => s.id));
      favoriteAlbumIds.value = new Set((starred.album || []).map((a: any) => a.id));
      favoriteArtistIds.value = new Set((starred.artist || []).map((a: any) => a.id));
      loaded.value = true;
    } catch { /* ignore */ }
    finally { loading.value = false; }
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

  return {
    favoriteSongIds, favoriteAlbumIds, favoriteArtistIds, revision, loaded, loading,
    loadFavorites, isFavorite, isAlbumFavorite, isArtistFavorite,
    toggleFavorite, toggleAlbumFavorite, toggleArtistFavorite,
    removeFavorite, removeAlbumFavorite, removeArtistFavorite, clearFavorites,
  };
});
