<template>
  <div class="album-detail" v-loading="loading">
    <div class="album-header" v-if="album">
      <div class="album-cover">
        <img v-if="album.coverArt" :src="`/rest/getCoverArt?id=${album.coverArt}&size=300`" />
        <div v-else class="cover-placeholder"><MfIcon name="Disc3" :size="64"  /></div>
      </div>
      <div class="album-meta">
        <div class="label">专辑</div>
        <h1>{{ album.name }}</h1>
        <div class="artist" v-if="album.artist" @click="router.push(`/artists/${album.artistId}`)">{{ album.artist }}</div>
        <div class="info">{{ album.year || '' }} · {{ album.songCount }}首 · {{ formatDuration(album.duration) }}</div>
        <IdBadge :id="album.id" copy-label="专辑 ID" style="margin-top: 6px" />
        <div class="actions">
          <el-button type="primary" @click="playAll">播放全部</el-button>
        </div>
      </div>
    </div>
    <SongTable v-if="songs.length > 0" :songs="songs" :show-artist="false" show-bitrate @play="playSong" />
    <EmptyState v-else icon="headphones" title="专辑暂无歌曲" description="该专辑下还没有可播放的曲目" compact />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { usePlayerStore, Song } from "@/stores/player";
import EmptyState from "@/components/EmptyState.vue";
import IdBadge from "@/components/IdBadge.vue";
import api from "@/api";
import SongTable from "@/components/SongTable.vue";

const route = useRoute();
const router = useRouter();
const playerStore = usePlayerStore();
const album = ref<any>(null);
const songs = ref<Song[]>([]);
const loading = ref(false);

function formatDuration(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${s.toString().padStart(2, "0")}`; }
function playSong(song: Song) { playerStore.playSong(song); }
function playAll() { if (songs.value.length > 0) playerStore.playQueue(songs.value); }

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
    .actions { margin-top: 18px; }
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
