// Homepage data preloader: after login, fetch frequently-used data in parallel
// and cache it so the first page visits feel instant.
import { defineStore } from "pinia";
import { ref } from "vue";
import api from "@/api";
import { useFavoritesStore } from "@/stores/favorites";
import { useAuthStore } from "@/stores/auth";

export const usePreloadStore = defineStore("preload", () => {
  const loaded = ref(false);
  const loading = ref(false);

  async function preloadHome() {
    const authStore = useAuthStore();
    if (!authStore.isLoggedIn || loaded.value) return;
    loading.value = true;
    try {
      const favStore = useFavoritesStore();
      // 收藏状态与各列表页(page 1)预热互不依赖:原先先 await 收藏再发 4 个列表请求,
      // 让整个预热至少多等一个收藏 RTT。这里全部并发,收藏只是其中一路。
      // loadFavorites 内部 catch 自身错误、不会 reject;列表请求同样 catch 成 null。
      await Promise.all([
        favStore.loaded ? Promise.resolve() : favStore.loadFavorites(),
        api.get("/rest/api/v1/songs", { params: { page: 1, pageSize: 25 } }).catch(() => null),
        api.get("/rest/api/v1/albums", { params: { page: 1, pageSize: 20 } }).catch(() => null),
        api.get("/rest/api/v1/artists", { params: { page: 1, pageSize: 20 } }).catch(() => null),
        api.get("/rest/api/v1/playlists", { params: { page: 1, pageSize: 20 } }).catch(() => null),
      ]);
      loaded.value = true;
    } finally {
      loading.value = false;
    }
  }

  function reset() {
    loaded.value = false;
    loading.value = false;
  }

  return { loaded, loading, preloadHome, reset };
});
