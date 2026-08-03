<template>
  <div class="artist-detail" v-loading="loading">
    <div class="artist-header" v-if="artist">
      <div class="artist-avatar">
        <img v-if="artist.coverArt" :src="`/rest/getCoverArt?id=${artist.coverArt}&size=300`" />
        <div v-else class="avatar-placeholder"><el-icon :size="64"><User /></el-icon></div>
      </div>
      <div class="artist-meta">
        <div class="label">艺术家</div>
        <h1>{{ artist.name }}</h1>
        <div class="info">{{ artist.albumCount }}张专辑</div>
        <div class="actions">
          <el-button type="primary" @click="playAllSongs">播放全部歌曲</el-button>
        </div>
      </div>
    </div>
    <h3>专辑</h3>
    <div class="album-grid">
      <div class="album-card" v-for="album in albums" :key="album.id" @click="router.push(`/albums/${album.id}`)">
        <div class="album-cover">
          <img v-if="album.coverArt" :src="`/rest/getCoverArt?id=${album.coverArt}&size=300`" />
          <div v-else class="cover-placeholder"><el-icon :size="32"><Service /></el-icon></div>
        </div>
        <div class="album-info">
          <div class="album-name">{{ album.name }}</div>
          <div class="album-meta">{{ album.year || '' }} · {{ album.songCount }}首</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { usePlayerStore } from "@/stores/player";
import { User, Service as Disc } from "@element-plus/icons-vue";
import api from "@/api";

const route = useRoute();
const router = useRouter();
const playerStore = usePlayerStore();
const artist = ref<any>(null);
const albums = ref<any[]>([]);
const loading = ref(false);

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

onMounted(loadArtist);
</script>

<style lang="scss" scoped>
.artist-detail { padding: 24px; }
.artist-header { display: flex; gap: 24px; margin-bottom: 32px;
  .artist-avatar { width: 180px; height: 180px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
    img { width: 100%; height: 100%; object-fit: cover; }
    .avatar-placeholder { width: 100%; height: 100%; background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #ccc; border-radius: 50%; }
  }
  .artist-meta { display: flex; flex-direction: column; justify-content: center;
    .label { font-size: 12px; color: #999; text-transform: uppercase; }
    h1 { font-size: 28px; font-weight: 700; margin: 8px 0; }
    .info { color: #999; font-size: 14px; }
    .actions { margin-top: 16px; }
  }
}
h3 { margin-bottom: 16px; }
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; }
.album-card { cursor: pointer; border-radius: 8px; overflow: hidden; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: transform 0.2s;
  &:hover { transform: translateY(-4px); }
  .album-cover { aspect-ratio: 1; overflow: hidden;
    img { width: 100%; height: 100%; object-fit: cover; }
    .cover-placeholder { width: 100%; height: 100%; background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #ccc; }
  }
  .album-info { padding: 12px;
    .album-name { font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .album-meta { font-size: 12px; color: #999; margin-top: 4px; }
  }
}
</style>
