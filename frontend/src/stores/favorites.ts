import { defineStore } from "pinia";
import { ref } from "vue";
import api from "@/api";

export const useFavoritesStore = defineStore("favorites", () => {
  const favoriteSongIds = ref<Set<string>>(new Set());
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
      const starred = res.data["subsonic-response"]?.starred2 || { song: [] };
      favoriteSongIds.value = new Set((starred.song || []).map((s: any) => s.id));
      loaded.value = true;
    } catch { /* ignore */ }
    finally { loading.value = false; }
  }

  function isFavorite(songId: string): boolean {
    return favoriteSongIds.value.has(songId);
  }

  // Optimistic toggle: update UI immediately, sync with server
  async function toggleFavorite(songId: string): Promise<boolean> {
    const willFav = !favoriteSongIds.value.has(songId);
    if (willFav) favoriteSongIds.value.add(songId);
    else favoriteSongIds.value.delete(songId);
    try {
      await api.get(`/rest/${willFav ? "star" : "unstar"}?id=${songId}`);
    } catch {
      // rollback on failure
      if (willFav) favoriteSongIds.value.delete(songId);
      else favoriteSongIds.value.add(songId);
      throw new Error("操作失败");
    }
    // 服务端已确认,Set 反映最新状态;标记未加载,下次 loadFavorites 重新与后端同步。
    loaded.value = false;
    revision.value++;
    return willFav;
  }

  async function removeFavorite(songId: string) {
    favoriteSongIds.value.delete(songId);
    try { await api.get(`/rest/unstar?id=${songId}`); } catch { favoriteSongIds.value.add(songId); throw new Error("操作失败"); }
    loaded.value = false;
    revision.value++;
  }

  // Clear all cached favorites (called on logout to free memory)
  function clearFavorites() {
    favoriteSongIds.value = new Set();
    loaded.value = false;
    revision.value++;
  }

  return { favoriteSongIds, revision, loaded, loading, loadFavorites, isFavorite, toggleFavorite, removeFavorite, clearFavorites };
});
