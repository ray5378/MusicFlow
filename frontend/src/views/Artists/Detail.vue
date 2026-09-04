<template>
  <div class="artist-detail" v-loading="loading">
    <div class="artist-header" v-if="artist">
      <div class="artist-avatar">
        <img v-if="artist.coverArt" :src="coverUrl(artist.coverArt, 300)" loading="lazy" decoding="async" />
        <div v-else class="avatar-placeholder"><MfIcon name="User" :size="64"  /></div>
      </div>
      <div class="artist-meta">
        <div class="label">{{ t('artists.label') }}</div>
        <h1>{{ artist.name }}</h1>
        <div class="info">{{ formatAlbumCount(artist.albumCount) }}</div>
        <div class="actions">
          <el-button type="primary" @click="playAllSongs">{{ t('artists.playAllSongs') }}</el-button>
          <el-button
            class="detail-fav-btn"
            :class="{ active: fav.isArtistFavorite(artist.id) }"
            @click="toggleArtistFav"
          >
            <MfIcon name="Heart" :filled="fav.isArtistFavorite(artist.id)" :size="15" />
            {{ fav.isArtistFavorite(artist.id) ? t('artists.favorited') : t('artists.favorite') }}
          </el-button>
        </div>
      </div>
    </div>
    <h3>{{ t('artists.albums') }}</h3>
    <div class="album-grid">
      <div
        class="album-card fnos-card-sheen"
        v-for="(album, idx) in albums"
        :key="album.id"
        :style="{ '--stagger': idx }"
        @contextmenu="openContextMenu($event, albumActions(album), album.name, albumMeta(album))"
        v-longpress="() => openActionSheet(albumActions(album), album.name, albumMeta(album))"
      >
        <div class="album-cover mf-coverwrap" @click="open(album)">
          <img v-if="album.coverArt" :src="coverUrl(album.coverArt, 300)" loading="lazy" decoding="async" />
          <div v-else class="cover-placeholder"><MfIcon name="Disc3" :size="32"  /></div>
          <CoverPlay size="md" :label="t('albums.play', { name: album.name })" :action="() => playAl(album)" />
          <button
            class="card-fav-btn"
            :class="{ active: fav.isAlbumFavorite(album.id) }"
            :title="fav.isAlbumFavorite(album.id) ? t('albums.unfavorite') : t('albums.favorite')"
            @click.stop="toggleAlbumFav(album)"
          >
            <MfIcon name="Heart" :filled="fav.isAlbumFavorite(album.id)" :size="16" />
          </button>
        </div>
        <div class="album-info" @click="open(album)">
          <div class="album-name">{{ album.name }}</div>
          <div class="album-meta">{{ album.year || '' }} · {{ t('artists.songCount', { count: album.songCount }) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { usePlayerStore } from "@/stores/player";
import { ElMessage } from "element-plus";
import CoverPlay from "@/components/CoverPlay.vue";
import { useItemActions } from "@/composables/useItemActions";
import { usePlayContent } from "@/composables/usePlayContent";
import { useFavoritesStore } from "@/stores/favorites";
import api from "@/api";
import { coverUrl } from "@/utils/cover";

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const playerStore = usePlayerStore();
const { openContextMenu, openActionSheet, menuGuard, albumActions } = useItemActions();
const play = usePlayContent();
const fav = useFavoritesStore();
const artist = ref<any>(null);
const albums = ref<any[]>([]);
const loading = ref(false);

function open(album: any) {
  if (menuGuard()) return;
  router.push(`/albums/${album.id}`);
}
function albumMeta(album: any) {
  return [album.year, album.songCount ? t('artists.songCount', { count: album.songCount }) : ""].filter(Boolean).join(" · ");
}
async function playAl(album: any) {
  if (menuGuard()) return;
  const n = await play.playAlbum(album.id);
  if (n) ElMessage.success(t('albums.playing', { name: album.name }));
  else ElMessage.warning(t('albums.noPlayable'));
}
async function toggleAlbumFav(album: any) {
  if (menuGuard()) return;
  try {
    const on = await fav.toggleAlbumFavorite(album.id);
    ElMessage.success(on ? t('albums.favorited') : t('albums.unfavorited'));
  } catch {
    ElMessage.error(t('common.operationFailed'));
  }
}
async function toggleArtistFav() {
  if (!artist.value) return;
  try {
    const on = await fav.toggleArtistFavorite(artist.value.id);
    ElMessage.success(on ? t('artists.favorited') : t('artists.unfavorited'));
  } catch {
    ElMessage.error(t('common.operationFailed'));
  }
}

async function loadArtist() {
  loading.value = true;
  try {
    const res = await api.get(`/rest/getArtist?id=${route.params.id}&f=json`);
    const data = res.data["subsonic-response"]?.artist;
    artist.value = data;
    albums.value = data?.album || [];
  } catch {}
  finally { loading.value = false; }
}

async function playAllSongs() {
  const allSongs: any[] = [];
  for (const album of albums.value) {
    const res = await api.get(`/rest/getAlbum?id=${album.id}&f=json`);
    const songs = res.data["subsonic-response"]?.album?.song || [];
    allSongs.push(...songs);
  }
  if (allSongs.length > 0) playerStore.playQueue(allSongs);
}

function formatAlbumCount(n: number) {
  if (!n || n <= 0) return '';
  if (n === 1) return t('artists.albumCountOne');
  return t('artists.albumCount', { count: n });
}

onMounted(loadArtist);
</script>

<style lang="scss" scoped>
.artist-detail { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.artist-header { display: flex; gap: 24px; margin-bottom: 32px;
  .artist-avatar { width: 180px; height: 180px; border-radius: 50%; overflow: hidden; flex-shrink: 0; box-shadow: 0 8px 28px rgba(0,0,0,0.4);
    img { width: 100%; height: 100%; object-fit: cover; }
    .avatar-placeholder { width: 100%; height: 100%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); border-radius: 50%; }
  }
  .artist-meta { display: flex; flex-direction: column; justify-content: center;
    .label { font-size: 12px; color: var(--fnos-text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; }
    h1 { font-size: 28px; font-weight: 700; margin: 8px 0; color: var(--fnos-text-primary); }
    .info { color: var(--fnos-text-tertiary); font-size: 14px; }
    .actions { margin-top: 16px; display: flex; gap: 10px; flex-wrap: wrap; }
    .actions .detail-fav-btn { display: inline-flex; align-items: center; gap: 6px; }
    .actions .detail-fav-btn.active { color: var(--fnos-red); border-color: var(--fnos-red-ring); }
    .actions .detail-fav-btn.active .mf-icon { color: var(--fnos-red); }
  }
}
h3 { margin-bottom: 16px; color: var(--fnos-text-primary); font-size: 20px; font-weight: 600; }
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; }
.album-card {
  cursor: pointer; border-radius: var(--fnos-radius-lg); overflow: hidden;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
  transition: transform 0.22s ease, background 0.22s ease, box-shadow 0.22s ease;
  animation: home-card-in 0.45s ease backwards;  /* backwards: 动画结束后回退到元素常态（无 transform 残留），both 会保持 translateY(0) 终态形成永久 stacking context，旧 Chromium 上可能穿透 fixed 弹窗 */
  animation-delay: min(calc(var(--stagger, 0) * 0.03s), 0.6s);
  &:hover { transform: translateY(-5px); background: rgba(255,255,255,0.08); box-shadow: 0 14px 34px rgba(0,0,0,0.4); }
  &:active { transform: translateY(-2px) scale(0.98); }
  .album-cover { aspect-ratio: 1; overflow: hidden; position: relative;
    img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.45s ease; }
    .cover-placeholder { width: 100%; height: 100%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); }
  }
  &:hover .album-cover img { transform: scale(1.05); }
  .album-info { padding: 12px 14px 14px;
    .album-name { font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fnos-text-primary); }
    .album-meta { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 4px; }
  }
}
@keyframes home-card-in {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}

@media (max-width: 768px) {
  .artist-detail { padding: 20px 16px; }
  .artist-header { flex-direction: column; align-items: center; text-align: center; gap: 16px; }
  .artist-header .artist-avatar { width: 120px; height: 120px; }
  .album-grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .album-card .album-info { padding: 10px 10px 12px; }
  .album-card .album-info .album-name { font-size: 13px; }
  /* 移动端只保留专辑名，年份/曲目数收进长按面板 */
  .album-card .album-info .album-meta { display: none; }
}
</style>
