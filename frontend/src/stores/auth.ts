import { defineStore } from "pinia";
import { ref, computed } from "vue";
import api from "@/api";

export const useAuthStore = defineStore("auth", () => {
  const token = ref(localStorage.getItem("token") || "");
  const username = ref(localStorage.getItem("username") || "");
  const isAdmin = ref(localStorage.getItem("isAdmin") === "true");
  const userSalt = ref(localStorage.getItem("userSalt") || "");
  const userId = ref(localStorage.getItem("userId") || "");
  const mustChangePassword = ref(localStorage.getItem("mustChangePassword") === "true");
  const isLoggedIn = computed(() => !!token.value);

  async function login(u: string, p: string) {
    const res = await api.post("/rest/api/v1/auth/login", { username: u, password: p });
    const data = res.data;
    token.value = data.token;
    username.value = data.username;
    isAdmin.value = data.isAdmin;
    userSalt.value = data.subsonicToken;
    userId.value = data.id;
    mustChangePassword.value = !!data.mustChangePassword;
    localStorage.setItem("token", data.token);
    localStorage.setItem("username", data.username);
    localStorage.setItem("isAdmin", String(data.isAdmin));
    localStorage.setItem("userSalt", data.subsonicToken);
    localStorage.setItem("userId", data.id);
    localStorage.setItem("mustChangePassword", String(!!data.mustChangePassword));
    // Preload homepage data in the background (playlists, favorites, first pages...)
    const { usePreloadStore } = await import("@/stores/preload");
    usePreloadStore().preloadHome();
    return data;
  }

  async function setPasswordChanged() {
    mustChangePassword.value = false;
    localStorage.removeItem("mustChangePassword");
  }

  function setUsername(name: string) {
    username.value = name;
    localStorage.setItem("username", name);
  }

  function logout() {
    token.value = "";
    username.value = "";
    isAdmin.value = false;
    userSalt.value = "";
    userId.value = "";
    mustChangePassword.value = false;
    localStorage.removeItem("token");
    localStorage.removeItem("username");
    localStorage.removeItem("isAdmin");
    localStorage.removeItem("userSalt");
    localStorage.removeItem("userId");
    localStorage.removeItem("mustChangePassword");
    // Release memory: clear player queue/audio, favorites, cached preload data
    // (dynamic imports avoid circular dependency at module load time)
    import("@/stores/player").then(({ usePlayerStore }) => {
      usePlayerStore().clearQueue();
    }).catch(() => {});
    import("@/stores/favorites").then(({ useFavoritesStore }) => {
      useFavoritesStore().clearFavorites();
    }).catch(() => {});
    import("@/stores/preload").then(({ usePreloadStore }) => {
      usePreloadStore().reset();
    }).catch(() => {});
  }

  return { token, username, isAdmin, userSalt, userId, mustChangePassword, isLoggedIn, login, logout, setPasswordChanged, setUsername };
});
