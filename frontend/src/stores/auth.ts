import { defineStore } from "pinia";
import { ref, computed } from "vue";
import api from "@/api";

export const useAuthStore = defineStore("auth", () => {
  const token = ref(localStorage.getItem("token") || "");
  const username = ref(localStorage.getItem("username") || "");
  const isAdmin = ref(localStorage.getItem("isAdmin") === "true");
  const userSalt = ref(localStorage.getItem("userSalt") || "");
  const isLoggedIn = computed(() => !!token.value);

  async function login(u: string, p: string) {
    const res = await api.post("/rest/api/v1/auth/login", { username: u, password: p });
    const data = res.data;
    token.value = data.token;
    username.value = data.username;
    isAdmin.value = data.isAdmin;
    userSalt.value = data.subsonicToken;
    localStorage.setItem("token", data.token);
    localStorage.setItem("username", data.username);
    localStorage.setItem("isAdmin", String(data.isAdmin));
    localStorage.setItem("userSalt", data.subsonicToken);
    return data;
  }

  function logout() {
    token.value = "";
    username.value = "";
    isAdmin.value = false;
    userSalt.value = "";
    localStorage.removeItem("token");
    localStorage.removeItem("username");
    localStorage.removeItem("isAdmin");
    localStorage.removeItem("userSalt");
  }

  return { token, username, isAdmin, userSalt, isLoggedIn, login, logout };
});
