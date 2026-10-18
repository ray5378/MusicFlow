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
      // 收藏状态与列表预热互不依赖:原先先 await 收藏再发列表请求,让整个预热至少多等
      // 一个收藏 RTT;这里全部并发,收藏只是其中一路。
      // loadFavorites 内部 catch 自身错误、不会 reject。
      await Promise.all([
        favStore.loaded ? Promise.resolve() : favStore.loadFavorites(),
        // 原先把 songs/albums/artists/playlists 4 个列表(page 1)预热拆成 4 个并发请求;
        // HTTP/1.1 下同源仅 6 条连接,多请求既争用连接、又让首页关键 XHR 排队。
        // 后端 /home/preload 一次聚合返回这 4 份数据(前端不消费响应体),合并为 1 个请求
        // 以削减连接争用;失败同样容错为 null。
        api.get("/rest/api/v1/home/preload").catch(() => null),
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
