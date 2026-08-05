import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const routes = [
  {
    path: "/login",
    name: "Login",
    component: () => import("@/views/Login/index.vue"),
    meta: { requiresAuth: false },
  },
  {
    path: "/",
    component: () => import("@/layouts/MainLayout.vue"),
    meta: { requiresAuth: true },
    children: [
      { path: "", name: "Home", component: () => import("@/views/Home/index.vue") },
      { path: "songs", name: "Songs", component: () => import("@/views/Music/index.vue") },
      { path: "genres", name: "Genres", component: () => import("@/views/Genres/index.vue") },
      { path: "albums", name: "Albums", component: () => import("@/views/Albums/index.vue") },
      { path: "albums/:id", name: "AlbumDetail", component: () => import("@/views/Albums/Detail.vue") },
      { path: "artists", name: "Artists", component: () => import("@/views/Artists/index.vue") },
      { path: "artists/:id", name: "ArtistDetail", component: () => import("@/views/Artists/Detail.vue") },
      { path: "playlists", name: "Playlists", component: () => import("@/views/Playlists/index.vue") },
      { path: "playlists/:id", name: "PlaylistDetail", component: () => import("@/views/Playlists/Detail.vue") },
      { path: "favorites", name: "Favorites", component: () => import("@/views/Favorites/index.vue") },
      { path: "groups", name: "Groups", component: () => import("@/views/Groups/index.vue") },
      { path: "history", name: "History", component: () => import("@/views/History/index.vue") },
      { path: "settings", name: "Settings", component: () => import("@/views/Settings/index.vue") },
      {
        path: "admin",
        children: [
          { path: "music", name: "AdminMusic", component: () => import("@/views/admin/Music/index.vue"), meta: { requiresAdmin: true } },
          { path: "plugins", name: "AdminPlugins", component: () => import("@/views/admin/Plugins/index.vue"), meta: { requiresAdmin: true } },
          { path: "sources", name: "AdminSources", component: () => import("@/views/admin/Sources/index.vue"), meta: { requiresAdmin: true } },
          { path: "users", name: "AdminUsers", component: () => import("@/views/admin/Users/index.vue"), meta: { requiresAdmin: true } },
          { path: "wish", name: "AdminWish", component: () => import("@/views/admin/Wish/index.vue"), meta: { requiresAdmin: true } },
          { path: "settings", name: "AdminSettings", component: () => import("@/views/admin/Settings/index.vue"), meta: { requiresAdmin: true } },
        ],
      },
    ],
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to, _from, next) => {
  const authStore = useAuthStore();
  if (to.meta.requiresAuth !== false && !authStore.isLoggedIn) {
    next("/login");
  } else if (to.meta.requiresAdmin && !authStore.isAdmin) {
    next("/");
  } else {
    next();
  }
});

export default router;
