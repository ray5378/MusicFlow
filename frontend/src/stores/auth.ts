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

  // 细粒度权限:管理员 { admin: true };普通用户为「默认值 + 显式覆盖」的有效权限表。
  const permissions = ref<Record<string, boolean>>(loadJson("permissions", {}));
  // 播放器授权列表("dlna:<id>" / "airplay:<id>" / "group:<id>"),管理员为 null。
  const rendererGrants = ref<string[] | null>(loadJson("rendererGrants", null));

  function loadJson(key: string, fallback: any): any {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  /** 功能权限判定:管理员恒通过;缺失 key 按默认放行(后端才是最终仲裁)。 */
  function hasPerm(key: string): boolean {
    if (isAdmin.value) return true;
    const v = permissions.value[key];
    return v === undefined ? true : v;
  }

  /** 是否能控制某个播放器(普通用户需 renderer.use + 设备授权)。 */
  function canUseRenderer(deviceKey: string): boolean {
    if (isAdmin.value) return true;
    if (!hasPerm("renderer.use")) return false;
    return !!rendererGrants.value?.includes(deviceKey);
  }

  async function login(u: string, p: string) {
    const res = await api.post("/rest/api/v1/auth/login", { username: u, password: p });
    const data = res.data;
    token.value = data.token;
    username.value = data.username;
    isAdmin.value = data.isAdmin;
    userSalt.value = data.subsonicToken;
    userId.value = data.id;
    mustChangePassword.value = !!data.mustChangePassword;
    permissions.value = isAdmin.value ? { admin: true } : (data.permissions || {});
    rendererGrants.value = isAdmin.value ? null : (data.rendererGrants || []);
    localStorage.setItem("token", data.token);
    localStorage.setItem("username", data.username);
    localStorage.setItem("isAdmin", String(data.isAdmin));
    localStorage.setItem("userSalt", data.subsonicToken);
    localStorage.setItem("userId", data.id);
    localStorage.setItem("mustChangePassword", String(!!data.mustChangePassword));
    localStorage.setItem("permissions", JSON.stringify(permissions.value));
    localStorage.setItem("rendererGrants", JSON.stringify(rendererGrants.value));
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
    permissions.value = {};
    rendererGrants.value = null;
    localStorage.removeItem("token");
    localStorage.removeItem("username");
    localStorage.removeItem("isAdmin");
    localStorage.removeItem("userSalt");
    localStorage.removeItem("userId");
    localStorage.removeItem("mustChangePassword");
    localStorage.removeItem("permissions");
    localStorage.removeItem("rendererGrants");
    // Release memory: clear player queue/audio, favorites, cached preload data
    // (dynamic imports avoid circular dependency at module load time)
    import("@/stores/player").then(({ usePlayerStore }) => {
      usePlayerStore().teardownPeer();
      usePlayerStore().clearQueue();
    }).catch(() => {});
    import("@/stores/favorites").then(({ useFavoritesStore }) => {
      useFavoritesStore().clearFavorites();
    }).catch(() => {});
    import("@/stores/preload").then(({ usePreloadStore }) => {
      usePreloadStore().reset();
    }).catch(() => {});
  }

  return { token, username, isAdmin, userSalt, userId, mustChangePassword, isLoggedIn, permissions, rendererGrants, hasPerm, canUseRenderer, login, logout, setPasswordChanged, setUsername };
});
