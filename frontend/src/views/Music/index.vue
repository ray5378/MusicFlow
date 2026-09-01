<template>
  <div class="songs-page">
    <!-- ===== 页头 ===== -->
    <div class="page-header">
      <div class="page-title">
        <h2>{{ recentMode ? "最近添加" : "音乐" }}</h2>
        <span class="song-count">{{ total }} 首</span>
      </div>
      <div class="header-actions">
        <span class="search-label">搜索</span>
        <el-dropdown trigger="click" @command="onSearchSourceCommand">
          <el-button>
            {{ currentSourceLabel }}
            <el-icon class="el-icon--right"><MfIcon name="ChevronDown" /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="aggregate">聚合</el-dropdown-item>
              <el-dropdown-item command="local" :divided="true">本地</el-dropdown-item>
              <el-dropdown-item v-for="(p, i) in searchProviders" :key="p.id" :command="p.id">{{ p.name }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-input
          v-model="searchQuery"
          :placeholder="searchPlaceholder"
          prefix-icon="Search"
          clearable
          class="search-input"
          @input="onSearchInput"
          @clear="onSearchClear"
        />
        <el-button type="primary" class="play-all-btn" @click="playAll" :disabled="songs.length === 0"><MfIcon name="Play" />
          播放全部
        </el-button>
      </div>
    </div>

    <!-- ===== 彩色磁贴（飞牛首页风格） ===== -->
    <div class="hero-tiles">
      <div class="tile tile-added" @click="goRecent">
        <div class="tile-glow"></div>
        <MfIcon name="Plus" class="tile-icon" :size="34"  />
        <span class="tile-label">最近添加</span>
      </div>
      <div class="tile tile-recent" @click="$router.push('/history')">
        <div class="tile-glow"></div>
        <MfIcon name="Clock" class="tile-icon" :size="34"  />
        <span class="tile-label">最近播放</span>
      </div>
      <div class="tile tile-fav" @click="$router.push('/favorites')">
        <div class="tile-glow"></div>
        <MfIcon name="Heart" :filled="true" class="tile-icon" :size="34" />
        <span class="tile-label">我喜欢的音乐</span>
      </div>
      <div class="tile tile-mix" @click="$router.push('/genres')">
        <div class="tile-glow"></div>
        <MfIcon name="Library" class="tile-icon" :size="34"  />
        <span class="tile-label">风格</span>
      </div>
    </div>

    <!-- ===== 歌曲列表(本地模式,聚合模式下同样展示) ===== -->
    <SongTable v-if="isLocalMode" :songs="songs" :loading="loading" show-source :on-window="onWindow" @play="playSong" />

    <!-- ===== 聚合搜索结果(默认模式):本地在上,全网并用分节标题放在下 ===== -->
    <div v-if="isAggregateMode" class="remote-results agg" v-loading="aggregateSearching">
      <div v-if="aggregateItems.length === 0 && !aggregateSearching" class="remote-empty">
        <MfIcon name="Search" :size="40" />
        <p>{{ searchQuery.trim() ? "没有找到相关全网音乐" : "输入关键词,同时搜索本地库与已启用插件的全网音乐" }}</p>
      </div>
      <template v-else>
        <div class="agg-head">
          <span class="agg-title"><MfIcon name="Globe" />全网结果</span>
          <span class="agg-meta">已启用插件的合并搜索,歌曲带插件·平台标签</span>
        </div>
        <SongTable :songs="aggregateSongs" remote :loading="aggregateSearching" empty-text="没有找到相关音乐" @play="playSong">
          <template #row-actions="{ row }">
            <el-button size="small" type="primary" plain :loading="importingId === 'all'" @click.stop="importSongs([row._item], row._item.providerId)">加入库</el-button>
          </template>
        </SongTable>
      </template>
    </div>

    <!-- ===== 远程搜索结果(插件模式):由启用的 songSearch 插件(如 go-music-dl)提供 =====
         复用 SongTable(本地同款交互:悬浮播放/点击播放/右键菜单),歌曲未入库也能播
         (streamUrl → /rest/stream-remote 代理流),另保留「加入库」能力 -->
    <div v-if="isRemoteMode" class="remote-results">
      <div v-if="remoteItems.length === 0 && !remoteSearching" class="remote-empty">
        <MfIcon name="Search" :size="40" />
        <p>{{ searchQuery.trim() ? "没有找到相关音乐" : `输入关键词,搜索${currentProviderName}支持的全网音乐` }}</p>
      </div>
      <template v-else>
        <div class="remote-toolbar">
          <el-button size="small" type="primary" :loading="importingId === 'all'" @click="importSongs(remoteItems)">
            <MfIcon name="Download" />全部加入库
          </el-button>
        </div>
        <SongTable :songs="remoteSongs" remote :loading="remoteSearching" empty-text="没有找到相关音乐" @play="playSong">
          <template #row-actions="{ row }">
            <el-button size="small" type="primary" plain :loading="importingId === 'all'" @click.stop="importSongs([row._item])">加入库</el-button>
          </template>
        </SongTable>
      </template>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { usePlayerStore, Song } from "@/stores/player";
import { useItemActions } from "@/composables/useItemActions";
import { useEntitySearch, remoteItemToSong } from "@/composables/useEntitySearch";
import api from "@/api";
import SongTable from "@/components/SongTable.vue";
import { useInfiniteList } from "@/composables/useInfiniteList";

const playerStore = usePlayerStore();
const route = useRoute();
const router = useRouter();
const { menuGuard } = useItemActions();
const searchQuery = ref("");

// 本地歌曲列表:窗口化分块加载(与 HA 卡片同构)。整页展示 + 滚动懒加载:
// 数据按块 fetch,仅视口窗口渲染,越界剪枝,内存不随浏览条目数增长;取代原分页。
const { list: songs, loading, total, reload: loadSongs, onWindow } = useInfiniteList<any>(
  async (offset, size) => {
    const page = Math.floor(offset / size) + 1;
    const res = await api.get(`/rest/api/v1/songs`, {
      params: {
        page,
        pageSize: size,
        query: searchQuery.value,
        ...(recentMode.value ? { sort: "recentAdded" } : {}),
      },
    });
    return { items: res.data.items || [], total: res.data.total || 0 };
  },
  // chunk 与后端 /v1/songs 的 pageSize 上限(200)对齐:若 chunk 超过后端上限
  // (如旧值 250),后端只回 200 条,块内剩余 50 个槽位永远 undefined → 滚动后空白。
  // prefetchBlocks/concurrency 调大:预取跑道更长、并发更高,滚动更丝滑不卡骨架。
  { chunk: 200, keepRows: 300, prefetchBlocks: 2, concurrency: 3 }
);

// 远程搜索共享逻辑(本地/插件搜索来源下拉):插件没声明 songSearch 就不出现在下拉里
const {
  searchMode, searchProviders, remoteItems, remoteSearching, aggregateItems, aggregateSearching,
  importingId, isLocalMode, isRemoteMode, isAggregateMode, currentProviderName, currentSourceLabel,
  loadSearchProviders, onSearchSourceCommand, doRemoteSearch, doAggregateSearch, importSongs,
  setLocalLoader, setAfterRemoteImport,
} = useEntitySearch("song");
const searchPlaceholder = computed(() => {
  if (isAggregateMode.value) return "搜索本地与全网音乐...";
  return isRemoteMode.value ? `搜索${currentProviderName}全网音乐...` : "搜索音乐...";
});
// 远程搜索结果 → 可播放 Song(带 streamUrl,未入库直接播;原始 item 挂 _item 供加入库)
const remoteSongs = computed(() => remoteItems.value.map((it) => remoteItemToSong(it, searchMode.value)));
// 聚合结果:每条挂自己的 providerId → 各自归位到对应插件(可播/可入库)
const aggregateSongs = computed(() => aggregateItems.value.map((it) => remoteItemToSong(it, it.providerId)));

// 最近添加模式：/songs?recent=1 → 展示最新入库的 500 首（后端 sort=recentAdded）
const recentMode = computed(() => route.query.recent === "1");

let searchTimer: ReturnType<typeof setTimeout> | null = null;

function goRecent() {
  if (recentMode.value) return;
  searchQuery.value = "";
  router.push({ path: "/songs", query: { recent: "1" } });
}

// recent 模式切换（进入/退出）时重置并重新加载
watch(() => route.query.recent, () => {
  searchQuery.value = "";
  loadSongs();
});

function onSearchInput() {
  // 聚合(默认)模式:同时刷新本地 + 聚合全网
  if (isAggregateMode.value) {
    if (recentMode.value) router.replace({ path: "/songs", query: {} });
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      loadSongs();
      doAggregateSearch(searchQuery.value);
    }, 300);
    return;
  }
  // 远程(插件)模式:直接搜插件
  if (isRemoteMode.value) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { doRemoteSearch(searchQuery.value); }, 300);
    return;
  }
  // 本地模式:搜索时退出最近添加模式，回到全部音乐
  if (recentMode.value) { router.replace({ path: "/songs", query: {} }); return; }
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { loadSongs(); }, 300);
}

function onSearchClear() {
  if (isAggregateMode.value) { loadSongs(); doAggregateSearch(searchQuery.value); return; }
  if (isRemoteMode.value) { doRemoteSearch(searchQuery.value); return; }
  loadSongs();
}

function playSong(song: Song) {
  if (menuGuard()) return;
  playerStore.playSong(song);
}
function playAll() { const all = songs.value.filter(Boolean); if (all.length > 0) playerStore.playQueue(all); }

// 切换搜索来源:插件模式立即搜插件;聚合模式刷新本地+聚合全网;切回本地由 composable 触发 localLoader
watch(() => searchMode.value, () => {
  if (!searchQuery.value.trim()) return;
  if (isRemoteMode.value) doRemoteSearch(searchQuery.value);
  else if (isAggregateMode.value) { loadSongs(); doAggregateSearch(searchQuery.value); }
});

onMounted(() => {
  setLocalLoader(loadSongs);          // 切回「本地」/本地搜索时刷新
  setAfterRemoteImport(loadSongs);    // 「加入库」成功后刷新本地列表
  loadSearchProviders();
  loadSongs();
  window.addEventListener("mf:song-deleted", onSongDeleted);
});
// 右键「从音乐库删除」成功后刷新本地列表(删除的 web 歌曲级联清收藏/历史/歌单条目)
function onSongDeleted() { loadSongs(); }
onBeforeUnmount(() => window.removeEventListener("mf:song-deleted", onSongDeleted));
</script>

<style lang="scss" scoped>
.songs-page {
  padding: 32px 36px 130px;   /* 底部 130px 为悬浮播放条让位，避免分页被遮挡 */
  max-width: 1400px;
  margin: 0 auto;
}

/* ===== Hero tiles (FnOS home dashboard) ===== */
.hero-tiles {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 36px;
}
.tile {
  position: relative;
  height: 160px;
  border-radius: 16px;
  overflow: hidden;
  cursor: pointer;
  display: flex; flex-direction: column; justify-content: space-between;
  padding: 18px;
  color: #fff;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.12);
  transition: transform 0.25s ease, box-shadow 0.25s ease;
  isolation: isolate;
}
.tile:hover {
  transform: translateY(-4px);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
.tile:active { transform: translateY(-1px) scale(0.98); }
.tile .tile-glow {
  position: absolute;
  inset: -40%;
  pointer-events: none;
  /* 去掉 filter:blur(40px) 与 transform 无限动画 —— 两者都会把元素永久提升为
     合成层；华为等旧 Chromium 浏览器对嵌套 stacking context 的合成顺序有 bug，
     会把这些合成层提升到 fixed 弹窗(z=3000)之上，造成卡片穿透弹窗的"闪烁"。
     柔光效果用大半径 radial-gradient 的透明过渡近似，视觉几乎无差。 */
  opacity: 0.55;
  z-index: -1;
}
.tile .tile-icon {
  align-self: flex-start;
  color: rgba(255, 255, 255, 0.92);
  /* backdrop-filter 同样提升合成层，改略不透明的纯色圆底即可（视觉几乎无差） */
  background: rgba(255, 255, 255, 0.22);
  border-radius: 50%;
  padding: 8px;
  width: 50px; height: 50px;
  display: inline-flex; align-items: center; justify-content: center;
}
.tile .tile-label {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
/* 混音：紫橙渐变 + 黑胶质感 */
.tile-mix {
  background:
    radial-gradient(ellipse at 70% 50%, #1a1a1a 0%, #0a0a0a 40%, transparent 70%),
    linear-gradient(135deg, #ff7a3d 0%, #c934e1 60%, #5b2bbf 100%);
}
.tile-mix .tile-glow {
  background: radial-gradient(circle, rgba(255, 122, 61, 0.6), transparent 60%);
}
/* 收藏：橙红 + 心形 */
.tile-fav {
  background: linear-gradient(135deg, #ffb347 0%, #ff6b3d 35%, #f62c55 75%, #d11d4a 100%);
}
.tile-fav .tile-glow {
  background: radial-gradient(circle, rgba(255, 107, 61, 0.7), transparent 60%);
}
/* 最近播放：绿 */
.tile-recent {
  background: linear-gradient(135deg, #6bab45 0%, #16a34a 45%, #0d8a6e 100%);
}
.tile-recent .tile-glow {
  background: radial-gradient(circle, rgba(107, 171, 69, 0.7), transparent 60%);
}
/* 最近添加：白灰 */
.tile-added {
  background: linear-gradient(135deg, #f5f5f5 0%, #d8d8d8 45%, #a8a8a8 100%);
  color: #2a2a2a;
}
.tile-added .tile-icon { color: #2a2a2a; background: rgba(0, 0, 0, 0.08); }
.tile-added .tile-label { color: #2a2a2a; text-shadow: none; }
.tile-added .tile-glow {
  background: radial-gradient(circle, rgba(255, 255, 255, 0.8), transparent 60%);
}

@media (max-width: 1100px) {
  .hero-tiles { grid-template-columns: repeat(2, 1fr); }
  .tile { height: 140px; }
}
@media (max-width: 768px) {
  .hero-tiles { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .tile { height: 120px; padding: 14px; }
  .tile .tile-icon { width: 42px; height: 42px; padding: 6px; }
  .tile .tile-label { font-size: 14px; }
}

/* ===== Page header ===== */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 28px;
  gap: 16px;
  flex-wrap: wrap;
  .page-title {
    display: flex;
    align-items: baseline;
    gap: 14px;
    h2 {
      font-size: 32px;
      font-weight: 700;
      margin: 0;
      letter-spacing: -0.4px;
      color: var(--fnos-text-primary);
    }
    .song-count {
      font-size: 14px;
      color: var(--fnos-text-tertiary);
      font-weight: 500;
    }
  }
  .header-actions {
    display: flex;
    gap: 12px;
    align-items: center;
    .search-input {
      width: 320px;
    }
    .play-all-btn {
      padding: 0 20px;
      height: 38px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
  }
}

/* ===== Song list (SongTable component) ===== */

/* ===== 远程搜索结果(插件模式) ===== */
.search-label { font-size: 14px; color: var(--fnos-text-secondary); margin-right: 2px; white-space: nowrap; }
.remote-results {
  .remote-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 0; color: var(--fnos-text-tertiary); font-size: 13px; }
  .remote-toolbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
}
/* 聚合模式分节标题栏(与本页「全网结果」分节共用) */
.remote-results.agg {
  margin-top: 24px; padding-top: 20px;
  border-top: 1px solid rgba(255,255,255,0.1);
  .agg-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px;
    .agg-title { font-size: 15px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; color: var(--fnos-text-primary); }
    .agg-meta { font-size: 12px; color: var(--fnos-text-tertiary); }
  }
}

.pagination-bar {
  margin-top: 24px;
  display: flex;
  justify-content: center;
}

@media (max-width: 768px) {
  .songs-page { padding: 20px 16px; }
  .page-header {
    flex-direction: column; align-items: flex-start; gap: 12px;
    .page-title h2 { font-size: 24px; }
    /* 手机端:搜索「来源 + 输入框」独占一行,「播放全部」换行到下一整行。
       否则来源下拉 + 输入框 + 按钮挤在同一行,输入框被压缩到几乎看不清文字。 */
    .header-actions { width: 100%; flex-wrap: wrap; gap: 10px 12px; }
    .header-actions .search-input { flex: 1 1 auto; width: auto; min-width: 0; }
    .header-actions .play-all-btn { flex-basis: 100%; flex-grow: 1; flex-shrink: 0; }
  }
}
</style>