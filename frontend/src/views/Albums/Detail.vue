<template>
  <div class="album-detail" v-loading="loading">
    <div class="album-header" v-if="album">
      <div class="album-cover">
        <img v-if="album.coverArt" :src="`/rest/getCoverArt?id=${album.coverArt}&size=300`" />
        <div v-else class="cover-placeholder"><el-icon :size="64"><Service /></el-icon></div>
      </div>
      <div class="album-meta">
        <div class="label">专辑</div>
        <h1>{{ album.name }}</h1>
        <div class="artist" v-if="album.artist" @click="router.push(`/artists/${album.artistId}`)">{{ album.artist }}</div>
        <div class="info">{{ album.year || '' }} · {{ album.songCount }}首 · {{ formatDuration(album.duration) }}</div>
        <div class="actions">
          <el-button type="primary" @click="playAll">播放全部</el-button>
        </div>
      </div>
    </div>
    <el-table :data="songs" stripe @row-dblclick="playSong" highlight-current-row style="width: 100%">
      <el-table-column type="index" width="60" label="#" />
      <el-table-column prop="title" label="标题" min-width="200" />
      <el-table-column label="时长" width="100">
        <template #default="{ row }">{{ formatDuration(row.duration) }}</template>
      </el-table-column>
      <el-table-column label="码率" width="100">
        <template #default="{ row }">{{ row.bitRate ? `${row.bitRate}kbps` : '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="80">
        <template #default="{ row }">
          <el-tooltip content="播放" placement="top">
            <el-button :icon="Play" circle size="small" @click="playSong(row)" />
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { usePlayerStore, Song } from "@/stores/player";
import { Service as Disc, VideoPlay as Play } from "@element-plus/icons-vue";
import api from "@/api";

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
.album-detail { padding: 24px; }
.album-header { display: flex; gap: 24px; margin-bottom: 24px;
  .album-cover { width: 200px; height: 200px; border-radius: 8px; overflow: hidden; flex-shrink: 0;
    img { width: 100%; height: 100%; object-fit: cover; }
    .cover-placeholder { width: 100%; height: 100%; background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #ccc; }
  }
  .album-meta { display: flex; flex-direction: column; justify-content: center;
    .label { font-size: 12px; color: #999; text-transform: uppercase; }
    h1 { font-size: 28px; font-weight: 700; margin: 8px 0; }
    .artist { color: var(--primary-color); cursor: pointer; font-size: 16px; &:hover { text-decoration: underline; } }
    .info { color: #999; margin-top: 8px; font-size: 14px; }
    .actions { margin-top: 16px; }
  }
}
</style>
