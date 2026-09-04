<template>
  <div class="favorites-page">
    <div class="fav-header">
      <div class="fav-cover">
        <MfIcon name="Heart" :filled="true" :size="64" class="fav-heart" />
      </div>
      <div class="fav-meta">
        <div class="label">{{ t('favorites.title') }}</div>
        <h1>{{ t('favorites.title') }}</h1>
        <div class="info">{{ t('favorites.info', { count: total }) }}</div>
        <div class="actions">
          <el-button type="primary" @click="playAll" :disabled="total === 0">{{ t('favorites.playAll') }}</el-button>
          <el-button @click="togglePool"><MfIcon name="Wand2" />{{ inPool ? t('favorites.removeFromPool') : t('favorites.addToPool') }}</el-button>
        </div>
      </div>
    </div>

    <!-- 收藏分区:歌曲 / 专辑 / 歌手,同一页切换显示 -->
    <div class="fav-tabs" role="tablist">
      <button
        v-for="tb in tabs"
        :key="tb.key"
        class="fav-tab"
        :class="{ active: tab === tb.key }"
        role="tab"
        :aria-selected="tab === tb.key"
        @click="switchTab(tb.key)"
      >
        {{ tb.label }}<span class="count">{{ tb.count }}</span>
      </button>
    </div>

    <!-- ===== 歌单收藏(默认分区) ===== -->
    <div v-show="tab === 'playlist'" class="fav-pane">
      <EmptyState v-if="!loadingPlaylists && playlistTotal === 0" icon="List" :title="t('favorites.emptyPlaylistTitle')" :description="t('favorites.emptyPlaylistDesc')" compact />
      <div v-else class="playlist-grid virt-grid" ref="playlistGridEl" v-loading="loadingPlaylists" :style="{ height: playlistFrameHeight }">
        <template v-for="g in playlistViews" :key="g.item ? g.item.id : 'ph-' + g.idx">
          <div
            v-if="g.item"
            class="playlist-card"
            :style="playlistCardStyle(g.idx)"
            @contextmenu="openContextMenu($event, plActions(g.item), g.item.name, playlistMeta(g.item))"
            v-longpress="() => openActionSheet(plActions(g.item), g.item.name, playlistMeta(g.item))"
          >
            <div class="playlist-cover mf-coverwrap" @click="openPl(g.item)">
              <img v-if="g.item.coverArt" :src="coverUrl(g.item.coverArt)" loading="lazy" decoding="async" />
              <div v-else class="cover-placeholder"><MfIcon name="List" :size="48" /></div>
              <CoverPlay size="md" :label="t('favorites.play', { name: g.item.name })" :action="() => playPl(g.item)" />
              <button
                class="card-fav-btn active"
                :title="t('favorites.unfavPlaylist')"
                @click.stop="togglePlFav(g.item)"
              >
                <MfIcon name="Heart" :filled="true" :size="16" />
              </button>
            </div>
            <div class="playlist-info" @click="openPl(g.item)">
              <div class="playlist-name">{{ g.item.name }}</div>
              <div class="playlist-meta">{{ playlistMeta(g.item) }}</div>
            </div>
          </div>
          <div v-else class="playlist-card is-placeholder" :style="playlistCardStyle(g.idx)">
            <div class="playlist-cover ph-cover"></div>
            <div class="playlist-placeholder"><span class="ph-bar"></span><span class="ph-bar short"></span></div>
          </div>
        </template>
      </div>
    </div>

    <!-- ===== 歌曲收藏 ===== -->
    <div v-show="tab === 'song'" class="fav-pane">
      <SongTable :songs="songs" :loading="loading" show-source show-bitrate :on-window="onWindow" @play="playSong" />
      <EmptyState v-if="!loading && total === 0" icon="Heart" :title="t('favorites.emptySongsTitle')" :description="t('favorites.emptySongsDesc')" compact />
    </div>

    <!-- ===== 专辑收藏 ===== -->
    <div v-show="tab === 'album'" class="fav-pane">
      <EmptyState v-if="!loadingAlbums && albumTotal === 0" icon="Disc3" :title="t('favorites.emptyAlbumTitle')" :description="t('favorites.emptyAlbumDesc')" compact />
      <div v-else class="album-grid virt-grid" ref="albumGridEl" v-loading="loadingAlbums" :style="{ height: albumFrameHeight }">
        <template v-for="g in albumViews" :key="g.item ? g.item.id : 'ph-' + g.idx">
          <div
            v-if="g.item"
            class="album-card"
            :style="albumCardStyle(g.idx)"
            @contextmenu="openContextMenu($event, albumActions(g.item), g.item.name, albumMeta(g.item))"
            v-longpress="() => openActionSheet(albumActions(g.item), g.item.name, albumMeta(g.item))"
          >
            <div class="album-cover mf-coverwrap" @click="openAlbum(g.item)">
              <img v-if="g.item.coverArt" :src="coverUrl(g.item.coverArt)" loading="lazy" decoding="async" />
              <div v-else class="cover-placeholder"><MfIcon name="Disc3" :size="48" /></div>
              <CoverPlay size="md" :label="t('favorites.play', { name: g.item.name })" :action="() => playAl(g.item)" />
              <button
                class="card-fav-btn"
                :class="{ active: fav.isAlbumFavorite(g.item.id) }"
                :title="fav.isAlbumFavorite(g.item.id) ? t('favorites.unfavAlbum') : t('favorites.favAlbum')"
                @click.stop="toggleAlbumFav(g.item)"
              >
                <MfIcon name="Heart" :filled="fav.isAlbumFavorite(g.item.id)" :size="16" />
              </button>
            </div>
            <div class="album-info" @click="openAlbum(g.item)">
              <div class="album-name">{{ g.item.name }}</div>
              <div class="album-artist">{{ g.item.artist }}</div>
              <div class="album-meta">{{ g.item.year || '' }} {{ t('favorites.songsCount', { count: g.item.songCount }) }}</div>
            </div>
          </div>
          <div v-else class="album-card is-placeholder" :style="albumCardStyle(g.idx)">
            <div class="album-cover ph-cover"></div>
            <div class="album-placeholder"><span class="ph-bar"></span><span class="ph-bar short"></span></div>
          </div>
        </template>
      </div>
    </div>

    <!-- ===== 歌手收藏 ===== -->
    <div v-show="tab === 'artist'" class="fav-pane">
      <EmptyState v-if="!loadingArtists && artistTotal === 0" icon="User" :title="t('favorites.emptyArtistTitle')" :description="t('favorites.emptyArtistDesc')" compact />
      <div v-else class="artist-grid virt-grid" ref="artistGridEl" v-loading="loadingArtists" :style="{ height: artistFrameHeight }">
        <template v-for="g in artistViews" :key="g.item ? g.item.id : 'ph-' + g.idx">
          <div
            v-if="g.item"
            class="artist-card"
            :style="artistCardStyle(g.idx)"
            @contextmenu="openContextMenu($event, artistActions(g.item), g.item.name, formatAlbumCount(g.item.albumCount))"
            v-longpress="() => openActionSheet(artistActions(g.item), g.item.name, formatAlbumCount(g.item.albumCount))"
          >
            <div class="artist-avatar mf-coverwrap" @click="openArtist(g.item)">
              <img v-if="g.item.coverArt" :src="coverUrl(g.item.coverArt)" loading="lazy" decoding="async" />
              <div v-else class="avatar-placeholder"><MfIcon name="User" :size="48" /></div>
              <CoverPlay size="md" :label="t('favorites.playArtist', { name: g.item.name })" :action="() => playAr(g.item)" />
              <button
                class="card-fav-btn"
                :class="{ active: fav.isArtistFavorite(g.item.id) }"
                :title="fav.isArtistFavorite(g.item.id) ? t('favorites.unfavArtist') : t('favorites.favArtist')"
                @click.stop="toggleArtistFav(g.item)"
              >
                <MfIcon name="Heart" :filled="fav.isArtistFavorite(g.item.id)" :size="16" />
              </button>
            </div>
            <div class="artist-name" @click="openArtist(g.item)">{{ g.item.name }}</div>
            <div class="artist-meta" @click="openArtist(g.item)">{{ formatAlbumCount(g.item.albumCount) }}</div>
          </div>
          <div v-else class="artist-card is-placeholder" :style="artistCardStyle(g.idx)">
            <div class="artist-avatar ph-avatar"></div>
            <div class="artist-name ph-bar"></div>
            <div class="artist-meta ph-bar short"></div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { usePlayerStore } from "@/stores/player";
import { useFavoritesStore } from "@/stores/favorites";
import { useItemActions, MenuAction } from "@/composables/useItemActions";
import { Play, Folder, Heart } from "lucide-vue-next";
import { usePlayContent } from "@/composables/usePlayContent";
import { useCardGrid } from "@/composables/useCardGrid";
import { ElMessage } from "element-plus";
import api from "@/api";
import SongTable from "@/components/SongTable.vue";
import EmptyState from "@/components/EmptyState.vue";
import CoverPlay from "@/components/CoverPlay.vue";
import { useInfiniteList } from "@/composables/useInfiniteList";
import { coverUrl } from "@/utils/cover";

const router = useRouter();
const playerStore = usePlayerStore();
const { t } = useI18n();
const { openContextMenu, openActionSheet, menuGuard, albumActions, artistActions } = useItemActions();
const play = usePlayContent();
const fav = useFavoritesStore();

// ===== 分区 =====
type FavTab = "playlist" | "song" | "album" | "artist";
const tab = ref<FavTab>("playlist");
const tabs = computed(() => [
  { key: "playlist" as FavTab, label: t("favorites.tab.playlist"), count: playlistTotal.value },
  { key: "song" as FavTab, label: t("favorites.tab.song"), count: total.value },
  { key: "album" as FavTab, label: t("favorites.tab.album"), count: albumTotal.value },
  { key: "artist" as FavTab, label: t("favorites.tab.artist"), count: artistTotal.value },
]);
function switchTab(key: FavTab) {
  if (tab.value === key) return;
  tab.value = key;
  // 切回某个分区后,其窗口化渲染需按当前视口重算(display:none 期间不触发滚动/布局)
  nextTick(() => {
    if (key === "song") window.dispatchEvent(new Event("resize"));
    else if (key === "album") albumGrid.recomputeGrid();
    else if (key === "artist") artistGrid.recomputeGrid();
    else if (key === "playlist") playlistGrid.recomputeGrid();
  });
}

// ===== 歌单收藏:窗口化分块加载(默认分区) =====
const playlistGrid = useCardGrid<any>(
  async (offset, size) => {
    const page = Math.floor(offset / size) + 1;
    const res = await api.get("/rest/api/v1/playlists", {
      params: { page, pageSize: size, favorite: "1" },
    });
    const items = res.data.items || [];
    return { items, total: res.data.total || 0 };
  },
  { chunk: 60, keepRows: 120, prefetchBlocks: 2, concurrency: 3, minTileWidth: 200, gap: 18, coverRatio: 1, rowFooter: 76 }
);
const playlistGridEl = playlistGrid.gridEl;
const loadingPlaylists = playlistGrid.loading;
const playlistTotal = playlistGrid.total;
const playlistFrameHeight = playlistGrid.frameHeight;
const playlistCardStyle = playlistGrid.cardStyle;
const playlistViews = computed(() => {
  const start = playlistGrid.startIndex.value;
  const end = playlistGrid.endIndex.value;
  const arr: { idx: number; item: any }[] = [];
  for (let i = Math.max(0, start); i < end; i++) arr.push({ idx: i, item: playlistGrid.list.value[i] });
  return arr;
});

// ===== 歌曲收藏:窗口化分块加载 =====
const { list: songs, loading, total, reload: loadFavorites, onWindow } = useInfiniteList<any>(
  async (offset, size) => {
    const res = await api.get("/rest/getStarred2", { params: { offset, size } });
    const starred2 = res.data["subsonic-response"]?.starred2;
    return { items: starred2?.song || [], total: starred2?.songTotal || 0 };
  },
  { chunk: 200, keepRows: 300, prefetchBlocks: 2, concurrency: 3 }
);

// ===== 专辑收藏 =====
const albumGrid = useCardGrid<any>(
  async (offset, size) => {
    const res = await api.get("/rest/getStarred2", { params: { offset, size } });
    const starred2 = res.data["subsonic-response"]?.starred2;
    return { items: starred2?.album || [], total: starred2?.albumTotal || 0 };
  },
  { chunk: 60, keepRows: 120, prefetchBlocks: 2, concurrency: 3, minTileWidth: 180, gap: 20, coverRatio: 1, rowFooter: 80 }
);
const albumGridEl = albumGrid.gridEl;
const loadingAlbums = albumGrid.loading;
const albumTotal = albumGrid.total;
const albumFrameHeight = albumGrid.frameHeight;
const albumCardStyle = albumGrid.cardStyle;
const albumViews = computed(() => {
  const start = albumGrid.startIndex.value;
  const end = albumGrid.endIndex.value;
  const arr: { idx: number; item: any }[] = [];
  for (let i = Math.max(0, start); i < end; i++) arr.push({ idx: i, item: albumGrid.list.value[i] });
  return arr;
});

// ===== 歌手收藏 =====
const artistGrid = useCardGrid<any>(
  async (offset, size) => {
    const res = await api.get("/rest/getStarred2", { params: { offset, size } });
    const starred2 = res.data["subsonic-response"]?.starred2;
    return { items: starred2?.artist || [], total: starred2?.artistTotal || 0 };
  },
  { chunk: 60, keepRows: 120, prefetchBlocks: 2, concurrency: 3, minTileWidth: 160, gap: 18, rowHeight: 212 }
);
const artistGridEl = artistGrid.gridEl;
const loadingArtists = artistGrid.loading;
const artistTotal = artistGrid.total;
const artistFrameHeight = artistGrid.frameHeight;
const artistCardStyle = artistGrid.cardStyle;
const artistViews = computed(() => {
  const start = artistGrid.startIndex.value;
  const end = artistGrid.endIndex.value;
  const arr: { idx: number; item: any }[] = [];
  for (let i = Math.max(0, start); i < end; i++) arr.push({ idx: i, item: artistGrid.list.value[i] });
  return arr;
});

// ===== 操作 =====
const inPool = ref(false);

async function loadPoolStatus() {
  try {
    const res = await api.get("/rest/api/v1/recommend-pool/favorites/status");
    inPool.value = !!res.data.inPool;
  } catch { inPool.value = false; }
}

async function togglePool() {
  try {
    if (inPool.value) {
      await api.delete("/rest/api/v1/recommend-pool/favorites");
      inPool.value = false;
      ElMessage.success(t("favorites.poolRemoved"));
    } else {
      const res = await api.post("/rest/api/v1/recommend-pool/favorites");
      inPool.value = true;
      ElMessage.success(res.data.message || t("favorites.poolAdded"));
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("common.operationFailed"));
  }
}

function playSong(song: any) { playerStore.playSong(song); }
function playAll() { const all = songs.value.filter(Boolean); if (all.length > 0) playerStore.playQueue(all); }

function openAlbum(album: any) {
  if (menuGuard()) return;
  router.push(`/albums/${album.id}`);
}
function openArtist(artist: any) {
  if (menuGuard()) return;
  router.push(`/artists/${artist.id}`);
}
function albumMeta(album: any) {
  return [album.artist, album.year, album.songCount ? t("favorites.songsCount", { count: album.songCount }) : ""].filter(Boolean).join(" · ");
}
function formatAlbumCount(n: number) {
  if (!n || n <= 0) return '';
  return t("favorites.albumBanner", { count: n });
}
async function playAl(album: any) {
  if (menuGuard()) return;
  const n = await play.playAlbum(album.id);
  if (n) ElMessage.success(t("favorites.playing", { name: album.name }));
  else ElMessage.warning(t("favorites.albumNoPlayable"));
}
async function playAr(artist: any) {
  if (menuGuard()) return;
  const n = await play.playArtist(artist.id);
  if (n) ElMessage.success(t("favorites.playingArtist", { name: artist.name, count: n }));
  else ElMessage.warning(t("favorites.artistNoPlayable"));
}
async function toggleAlbumFav(album: any) {
  if (menuGuard()) return;
  try {
    const on = await fav.toggleAlbumFavorite(album.id);
    ElMessage.success(on ? t("favorites.albumFaved") : t("favorites.albumUnfaved"));
  } catch {
    ElMessage.error(t("common.operationFailed"));
  }
}
async function toggleArtistFav(artist: any) {
  if (menuGuard()) return;
  try {
    const on = await fav.toggleArtistFavorite(artist.id);
    ElMessage.success(on ? t("favorites.artistFaved") : t("favorites.artistUnfaved"));
  } catch {
    ElMessage.error(t("common.operationFailed"));
  }
}

// ===== 歌单收藏操作 =====
function formatDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return m > 0 ? t("favorites.duration.hm", { h, m }) : t("favorites.duration.h", { h });
  return t("favorites.duration.m", { m });
}
function playlistMeta(pl: any) {
  return `${t("favorites.songsCount", { count: pl.songCount })} · ${formatDuration(pl.duration)}`;
}
function openPl(pl: any) {
  if (menuGuard()) return;
  router.push(`/playlists/${pl.id}`);
}
async function playPl(pl: any) {
  if (menuGuard()) return;
  const n = await play.playPlaylist(pl.id);
  if (n) ElMessage.success(t("favorites.playing", { name: pl.name }));
  else ElMessage.warning(t("favorites.playlistNoPlayable"));
}
async function togglePlFav(pl: any) {
  if (menuGuard()) return;
  try {
    const res = await api.post(`/rest/api/v1/playlists/${pl.id}/favorite`, { favorite: false });
    if (res.data.success) {
      ElMessage.success(t("favorites.unfavorited", { name: pl.name }));
      playlistGrid.reload();
    }
  } catch {
    ElMessage.error(t("common.operationFailed"));
  }
}
function plActions(pl: any): MenuAction[] {
  return [
    { label: t("favorites.playAll"), icon: Play, onClick: () => playPl(pl) },
    { label: t("favorites.viewPlaylist"), icon: Folder, onClick: () => openPl(pl) },
    { divider: true },
    { label: t("favorites.unfavorite"), icon: Heart, onClick: () => togglePlFav(pl) },
  ];
}

function loadAll() {
  playlistGrid.reload();
  loadFavorites();
  albumGrid.reload();
  artistGrid.reload();
}

onMounted(() => {
  loadAll();
  fav.loadFavorites();
  loadPoolStatus();
  nextTick(() => {
    playlistGrid.bindGrid();
    albumGrid.bindGrid();
    artistGrid.bindGrid();
    // 默认歌单分区(其窗口化渲染在挂载时自绑定)
  });
  window.addEventListener("mf:song-deleted", onSongDeleted);
});
// 收藏状态在任何页面发生变化(点击我喜欢/取消收藏)后,列表实时重载。
watch(() => fav.revision, () => {
  loadAll();
  fav.loadFavorites();
});
// 右键「从音乐库删除」成功后刷新(收藏里的 web 歌曲被级联清除)
function onSongDeleted() {
  loadAll();
  fav.loadFavorites();
}
onBeforeUnmount(() => window.removeEventListener("mf:song-deleted", onSongDeleted));
</script>

<style lang="scss" scoped>
.favorites-page { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.fav-header { display: flex; gap: 24px; margin-bottom: 24px;
  .fav-cover { width: 200px; height: 200px; border-radius: var(--fnos-radius-lg); background: linear-gradient(135deg, #f5b942, #e94560); display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0; box-shadow: 0 10px 30px rgba(233,69,96,0.35);
    .fav-heart { color: #fff; } }
  .fav-meta { display: flex; flex-direction: column; justify-content: center;
    .label { font-size: 12px; color: var(--fnos-text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; }
    h1 { font-size: 28px; font-weight: 700; margin: 8px 0; color: var(--fnos-text-primary); }
    .info { color: var(--fnos-text-tertiary); font-size: 14px; }
    .actions { margin-top: 16px; }
  }
}

/* ===== 分区切换 ===== */
.fav-tabs { display: flex; gap: 6px; margin-bottom: 20px; padding: 4px; border-radius: 12px; background: rgba(255,255,255,0.05); width: fit-content;
  .fav-tab {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 20px; border: none; border-radius: 9px;
    background: transparent; color: var(--fnos-text-secondary);
    font-size: 14px; font-weight: 500; cursor: pointer;
    transition: background 0.18s ease, color 0.18s ease;
    .count { font-size: 12px; color: var(--fnos-text-muted); }
    &:hover { background: rgba(255,255,255,0.06); color: var(--fnos-text-primary); }
    &.active { background: var(--fnos-red); color: #fff;
      .count { color: rgba(255,255,255,0.85); }
    }
  }
}

.fav-pane { min-height: 120px; }

/* ===== 专辑网格 ===== */
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; }
.album-grid.virt-grid { display: block; position: relative; width: 100%; }
.album-grid.virt-grid .album-card { box-sizing: border-box; }
.album-card {
  cursor: pointer; border-radius: var(--fnos-radius-lg); overflow: hidden;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
  transition: transform 0.22s ease, background 0.22s ease, box-shadow 0.22s ease;
  &:hover { transform: translateY(-5px); background: rgba(255,255,255,0.08); box-shadow: 0 14px 34px rgba(0,0,0,0.4); }
  &:active { transform: translateY(-2px) scale(0.98); }
  .album-cover { aspect-ratio: 1; overflow: hidden; position: relative;
    img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.45s ease; }
    .cover-placeholder { width: 100%; height: 100%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); }
  }
  &:hover .album-cover img { transform: scale(1.05); }
  .album-info { padding: 12px 14px 14px;
    .album-name { font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fnos-text-primary); transition: color 0.18s ease; }
    .album-artist { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .album-meta { font-size: 11px; color: var(--fnos-text-muted); margin-top: 2px; }
  }
  &.is-placeholder { cursor: default;
    .ph-cover { width: 100%; aspect-ratio: 1; background: linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.1) 37%, rgba(255,255,255,0.05) 63%); background-size: 400% 100%; animation: mf-ph 1.2s ease-in-out infinite; }
    .album-placeholder { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 8px;
      .ph-bar { height: 12px; width: 60%; border-radius: 6px; background: rgba(255,255,255,0.08); &.short { width: 40%; } }
    }
  }
}

/* ===== 歌手网格 ===== */
.artist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 18px; }
.artist-grid.virt-grid { display: block; position: relative; width: 100%; }
.artist-grid.virt-grid .artist-card { box-sizing: border-box; }
.artist-card {
  cursor: pointer; text-align: center; padding: 16px 12px;
  border-radius: var(--fnos-radius-lg);
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
  transition: transform 0.22s ease, background 0.22s ease, box-shadow 0.22s ease;
  &:hover { transform: translateY(-5px); background: rgba(255,255,255,0.08); box-shadow: 0 14px 34px rgba(0,0,0,0.4); }
  &:active { transform: translateY(-2px) scale(0.98); }
  .artist-avatar { position: relative; width: 120px; height: 120px; border-radius: 50%; overflow: hidden; margin: 0 auto 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.45s ease; }
    .avatar-placeholder { width: 100%; height: 100%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); border-radius: 50%; }
  }
  &:hover .artist-avatar img { transform: scale(1.06); }
  .artist-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fnos-text-primary); transition: color 0.18s ease; }
  .artist-name:hover { color: var(--fnos-red); }
  .artist-meta { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 5px; min-height: 16px; }
  &.is-placeholder { cursor: default;
    .ph-avatar { width: 120px; height: 120px; border-radius: 50%; margin: 0 auto 12px; background: linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.1) 37%, rgba(255,255,255,0.05) 63%); background-size: 400% 100%; animation: mf-ph 1.2s ease-in-out infinite; }
    .ph-bar { display: block; height: 12px; margin: 5px auto 0; width: 55%; border-radius: 6px; background: rgba(255,255,255,0.08); &.short { width: 40%; } }
  }
}

/* ===== 歌单网格 ===== */
.playlist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 18px; }
.playlist-grid.virt-grid { display: block; position: relative; width: 100%; }
.playlist-grid.virt-grid .playlist-card { box-sizing: border-box; }
.playlist-card {
  cursor: pointer; border-radius: var(--fnos-radius-lg); overflow: hidden;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
  transition: transform 0.22s ease, background 0.22s ease, box-shadow 0.22s ease;
  &:hover { transform: translateY(-5px); background: rgba(255,255,255,0.08); box-shadow: 0 14px 34px rgba(0,0,0,0.4); }
  &:active { transform: translateY(-2px) scale(0.98); }
  .playlist-cover { aspect-ratio: 1; overflow: hidden; position: relative;
    img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.45s ease; }
    .cover-placeholder { width: 100%; height: 100%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); }
  }
  &:hover .playlist-cover img { transform: scale(1.05); }
  .playlist-info { padding: 12px 14px 14px;
    .playlist-name { font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fnos-text-primary); transition: color 0.18s ease; }
    .playlist-meta { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  }
  &.is-placeholder { cursor: default;
    .ph-cover { width: 100%; aspect-ratio: 1; background: linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.1) 37%, rgba(255,255,255,0.05) 63%); background-size: 400% 100%; animation: mf-ph 1.2s ease-in-out infinite; }
    .playlist-placeholder { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 8px;
      .ph-bar { height: 12px; width: 60%; border-radius: 6px; background: rgba(255,255,255,0.08); &.short { width: 40%; } }
    }
  }
}

@keyframes mf-ph { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

@media (max-width: 768px) {
  .favorites-page { padding: 20px 16px; }
  .fav-header { flex-direction: column; align-items: center; text-align: center; gap: 16px;
    .fav-cover { width: 160px; height: 160px; }
    .fav-meta .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
  }
  .fav-tabs { width: 100%; justify-content: center; }
  .fav-tabs .fav-tab { flex: 1; justify-content: center; padding: 8px 10px; }
  .album-grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .artist-grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .playlist-grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .album-card .album-info { padding: 10px 10px 12px; }
  .album-card .album-info .album-name { font-size: 13px; }
  .album-card .album-info .album-meta { display: none; }
  .artist-card { padding: 12px 8px; }
  .artist-card .artist-avatar { width: 100%; max-width: 160px; aspect-ratio: 1; height: auto; }
  .artist-card .artist-name { font-size: 13px; }
}
</style>
