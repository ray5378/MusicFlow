<template>
  <div class="album-detail" v-loading="loading">
    <div class="album-header" v-if="album">
      <div class="album-cover">
        <img v-if="album.coverArt" :src="coverUrl(album.coverArt, 300)" loading="lazy" decoding="async" />
        <div v-else class="cover-placeholder"><MfIcon name="Disc3" :size="64"  /></div>
      </div>
      <div class="album-meta">
        <div class="label">{{ t('albums.label') }}</div>
        <h1>{{ album.name }}</h1>
        <div class="artist" v-if="album.artist" @click="router.push(`/artists/${album.artistId}`)">{{ album.artist }}</div>
        <div class="info">{{ album.year || '' }} · {{ t('albums.songCount', { count: album.songCount }) }} · {{ formatDuration(album.duration) }}</div>
        <div class="actions">
          <el-button type="primary" @click="playAll">{{ t('albums.playAll') }}</el-button>
          <el-button
            class="detail-fav-btn"
            :class="{ active: fav.isAlbumFavorite(album.id) }"
            @click="toggleAlbumFav"
          >
            <MfIcon name="Heart" :filled="fav.isAlbumFavorite(album.id)" :size="15" />
            {{ fav.isAlbumFavorite(album.id) ? t('albums.favorited') : t('albums.favorite') }}
          </el-button>
        </div>
      </div>
    </div>
    <SongTable v-if="songs.length > 0" :songs="songs" :show-artist="false" show-bitrate @play="playSong" />
    <EmptyState v-else icon="headphones" :title="t('albums.emptyTitle')" :description="t('albums.emptyDesc')" compact />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { usePlayerStore, Song } from "@/stores/player";
import EmptyState from "@/components/EmptyState.vue";
import { useFavoritesStore } from "@/stores/favorites";
import { ElMessage } from "element-plus";
import api from "@/api";
import SongTable from "@/components/SongTable.vue";
import { coverUrl } from "@/utils/cover";

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const playerStore = usePlayerStore();
const fav = useFavoritesStore();
const album = ref<any>(null);
const songs = ref<Song[]>([]);
const loading = ref(false);

function formatDuration(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${s.toString().padStart(2, "0")}`; }
function playSong(song: Song) { playerStore.playSong(song); }
function playAll() { if (songs.value.length > 0) playerStore.playQueue(songs.value); }
async function toggleAlbumFav() {
  if (!album.value) return;
  try {
    const on = await fav.toggleAlbumFavorite(album.value.id);
    ElMessage.success(on ? t('albums.favorited') : t('albums.unfavorited'));
  } catch {
    ElMessage.error(t('common.operationFailed'));
  }
}

async function loadAlbum() {
  loading.value = true;
  try {
    const res = await api.get(`/rest/getAlbum?id=${route.params.id}&f=json`);
    const data = res.data["subsonic-response"]?.album;
    album.value = data;
    songs.value = data?.song || [];
  } catch {}
  finally { loading.value = false; }
}

onMounted(loadAlbum);
</script>

<style lang="scss" scoped>
.album-detail { padding: 24px 32px 130px; max-width: 1200px; margin: 0 auto; }
.album-header { display: flex; gap: 24px; margin-bottom: 28px;
  .album-cover { width: 200px; height: 200px; border-radius: var(--fnos-radius-lg); overflow: hidden; flex-shrink: 0; box-shadow: 0 8px 28px rgba(0,0,0,0.4);
    img { width: 100%; height: 100%; object-fit: cover; }
    .cover-placeholder { width: 100%; height: 100%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); }
  }
  .album-meta { display: flex; flex-direction: column; justify-content: center;
    .label { font-size: 12px; color: var(--fnos-text-tertiary); text-transform: uppercase; letter-spacing: 0.5px; }
    h1 { font-size: 32px; font-weight: 700; margin: 8px 0; color: var(--fnos-text-primary); }
    .artist { color: var(--fnos-red); cursor: pointer; font-size: 16px; &:hover { text-decoration: underline; } }
    .info { color: var(--fnos-text-tertiary); margin-top: 8px; font-size: 14px; }
    .actions { margin-top: 18px; display: flex; gap: 10px; flex-wrap: wrap; }
    .actions .detail-fav-btn { display: inline-flex; align-items: center; gap: 6px; }
    .actions .detail-fav-btn.active { color: var(--fnos-red); border-color: var(--fnos-red-ring); }
    .actions .detail-fav-btn.active .mf-icon { color: var(--fnos-red); }
  }
}
@media (max-width: 768px) {
  .album-detail { padding: 20px 16px; }
  .album-header { flex-direction: column; align-items: center; text-align: center; gap: 16px;
    .album-cover { width: 160px; height: 160px; }
    .album-meta h1 { font-size: 22px; }
  }
}
</style>
