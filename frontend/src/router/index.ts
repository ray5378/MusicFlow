import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { PERM } from "@/utils/perms";

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
      { path: "songs", name: "Songs", component: () => import("@/views/Music/index.vue"), meta: { perm: PERM.LIBRARY_BROWSE } },
      { path: "genres", name: "Genres", component: () => import("@/views/Genres/index.vue"), meta: { perm: PERM.LIBRARY_BROWSE } },
      { path: "albums", name: "Albums", component: () => import("@/views/Albums/index.vue"), meta: { perm: PERM.LIBRARY_BROWSE } },
      { path: "albums/:id", name: "AlbumDetail", component: () => import("@/views/Albums/Detail.vue"), meta: { perm: PERM.LIBRARY_BROWSE } },
      { path: "artists", name: "Artists", component: () => import("@/views/Artists/index.vue"), meta: { perm: PERM.LIBRARY_BROWSE } },
      { path: "artists/:id", name: "ArtistDetail", component: () => import("@/views/Artists/Detail.vue"), meta: { perm: PERM.LIBRARY_BROWSE } },
      { path: "playlists", name: "Playlists", component: () => import("@/views/Playlists/index.vue"), meta: { perm: PERM.PLAYLIST_VIEW } },
      { path: "playlists/:id", name: "PlaylistDetail", component: () => import("@/views/Playlists/Detail.vue"), meta: { perm: PERM.PLAYLIST_VIEW } },
      { path: "favorites", name: "Favorites", component: () => import("@/views/Favorites/index.vue"), meta: { perm: PERM.FAVORITES_MANAGE } },
      { path: "groups", name: "Groups", component: () => import("@/views/Groups/index.vue"), meta: { perm: PERM.RENDERER_MANAGE } },
      { path: "flows", name: "Flows", component: () => import("@/views/Flows/index.vue"), meta: { perm: PERM.FLOW_MANAGE } },
      { path: "flows/:id", name: "FlowEditor", component: () => import("@/views/Flows/Editor.vue"), meta: { perm: PERM.FLOW_MANAGE } },
      { path: "history", name: "History", component: () => import("@/views/History/index.vue"), meta: { perm: PERM.HISTORY_MANAGE } },
      { path: "settings", name: "Settings", component: () => import("@/views/Settings/index.vue") },
      {
        path: "admin",
        children: [
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
  } else if (to.meta.perm && !authStore.hasPerm(to.meta.perm as string)) {
    next("/");
  } else {
    next();
  }
});

export default router;
