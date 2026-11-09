// Homepage data preloader: after login, fetch frequently-used data in parallel
// and cache it so the first page visits feel instant.
import { defineStore } from "pinia";
import { ref } from "vue";
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
      // 只预加载收藏 id 集合(歌曲行红心状态要用),走轻量接口(几 KB)。
      // 原先这里还调 GET /rest/api/v1/home/preload 预热四个列表第一页;该接口在
      // 服务端同步串行跑 4 次列表查询,实测阻塞事件循环 370–490ms,让首页所有
      // 同源请求一起排队(FCP 1088ms / LCP 4052ms),已于 2026-11-09 移除。
      const favStore = useFavoritesStore();
      if (!favStore.loaded) await favStore.loadFavorites();
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
