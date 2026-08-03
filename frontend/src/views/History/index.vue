<template>
  <div class="history-page">
    <div class="page-header"><h2>播放历史</h2></div>
    <el-table :data="songs" stripe @row-dblclick="playSong" highlight-current-row v-loading="loading">
      <el-table-column type="index" width="60" label="#" />
      <el-table-column prop="title" label="标题" min-width="200" />
      <el-table-column prop="artist" label="艺术家" width="180" />
      <el-table-column prop="album" label="专辑" width="200" />
      <el-table-column label="时长" width="100"><template #default="{ row }">{{ formatDuration(row.duration) }}</template></el-table-column>
      <el-table-column label="操作" width="80"><template #default="{ row }"><el-button :icon="Play" circle size="small" @click="playSong(row)" /></template></el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { usePlayerStore } from "@/stores/player";
import { VideoPlay as Play } from "@element-plus/icons-vue";
import api from "@/api";

const playerStore = usePlayerStore();
const songs = ref<any[]>([]);
const loading = ref(false);

function formatDuration(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${s.toString().padStart(2, "0")}`; }
function playSong(song: any) { playerStore.playSong(song); }

async function loadHistory() {
  loading.value = true;
  try {
    const res = await api.get("/rest/getRandomSongs?size=50&f=json");
    songs.value = res.data["subsonic-response"]?.randomSongs?.song || [];
  } catch { songs.value = []; }
  finally { loading.value = false; }
}

onMounted(loadHistory);
</script>

<style lang="scss" scoped>
.history-page { padding: 24px; }
.page-header { margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
</style>
