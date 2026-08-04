<template>
  <div class="main-layout">
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="logo" @click="sidebarCollapsed = !sidebarCollapsed">
        <img src="/favicon.png" alt="MusicFlow" class="logo-img" />
        <span v-if="!sidebarCollapsed" class="logo-text">MusicFlow</span>
      </div>
      <el-menu :default-active="activeMenu" :collapse="sidebarCollapsed" router class="sidebar-menu">
        <el-menu-item index="/songs"><el-icon><Headset /></el-icon><template #title>音乐</template></el-menu-item>
        <el-menu-item index="/genres"><el-icon><Collection /></el-icon><template #title>风格</template></el-menu-item>
        <el-menu-item index="/albums"><el-icon><Service /></el-icon><template #title>专辑</template></el-menu-item>
        <el-menu-item index="/artists"><el-icon><User /></el-icon><template #title>艺术家</template></el-menu-item>
        <el-menu-item index="/playlists"><el-icon><List /></el-icon><template #title>歌单</template></el-menu-item>
        <el-menu-item index="/history"><el-icon><Clock /></el-icon><template #title>播放历史</template></el-menu-item>
        <el-divider v-if="authStore.isAdmin" />
        <el-menu-item v-if="authStore.isAdmin" index="/admin/music"><el-icon><Search /></el-icon><template #title>音乐管理</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/plugins"><el-icon><Connection /></el-icon><template #title>插件管理</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/sources"><el-icon><FolderOpened /></el-icon><template #title>媒体源</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/users"><el-icon><UserFilled /></el-icon><template #title>用户管理</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/wish"><el-icon><ChatDotRound /></el-icon><template #title>许愿</template></el-menu-item>
        <el-menu-item v-if="authStore.isAdmin" index="/admin/settings"><el-icon><Setting /></el-icon><template #title>系统设置</template></el-menu-item>
      </el-menu>
      <div class="sidebar-footer">
        <el-dropdown @command="handleCommand">
          <span class="user-info"><el-icon><UserFilled /></el-icon><span v-if="!sidebarCollapsed">{{ authStore.username }}</span></span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="settings">设置</el-dropdown-item>
              <el-dropdown-item command="logout" divided>登出</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </aside>

    <main class="main-content"><router-view /></main>

    <!-- ===== Player bar ===== -->
    <footer class="player-bar" v-if="playerStore.currentSong">
      <div class="player-left" @click="playerStore.togglePlayMode">
        <img v-if="coverUrl" :src="coverUrl" class="player-cover" />
        <div v-else class="player-cover-placeholder"><el-icon :size="24"><Headset /></el-icon></div>
        <div class="player-song-info">
          <div class="player-title">{{ playerStore.currentSong.title }}</div>
          <div class="player-artist">
            <span v-if="playerStore.currentLyricLine" class="player-lyric">{{ playerStore.currentLyricLine }}</span>
            <span v-else>{{ playerStore.currentSong.artist }}</span>
          </div>
        </div>
      </div>
      <div class="player-center">
        <div class="player-controls">
          <el-tooltip :content="playModeTooltip" placement="top">
            <el-button circle size="small" @click="playerStore.cyclePlayMode" :type="playerStore.playMode !== 'order' ? 'primary' : ''" class="ctrl-btn">
              <PlaybackIcon :name="playModeIconName" :size="16" />
            </el-button>
          </el-tooltip>
          <el-tooltip content="上一首" placement="top">
            <el-button circle @click="playerStore.prev" class="ctrl-btn"><PlaybackIcon name="prev" :size="20" /></el-button>
          </el-tooltip>
          <el-tooltip :content="playerStore.isPlaying ? '暂停' : '播放'" placement="top">
            <el-button circle @click="playerStore.togglePlay" type="primary" class="ctrl-btn play-btn">
              <PlaybackIcon :name="playerStore.isPlaying ? 'pause' : 'play'" :size="26" />
            </el-button>
          </el-tooltip>
          <el-tooltip content="下一首" placement="top">
            <el-button circle @click="playerStore.next" class="ctrl-btn"><PlaybackIcon name="next" :size="20" /></el-button>
          </el-tooltip>
          <el-tooltip content="播放列表" placement="top">
            <el-button :icon="List" circle size="small" @click="playerStore.togglePlaylistPanel" :type="playerStore.showPlaylist ? 'primary' : ''" />
          </el-tooltip>
          <el-tooltip content="添加到歌单" placement="top">
            <el-button :icon="Plus" circle size="small" @click="openAddToPlaylist" />
          </el-tooltip>
          <el-tooltip content="DLNA 投屏" placement="top">
            <el-button :icon="Monitor" circle size="small" @click="openDlnaDialog" :type="dlnaActive ? 'primary' : ''" />
          </el-tooltip>
          <el-tooltip :content="isCurrentFavorite ? '取消喜欢' : '我喜欢的音乐'" placement="top">
            <el-button
              circle
              size="small"
              class="fav-btn"
              @click="toggleCurrentFavorite"
            >
              <HeartIcon :filled="isCurrentFavorite" :size="16" />
            </el-button>
          </el-tooltip>
        </div>
        <div class="player-progress">
          <span class="time">{{ formatTime(playerStore.currentTime) }}</span>
          <el-slider :model-value="playerStore.progress" @input="playerStore.seekPercent" :show-tooltip="false" class="progress-slider" />
          <span class="time">{{ formatTime(playerStore.duration) }}</span>
        </div>
      </div>
      <div class="player-right">
        <el-tooltip content="全屏播放" placement="top">
          <el-button :icon="ChatDotRound" circle size="small" @click="playerStore.togglePlayMode" :type="playerStore.playModeVisible ? 'primary' : ''" />
        </el-tooltip>
        <el-slider :model-value="playerStore.volume * 100" @input="(v: number) => playerStore.setVolume(v / 100)" :show-tooltip="false" class="volume-slider" />
      </div>
    </footer>

    <!-- ===== DLNA cast status bar ===== -->
    <div class="dlna-status-bar" v-if="dlnaActive">
      <span class="dlna-status-label"><el-icon><Monitor /></el-icon> 投屏中:{{ dlnaDeviceName }}</span>
      <el-button size="small" circle @click="dlnaPlay" :disabled="dlnaState === 'PLAYING'"><PlaybackIcon name="play" :size="14" /></el-button>
      <el-button size="small" circle @click="dlnaPause" :disabled="dlnaState === 'PAUSED_PLAYBACK' || dlnaState === 'STOPPED'"><PlaybackIcon name="pause" :size="14" /></el-button>
      <el-button size="small" circle :icon="VideoPause" @click="dlnaStop" />
      <el-slider :model-value="dlnaVolume" @input="dlnaSetVolume" :show-tooltip="false" class="dlna-volume" size="small" />
      <el-button size="small" text @click="openDlnaDialog">切换设备</el-button>
    </div>

    <!-- ===== Queue panel ===== -->
    <transition name="slide-right">
      <div class="queue-panel" v-if="playerStore.showPlaylist && playerStore.currentSong">
        <div class="queue-header">
          <span>播放队列 ({{ playerStore.queue.length }})</span>
          <div class="queue-actions">
            <el-button size="small" text @click="playerStore.clearQueue">清空</el-button>
            <el-button size="small" text @click="playerStore.togglePlaylistPanel">关闭</el-button>
          </div>
        </div>
        <div class="queue-list">
          <div
            v-for="(song, idx) in playerStore.queue"
            :key="song.id"
            class="queue-item"
            :class="{ active: idx === playerStore.currentIndex }"
            @click="playFromQueue(idx)"
          >
            <div class="queue-cover">
              <img v-if="song.coverArt" :src="`/rest/getCoverArt?id=${song.coverArt}&size=80`" />
              <div v-else class="queue-cover-ph"><el-icon><Headset /></el-icon></div>
              <span v-if="idx === playerStore.currentIndex" class="playing-indicator" :class="{ paused: !playerStore.isPlaying }"></span>
            </div>
            <div class="queue-info">
              <div class="queue-title">{{ song.title }}</div>
              <div class="queue-artist">{{ song.artist }}</div>
            </div>
            <div class="queue-duration">{{ formatTime(song.duration) }}</div>
            <el-button :icon="Close" circle size="small" text class="queue-remove" @click.stop="removeFromQueue(idx)" />
          </div>
          <div v-if="playerStore.queue.length === 0" class="queue-empty">队列为空</div>
        </div>
      </div>
    </transition>

    <!-- ===== Fullscreen play mode (NetEase style) ===== -->
    <transition name="fade">
      <div class="play-mode" v-if="playerStore.playModeVisible && playerStore.currentSong">
        <div class="play-mode-bg"></div>
        <button class="play-mode-close" @click="playerStore.togglePlayMode"><el-icon :size="24"><Close /></el-icon></button>

        <div class="play-mode-body">
          <!-- Left: rotating disc -->
          <div class="pm-left">
            <div class="pm-disc" :class="{ spinning: playerStore.isPlaying }">
              <img v-if="coverUrl" :src="coverUrl" class="pm-disc-img" />
              <div v-else class="pm-disc-ph"><el-icon :size="80"><Headset /></el-icon></div>
              <div class="pm-disc-hole"></div>
            </div>
            <div class="pm-song-title">{{ playerStore.currentSong.title }}</div>
            <div class="pm-song-artist">{{ playerStore.currentSong.artist }}</div>
            <div class="pm-song-album" v-if="playerStore.currentSong.album">{{ playerStore.currentSong.album }}</div>
          </div>

          <!-- Right: scrolling lyrics -->
          <div class="pm-right" ref="lyricsContainer">
            <div class="pm-lyrics">
              <div
                v-for="(line, i) in playerStore.lyrics"
                :key="i"
                class="pm-lyric-line"
                :class="{ active: i === playerStore.currentLyricIndex }"
              >{{ line.text }}</div>
              <div v-if="playerStore.lyrics.length === 0" class="pm-lyrics-empty">暂无歌词</div>
            </div>
          </div>
        </div>

        <!-- Bottom: controls -->
        <div class="play-mode-controls">
          <div class="pm-progress">
            <span class="time">{{ formatTime(playerStore.currentTime) }}</span>
            <el-slider :model-value="playerStore.progress" @input="playerStore.seekPercent" :show-tooltip="false" class="pm-slider" />
            <span class="time">{{ formatTime(playerStore.duration) }}</span>
          </div>
          <div class="pm-buttons">
            <el-tooltip :content="playModeTooltip" placement="top">
              <el-button circle size="small" @click="playerStore.cyclePlayMode" :type="playerStore.playMode !== 'order' ? 'primary' : ''" class="ctrl-btn">
                <PlaybackIcon :name="playModeIconName" :size="18" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="上一首" placement="top">
              <el-button circle @click="playerStore.prev" class="ctrl-btn pm-nav-btn"><PlaybackIcon name="prev" :size="26" /></el-button>
            </el-tooltip>
            <el-tooltip :content="playerStore.isPlaying ? '暂停' : '播放'" placement="top">
              <el-button circle @click="playerStore.togglePlay" type="primary" class="ctrl-btn pm-play-btn">
                <PlaybackIcon :name="playerStore.isPlaying ? 'pause' : 'play'" :size="30" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="下一首" placement="top">
              <el-button circle @click="playerStore.next" class="ctrl-btn pm-nav-btn"><PlaybackIcon name="next" :size="26" /></el-button>
            </el-tooltip>
            <el-tooltip content="添加到歌单" placement="top">
              <el-button :icon="Plus" circle size="small" @click="openAddToPlaylist" />
            </el-tooltip>
            <el-tooltip :content="isCurrentFavorite ? '取消喜欢' : '我喜欢的音乐'" placement="top">
              <el-button
                circle
                size="small"
                class="fav-btn pm-fav-btn"
                @click="toggleCurrentFavorite"
              >
                <HeartIcon :filled="isCurrentFavorite" :size="18" />
              </el-button>
            </el-tooltip>
          </div>
        </div>
      </div>
    </transition>

    <!-- ===== Add to playlist dialog ===== -->
    <el-dialog v-model="showPlaylistDialog" title="添加到歌单" width="420px">
      <div class="playlist-dialog-song" v-if="playlistTargetSong">
        将「{{ playlistTargetSong.title }} - {{ playlistTargetSong.artist }}」添加到：
      </div>
      <div class="playlist-list" v-loading="playlistsLoading">
        <div
          v-for="pl in playlists"
          :key="pl.id"
          class="playlist-item"
          :class="{ active: addingPlaylistId === pl.id }"
          @click="addToPlaylist(pl)"
        >
          <el-icon class="pl-icon"><List /></el-icon>
          <div class="pl-info">
            <div class="pl-name">{{ pl.name }}</div>
            <div class="pl-meta">{{ pl.songCount }}首</div>
          </div>
          <el-icon v-if="addingPlaylistId === pl.id" class="el-icon is-loading"><Loading /></el-icon>
        </div>
        <div v-if="playlists.length === 0 && !playlistsLoading" class="empty-tip">暂无歌单，先创建一个吧</div>
      </div>
      <div class="create-playlist-row">
        <el-input v-model="newPlaylistName" placeholder="新建歌单名称..." clearable @keyup.enter="createAndAdd" />
        <el-button type="primary" @click="createAndAdd" :disabled="!newPlaylistName">新建并添加</el-button>
      </div>
    </el-dialog>

    <!-- ===== DLNA device dialog ===== -->
    <el-dialog v-model="showDlnaDialog" title="DLNA 投屏" width="440px">
      <div class="dlna-dialog-song" v-if="playerStore.currentSong">
        将「{{ playerStore.currentSong.title }}」投屏到：
      </div>
      <div class="playlist-list" v-loading="dlnaScanning">
        <div
          v-for="dev in dlnaDevices"
          :key="dev.id"
          class="playlist-item"
          :class="{ active: dlnaActiveDevice === dev.id }"
          @click="castTo(dev)"
        >
          <el-icon class="pl-icon"><Monitor /></el-icon>
          <div class="pl-info">
            <div class="pl-name">{{ dev.name }}</div>
            <div class="pl-meta">{{ dev.manufacturer || dev.model || 'DLNA 设备' }}</div>
          </div>
          <el-icon v-if="dlnaCastingDevice === dev.id" class="el-icon is-loading"><Loading /></el-icon>
        </div>
        <div v-if="dlnaDevices.length === 0 && !dlnaScanning" class="empty-tip">
          未发现 DLNA 设备,请确认设备在同一局域网且已开启 DLNA
        </div>
      </div>
      <div class="create-playlist-row">
        <el-button :loading="dlnaScanning" @click="scanDlnaDevices"><el-icon><Refresh /></el-icon>重新扫描</el-button>
        <span v-if="dlnaActive" class="dlna-current-tip">当前: {{ dlnaDeviceName }}</span>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { usePlayerStore } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import { Headset, User, List, Clock, Search, Connection, FolderOpened, UserFilled, ChatDotRound, Setting, Close, Plus, Loading, Collection, Monitor, Refresh, VideoPause } from "@element-plus/icons-vue";
import HeartIcon from "@/components/HeartIcon.vue";
import PlaybackIcon from "@/components/PlaybackIcon.vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const playerStore = usePlayerStore();
const favoritesStore = useFavoritesStore();
const sidebarCollapsed = ref(false);
const lyricsContainer = ref<HTMLElement | null>(null);

// Add-to-playlist dialog state
const showPlaylistDialog = ref(false);
const playlistTargetSong = ref<any>(null);
const playlists = ref<any[]>([]);
const playlistsLoading = ref(false);
const addingPlaylistId = ref("");
const newPlaylistName = ref("");

const isCurrentFavorite = computed(() => {
  const s = playerStore.currentSong;
  return s ? favoritesStore.isFavorite(s.id) : false;
});

const activeMenu = computed(() => route.path);
const coverUrl = computed(() => {
  if (!playerStore.currentSong) return "";
  return playerStore.getCoverUrl(playerStore.currentSong.coverArt || playerStore.currentSong.id);
});

// NetEase-style play mode icon + tooltip
const playModeIconName = computed(() => {
  switch (playerStore.playMode) {
    case "one": return "loopOne";
    case "all": return "loopAll";
    case "shuffle": return "shuffle";
    default: return "order";
  }
});
const playModeTooltip = computed(() => {
  switch (playerStore.playMode) {
    case "one": return "单曲循环";
    case "all": return "列表循环";
    case "shuffle": return "随机播放";
    default: return "顺序播放";
  }
});

function formatTime(seconds: number) { const m = Math.floor(seconds / 60); const s = Math.floor(seconds % 60); return `${m}:${s.toString().padStart(2, "0")}`; }

function handleCommand(cmd: string) {
  if (cmd === "logout") { authStore.logout(); router.push("/login"); }
  else if (cmd === "settings") router.push("/settings");
}

function playFromQueue(idx: number) {
  const song = playerStore.queue[idx];
  if (song) playerStore.playSong(song);
}

function removeFromQueue(idx: number) { playerStore.removeFromQueue(idx); }

// ===== Add to playlist (from player bar / play mode) =====
async function openAddToPlaylist() {
  const song = playerStore.currentSong;
  if (!song) return;
  playlistTargetSong.value = song;
  showPlaylistDialog.value = true;
  newPlaylistName.value = "";
  await loadPlaylists();
}

async function loadPlaylists() {
  playlistsLoading.value = true;
  try {
    const res = await api.get("/rest/getPlaylists?f=json");
    playlists.value = res.data["subsonic-response"]?.playlists?.playlist || [];
  } catch { playlists.value = []; }
  finally { playlistsLoading.value = false; }
}

async function addToPlaylist(pl: any) {
  if (!playlistTargetSong.value || addingPlaylistId.value) return;
  addingPlaylistId.value = pl.id;
  try {
    await api.post("/rest/updatePlaylist", { playlistId: pl.id, songIdToAdd: playlistTargetSong.value.id });
    ElMessage.success(`已添加到「${pl.name}」`);
    showPlaylistDialog.value = false;
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "添加失败");
  } finally {
    addingPlaylistId.value = "";
  }
}

async function createAndAdd() {
  if (!newPlaylistName.value || !playlistTargetSong.value) return;
  if (addingPlaylistId.value) return;
  addingPlaylistId.value = "new";
  try {
    await api.post("/rest/createPlaylist", { name: newPlaylistName.value, songId: playlistTargetSong.value.id });
    ElMessage.success(`已创建并添加「${newPlaylistName.value}」`);
    showPlaylistDialog.value = false;
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "创建失败");
  } finally {
    addingPlaylistId.value = "";
  }
}

// ===== Favorite current song (from play mode) =====
async function toggleCurrentFavorite() {
  const song = playerStore.currentSong;
  if (!song) return;
  try {
    const fav = await favoritesStore.toggleFavorite(song.id);
    ElMessage.success(fav ? "已添加到我喜欢的音乐" : "已从我喜欢的音乐移除");
  } catch (e: any) { ElMessage.error(e.message || "操作失败"); }
}

// ===== DLNA cast =====
const showDlnaDialog = ref(false);
const dlnaDevices = ref<any[]>([]);
const dlnaScanning = ref(false);
const dlnaCastingDevice = ref("");
const dlnaActiveDevice = ref("");
const dlnaDeviceName = ref("");
const dlnaState = ref("STOPPED");
const dlnaVolume = ref(50);
let dlnaPollTimer: ReturnType<typeof setInterval> | null = null;

const dlnaActive = computed(() => !!dlnaActiveDevice.value);

async function openDlnaDialog() {
  if (!playerStore.currentSong) { ElMessage.warning("请先选择一首歌曲"); return; }
  showDlnaDialog.value = true;
  await scanDlnaDevices();
}

async function scanDlnaDevices() {
  dlnaScanning.value = true;
  try {
    const res = await api.post("/rest/api/v1/dlna/scan");
    dlnaDevices.value = res.data.devices || [];
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "扫描失败");
    dlnaDevices.value = [];
  } finally { dlnaScanning.value = false; }
}

async function castTo(dev: any) {
  const song = playerStore.currentSong;
  if (!song) { ElMessage.warning("请先选择一首歌曲"); return; }
  dlnaCastingDevice.value = dev.id;
  try {
    await api.post("/rest/api/v1/dlna/cast", { songId: song.id, deviceId: dev.id });
    dlnaActiveDevice.value = dev.id;
    dlnaDeviceName.value = dev.name;
    showDlnaDialog.value = false;
    ElMessage.success(`已投屏到「${dev.name}」`);
    startDlnaPoll();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "投屏失败");
  } finally { dlnaCastingDevice.value = ""; }
}

async function dlnaPlay() {
  if (!dlnaActiveDevice.value) return;
  try { await api.post(`/rest/api/v1/dlna/devices/${dlnaActiveDevice.value}/play`); } catch {}
}
async function dlnaPause() {
  if (!dlnaActiveDevice.value) return;
  try { await api.post(`/rest/api/v1/dlna/devices/${dlnaActiveDevice.value}/pause`); } catch {}
}
async function dlnaStop() {
  if (!dlnaActiveDevice.value) return;
  try { await api.post(`/rest/api/v1/dlna/devices/${dlnaActiveDevice.value}/stop`); } catch {}
  stopDlnaPoll();
  dlnaActiveDevice.value = "";
  dlnaDeviceName.value = "";
  dlnaState.value = "STOPPED";
}
async function dlnaSetVolume(v: number) {
  if (!dlnaActiveDevice.value) return;
  try { await api.post(`/rest/api/v1/dlna/devices/${dlnaActiveDevice.value}/volume`, { volume: v }); } catch {}
}

function startDlnaPoll() {
  stopDlnaPoll();
  dlnaPollTimer = setInterval(async () => {
    if (!dlnaActiveDevice.value) { stopDlnaPoll(); return; }
    try {
      const res = await api.get(`/rest/api/v1/dlna/devices/${dlnaActiveDevice.value}/status`);
      dlnaState.value = res.data.state || "STOPPED";
      if (typeof res.data.volume === "number") dlnaVolume.value = res.data.volume;
      if (res.data.state === "STOPPED" && dlnaState.value === "STOPPED") {
        // Device stopped on its own (track ended) — keep device active so user can recast.
      }
    } catch {}
  }, 3000);
}

function stopDlnaPoll() {
  if (dlnaPollTimer) { clearInterval(dlnaPollTimer); dlnaPollTimer = null; }
}

// Load favorites + preload homepage data once on mount (refresh-page scenario)
nextTick(() => {
  if (!authStore.isLoggedIn) return; // not logged in: avoid fetching any data
  favoritesStore.loadFavorites();
  import("@/stores/preload").then(({ usePreloadStore }) => usePreloadStore().preloadHome()).catch(() => {});
});

// Auto-scroll lyrics to the active line in play mode (waits for DOM update)
watch(() => playerStore.currentLyricIndex, async (idx) => {
  if (idx < 0) return;
  await nextTick();
  const container = lyricsContainer.value; // .pm-right (scrollable)
  if (!container) return;
  const lines = container.querySelectorAll(".pm-lyric-line");
  const active = lines[idx] as HTMLElement | undefined;
  if (!active) return;
  // Center the active line inside the scrollable container
  const targetTop = active.offsetTop - container.clientHeight / 2 + active.clientHeight / 2;
  container.scrollTo({ top: targetTop, behavior: "smooth" });
});
</script>

<style lang="scss" scoped>
.main-layout { display: flex; height: 100vh; overflow: hidden; }
.sidebar {
  width: var(--sidebar-width); background: #1a1a2e; color: #fff; display: flex; flex-direction: column; transition: width 0.3s; flex-shrink: 0;
  &.collapsed { width: var(--sidebar-collapsed-width); }
  .logo { display: flex; align-items: center; padding: 16px; cursor: pointer; gap: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); height: var(--header-height);
    .logo-img { width: 28px; height: 28px; border-radius: 6px; flex-shrink: 0; }
    .logo-text { font-size: 18px; font-weight: 600; white-space: nowrap; }
  }
  .sidebar-menu { flex: 1; overflow-y: auto; border-right: none !important; background: transparent;
    :deep(.el-menu) { background: transparent; }
    :deep(.el-menu-item) { color: rgba(255,255,255,0.7); &:hover, &.is-active { background: rgba(195,95,51,0.3); color: #fff; } }
    :deep(.el-divider) { border-color: rgba(255,255,255,0.1); }
  }
  .sidebar-footer { padding: 12px; border-top: 1px solid rgba(255,255,255,0.1);
    .user-info { display: flex; align-items: center; gap: 8px; color: rgba(255,255,255,0.7); cursor: pointer; }
  }
}
.main-content { flex: 1; overflow-y: auto; padding-bottom: var(--player-height); }
.player-bar {
  position: fixed; bottom: 0; left: var(--sidebar-width); right: 0; height: var(--player-height); background: #fff; border-top: 1px solid #e8e8e8; display: flex; align-items: center; padding: 0 20px; z-index: 100; box-shadow: 0 -2px 10px rgba(0,0,0,0.05);
  .player-left { display: flex; align-items: center; gap: 12px; width: 280px; flex-shrink: 0; cursor: pointer; overflow: hidden;
    .player-cover { width: 48px; height: 48px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
    .player-cover-placeholder { width: 48px; height: 48px; border-radius: 6px; background: #f0f0f0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .player-song-info { flex: 1; min-width: 0; .player-title { font-weight: 500; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .player-artist { font-size: 12px; color: #999; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .player-lyric { color: #c35f33; } }
  }
  .player-center { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; max-width: 600px; margin: 0 auto;
    .player-controls { display: flex; align-items: center; gap: 8px; }
    .player-progress { display: flex; align-items: center; gap: 8px; width: 100%;
      .time { font-size: 12px; color: #999; min-width: 40px; }
      .progress-slider { flex: 1; }
    }
  }
  .player-right { display: flex; align-items: center; gap: 8px; width: 220px; flex-shrink: 0; justify-content: flex-end;
    .volume-slider { width: 100px; }
  }
}

/* Standard playback control buttons: icon vertically centered */
.ctrl-btn { display: inline-flex; align-items: center; justify-content: center; padding: 0; min-width: 36px; width: 36px; height: 36px; min-height: 36px; }
.ctrl-btn .playback-icon { display: block; }
.ctrl-btn.play-btn { width: 44px; height: 44px; min-width: 44px; min-height: 44px; }

/* ===== Queue panel ===== */
.queue-panel {
  position: fixed; top: 0; right: 0; bottom: var(--player-height); width: 360px; background: #fff; z-index: 200;
  box-shadow: -2px 0 16px rgba(0,0,0,0.1); display: flex; flex-direction: column;
  .queue-header { display: flex; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid #f0f0f0; font-weight: 600; }
  .queue-list { flex: 1; overflow-y: auto; padding: 8px;
    .queue-item { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; cursor: pointer;
      &:hover { background: #f5f7fa; }
      &.active { background: rgba(195,95,51,0.1); }
      .queue-cover { position: relative; width: 40px; height: 40px; border-radius: 4px; overflow: hidden; flex-shrink: 0;
        img { width: 100%; height: 100%; object-fit: cover; }
        .queue-cover-ph { width: 100%; height: 100%; background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #ccc; }
        .playing-indicator { position: absolute; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
        .playing-indicator::before { content: ''; width: 8px; height: 12px; background: linear-gradient(180deg, #fff 0 33%, transparent 33% 66%, #fff 66%); animation: eq 1s infinite; }
      }
      .queue-info { flex: 1; min-width: 0;
        .queue-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .queue-artist { font-size: 12px; color: #999; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      }
      .queue-duration { font-size: 12px; color: #999; }
      .queue-remove { opacity: 0; transition: opacity 0.2s; }
      &:hover .queue-remove { opacity: 1; }
    }
    .queue-empty { text-align: center; color: #999; padding: 40px 0; }
  }
}

/* ===== Fullscreen play mode ===== */
.play-mode {
  position: fixed; inset: 0; z-index: 300; background: linear-gradient(160deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  color: #fff; display: flex; flex-direction: column; overflow: hidden;
  .play-mode-bg { position: absolute; inset: 0; background: radial-gradient(circle at 30% 40%, rgba(195,95,51,0.2), transparent 60%); pointer-events: none; }
  .play-mode-close { position: absolute; top: 20px; right: 24px; z-index: 10; background: rgba(255,255,255,0.1); border: none; color: #fff; width: 44px; height: 44px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;
    &:hover { background: rgba(255,255,255,0.2); } }
  .play-mode-body { flex: 1; display: flex; align-items: center; justify-content: center; gap: 120px; padding: 40px 80px; position: relative; }
  .pm-left { display: flex; flex-direction: column; align-items: center; width: 400px; flex-shrink: 0;
    .pm-disc { position: relative; width: 340px; height: 340px; border-radius: 50%; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      .pm-disc-img { width: 100%; height: 100%; object-fit: cover; }
      .pm-disc-ph { width: 100%; height: 100%; background: #1a1a2e; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.3); }
      .pm-disc-hole { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 44px; height: 44px; border-radius: 50%; background: #0f3460; border: 6px solid rgba(255,255,255,0.25); }
      &.spinning { animation: spin 20s linear infinite; }
    }
    .pm-song-title { margin-top: 28px; font-size: 22px; font-weight: 700; text-align: center; max-width: 380px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pm-song-artist { margin-top: 8px; font-size: 15px; color: rgba(255,255,255,0.7); }
    .pm-song-album { margin-top: 4px; font-size: 13px; color: rgba(255,255,255,0.4); }
  }
  .pm-right { width: 480px; height: 60vh; overflow-y: auto; display: flex; flex-direction: column; align-items: center; scrollbar-width: none; scroll-behavior: smooth;
    &::-webkit-scrollbar { display: none; }
    .pm-lyrics { width: 100%; display: flex; flex-direction: column; align-items: center; padding: 45% 0; }
    .pm-lyric-line { font-size: 15px; color: rgba(255,255,255,0.35); padding: 10px 0; text-align: center; line-height: 1.6; transition: all 0.4s ease; cursor: default;
      &.active { color: #f5b942; font-size: 21px; font-weight: 700; text-shadow: 0 0 20px rgba(245,185,66,0.5); }
    }
    .pm-lyrics-empty { color: rgba(255,255,255,0.3); font-size: 15px; padding: 60px 0; }
  }
  .play-mode-controls { padding: 24px 80px 40px; display: flex; flex-direction: column; align-items: center; gap: 12px; position: relative;
    .pm-progress { display: flex; align-items: center; gap: 12px; width: 100%; max-width: 700px;
      .time { font-size: 12px; color: rgba(255,255,255,0.6); min-width: 40px; }
      .pm-slider { flex: 1; }
    }
    .pm-buttons { display: flex; align-items: center; gap: 16px;
      .pm-play-btn { width: 60px; height: 60px; min-width: 60px; min-height: 60px; }
      .pm-nav-btn { width: 48px; height: 48px; min-width: 48px; min-height: 48px; }
    }
  }
}

@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes eq { 0%,100% { transform: scaleY(0.4); } 50% { transform: scaleY(1); } }

.slide-right-enter-active, .slide-right-leave-active { transition: transform 0.3s ease; }
.slide-right-enter-from, .slide-right-leave-to { transform: translateX(100%); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

:deep(.el-slider__runway) { background: rgba(0,0,0,0.1); }
.play-mode :deep(.el-slider__runway) { background: rgba(255,255,255,0.2); }
.play-mode :deep(.el-slider__bar) { background: #c35f33; }
.play-mode :deep(.el-button) {
  border-color: rgba(255,255,255,0.55);
  color: #fff;
  background: rgba(255,255,255,0.08);
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  &:hover { border-color: rgba(255,255,255,0.85); background: rgba(255,255,255,0.16); }
}
.play-mode :deep(.el-button--primary) { background: #c35f33; border-color: #c35f33; box-shadow: 0 4px 16px rgba(195,95,51,0.5); }

/* ===== Heart favorite button ===== */
.fav-btn { display: inline-flex; align-items: center; justify-content: center; }
.fav-btn .heart-icon { color: #909399; }
.fav-btn .heart-icon .heart-fill { color: #e94560; }
.play-mode .fav-btn { border-color: rgba(255,255,255,0.55); background: rgba(255,255,255,0.08); }
.play-mode .fav-btn .heart-icon { color: rgba(255,255,255,0.85); }
.play-mode .fav-btn .heart-icon .heart-fill { color: #e94560; }

/* ===== Add-to-playlist dialog ===== */
.playlist-dialog-song { font-size: 13px; color: #666; margin-bottom: 12px; }
.playlist-list { max-height: 320px; overflow-y: auto; }
.playlist-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; cursor: pointer; transition: background 0.2s;
  &:hover { background: #f5f7fa; }
  .pl-icon { font-size: 18px; color: #909399; }
  .pl-info { flex: 1; .pl-name { font-size: 14px; font-weight: 500; } .pl-meta { font-size: 12px; color: #999; } }
}
.create-playlist-row { display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #f0f0f0; }
.empty-tip { text-align: center; color: #999; font-size: 13px; padding: 20px 0; }

/* ===== DLNA cast ===== */
.dlna-status-bar {
  position: fixed; bottom: var(--player-height); left: var(--sidebar-width); right: 0;
  height: 36px; background: #f0f7ff; border-top: 1px solid #d6e8ff;
  display: flex; align-items: center; gap: 8px; padding: 0 20px; z-index: 99;
  font-size: 13px; color: #409eff;
  .dlna-status-label { display: flex; align-items: center; gap: 4px; font-weight: 500; margin-right: auto; }
  .dlna-volume { width: 80px; }
}
.dlna-dialog-song { font-size: 13px; color: #666; margin-bottom: 12px; }
.dlna-current-tip { color: #999; font-size: 12px; margin-left: auto; }
</style>
