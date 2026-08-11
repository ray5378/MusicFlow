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
      // 1. Favorites (used by the star state on every song row)
      const favStore = useFavoritesStore();
      if (!favStore.loaded) await favStore.loadFavorites();

      // 2. Warm up the songs/albums/artists endpoints (page 1) so later visits hit the HTTP cache
      const tasks = [
        api.get("/rest/api/v1/songs", { params: { page: 1, pageSize: 25 } }).catch(() => null),
        api.get("/rest/api/v1/albums", { params: { page: 1, pageSize: 20 } }).catch(() => null),
        api.get("/rest/api/v1/artists", { params: { page: 1, pageSize: 20 } }).catch(() => null),
        api.get("/rest/api/v1/playlists", { params: { page: 1, pageSize: 20 } }).catch(() => null),
      ];
      await Promise.all(tasks);
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
