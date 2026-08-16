<template>
  <el-dialog
    :model-value="modelValue"
    :title="item?.name || '远程内容'"
    width="680px"
    :append-to-body="true"
    class="remote-detail-dialog"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @open="open"
  >
    <!-- 头部:封面 + 名称 + 元信息 + 操作 -->
    <div v-if="item" class="rd-header">
      <div class="rd-cover">
        <img v-if="item.cover || item.avatar" :src="item.cover || item.avatar" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
        <div v-else class="rd-cover-ph"><MfIcon name="Disc3" :size="36" /></div>
      </div>
      <div class="rd-meta">
        <div class="rd-name">{{ item.name }}</div>
        <div class="rd-sub">
          {{ metaText }}
        </div>
        <div class="rd-actions">
          <el-button type="primary" size="small" :loading="playing" @click="playAll">
            <MfIcon name="Play" />播放全部
          </el-button>
          <el-button v-if="importable" size="small" type="primary" plain :loading="importing" :disabled="imported" @click="doImport">
            <MfIcon name="Download" />{{ imported ? "已加入库" : "加入库" }}
          </el-button>
          <span v-if="item.platformLabel" class="rd-tag">{{ item.platformLabel }}</span>
        </div>
      </div>
    </div>

    <!-- 歌曲列表:复用 SongTable(悬浮播放/点击播放),未入库歌曲直接播(streamUrl) -->
    <div class="rd-body" v-loading="loading">
      <SongTable v-if="songs.length > 0" :songs="songs" remote :loading="loading" empty-text="该内容没有可播放的歌曲" @play="playSong" />
      <div v-else-if="!loading" class="rd-empty">没有拉取到歌曲</div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { ElMessage } from "element-plus";
import api from "@/api";
import { usePlayerStore, Song } from "@/stores/player";
import { fetchRemoteCollectionSongs, remoteItemToSong } from "@/composables/useEntitySearch";
import { waitAsyncTask } from "@/utils/asyncTask";
import SongTable from "@/components/SongTable.vue";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** album | playlist | artist */
    kind: "album" | "playlist" | "artist";
    providerId: string;
    item: any;
  }>(),
  { modelValue: false, kind: "album", providerId: "", item: null },
);

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  /** 导入成功后通知页面刷新本地列表 */
  (e: "imported"): void;
}>();

const player = usePlayerStore();
const songs = ref<Song[]>([]);
const loading = ref(false);
const playing = ref(false);
const importing = ref(false);
const imported = ref(false);

const importable = computed(() => props.kind !== "artist");
const metaText = computed(() => {
  const it = props.item || {};
  const parts: string[] = [];
  if (it.artist) parts.push(it.artist);
  if (it.creator) parts.push(it.creator);
  if (it.trackCount) parts.push(`${it.trackCount}首`);
  if (it.albumCount) parts.push(`${it.albumCount} 张专辑`);
  if (it.songCount) parts.push(`${it.songCount} 首`);
  return parts.join(" · ");
});

async function open() {
  if (!props.item || !props.providerId) return;
  loading.value = true;
  songs.value = [];
  try {
    songs.value = await fetchRemoteCollectionSongs(props.kind, props.providerId, props.item);
  } finally {
    loading.value = false;
  }
}

function playSong(song: Song) {
  player.playSong(song);
}
async function playAll() {
  if (songs.value.length === 0) await open();
  if (songs.value.length === 0) {
    ElMessage.warning("该内容暂无可播放歌曲");
    return;
  }
  playing.value = true;
  try {
    player.playQueue(songs.value, 0);
  } finally {
    playing.value = false;
  }
}

async function doImport() {
  if (!props.item || !props.providerId || importing.value) return;
  importing.value = true;
  const base = props.kind === "playlist" ? "/rest/api/v1/playlist-search" : "/rest/api/v1/album-search";
  try {
    const res = await api.post(`${base}/${props.providerId}/import`, {
      source: props.item.source,
      id: props.item.id,
      name: props.item.name,
      cover: props.item.cover,
    });
    if (res.data?.alreadyRunning) {
      ElMessage.warning("正在导入中,请稍候");
      return;
    }
    if (!res.data?.success || !res.data.taskId) {
      ElMessage.error(res.data?.error || "导入失败");
      return;
    }
    const r = await waitAsyncTask(res.data.taskId, { intervalMs: 800 });
    if (r?.success) {
      imported.value = true;
      ElMessage.success(`已加入库:${r.name || props.item.name}(${r.trackCount}首,匹配 ${r.added})`);
      emit("imported");
    } else {
      ElMessage.error(r?.error || "导入失败");
    }
  } catch (e: any) {
    ElMessage.error(e?.message || "导入失败:插件未启用或服务不可达");
  } finally {
    importing.value = false;
  }
}

watch(
  () => props.item,
  () => {
    imported.value = false;
    songs.value = [];
  },
);
</script>

<style lang="scss" scoped>
.rd-header {
  display: flex;
  gap: 18px;
  padding: 4px 4px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  margin-bottom: 14px;
  .rd-cover {
    width: 110px;
    height: 110px;
    flex-shrink: 0;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
    img { width: 100%; height: 100%; object-fit: cover; }
    .rd-cover-ph {
      width: 100%; height: 100%;
      background: rgba(255, 255, 255, 0.06);
      display: flex; align-items: center; justify-content: center;
      color: rgba(255, 255, 255, 0.4);
    }
  }
  .rd-meta {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column; justify-content: center;
    .rd-name { font-size: 18px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rd-sub { font-size: 13px; color: var(--fnos-text-tertiary); margin-top: 6px; }
    .rd-actions {
      display: flex; align-items: center; gap: 10px; margin-top: 14px;
      .rd-tag {
        margin-left: auto; padding: 2px 10px; border-radius: 6px; font-size: 11px;
        background: rgba(0, 0, 0, 0.45); color: #fff;
      }
    }
  }
}
.rd-body { min-height: 120px; }
.rd-empty { text-align: center; color: var(--fnos-text-tertiary); padding: 40px 0; font-size: 13px; }
</style>
