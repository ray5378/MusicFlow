<template>
  <div class="artist-detail" v-loading="loading">
    <div class="artist-header" v-if="artist">
      <div class="artist-avatar">
        <img v-if="artist.coverArt" :src="`/rest/getCoverArt?id=${artist.coverArt}&size=300`" />
        <div v-else class="avatar-placeholder"><MfIcon name="User" :size="64"  /></div>
      </div>
      <div class="artist-meta">
        <div class="label">艺术家</div>
        <h1>{{ artist.name }}</h1>
        <div class="info">{{ formatAlbumCount(artist.albumCount) }}</div>
        <div class="actions">
          <el-button type="primary" @click="playAllSongs">播放全部歌曲</el-button>
        </div>
      </div>
    </div>
    <h3>专辑</h3>
    <div class="album-grid">
      <div
        class="album-card fnos-card-sheen"
        v-for="(album, idx) in albums"
        :key="album.id"
        :style="{ '--stagger': idx }"
        @contextmenu="openContextMenu($event, albumActions(album), album.name, albumMeta(album))"
        v-longpress="() => openActionSheet(albumActions(album), album.name, albumMeta(album))"
      >
        <div class="album-cover mf-coverwrap" @click="playAl(album)">
          <img v-if="album.coverArt" :src="`/rest/getCoverArt?id=${album.coverArt}&size=300`" />
          <div v-else class="cover-placeholder"><MfIcon name="Disc3" :size="32"  /></div>
          <CoverPlay size="md" :label="`播放 ${album.name}`" :action="() => playAl(album)" />
        </div>
        <div class="album-info" @click="open(album)">
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
import { ElMessage } from "element-plus";
import CoverPlay from "@/components/CoverPlay.vue";
import { useItemActions } from "@/composables/useItemActions";
import { usePlayContent } from "@/composables/usePlayContent";
import api from "@/api";

const route = useRoute();
const router = useRouter();
const playerStore = usePlayerStore();
const { openContextMenu, openActionSheet, menuGuard, albumActions } = useItemActions();
const play = usePlayContent();
const artist = ref<any>(null);
const albums = ref<any[]>([]);
const loading = ref(false);

function open(album: any) {
  if (menuGuard()) return;
  router.push(`/albums/${album.id}`);
}
function albumMeta(album: any) {
  return [album.year, album.songCount ? `${album.songCount} 首` : ""].filter(Boolean).join(" · ");
}
async function playAl(album: any) {
  if (menuGuard()) return;
  const n = await play.playAlbum(album.id);
  if (n) ElMessage.success(`正在播放「${album.name}」`);
  else ElMessage.warning("该专辑暂无可播放歌曲");
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
  if (n === 1) return '1 张专辑';
  return `${n} 张专辑`;
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
    .actions { margin-top: 16px; }
  }
}
h3 { margin-bottom: 16px; color: var(--fnos-text-primary); font-size: 20px; font-weight: 600; }
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; }
.album-card {
  cursor: pointer; border-radius: var(--fnos-radius-lg); overflow: hidden;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
  transition: transform 0.22s ease, background 0.22s ease, box-shadow 0.22s ease;
  animation: home-card-in 0.45s ease both;
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
