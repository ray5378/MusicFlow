<template>
  <div class="artists-page">
    <div class="page-header">
      <h2>{{ t('artists.title') }}<span class="song-count">{{ t('artists.count', { count: total }) }}</span></h2>
      <div class="header-actions">
        <div class="scrape-status" v-if="scrapeProgress">
          <el-tag :type="scrapeRunning ? 'warning' : 'success'" size="small" class="scrape-tag">
            <template v-if="scrapeRunning">
              <span class="scrape-spin"><MfIcon name="Loader2" class="is-loading"  spin /></span>
              {{ t('artists.scraping', { processed: scrapeProgress.processed, total: scrapeProgress.total }) }}
              <span v-if="scrapeProgress.current">({{ scrapeProgress.current }})</span>
              · {{ t('artists.scrapeSuccess', { count: scrapeProgress.scraped }) }} · {{ t('artists.scrapeFallback', { count: scrapeProgress.fallback }) }} · {{ t('artists.scrapeSkipped', { count: scrapeProgress.skipped }) }}
            </template>
            <template v-else>
              {{ t('artists.scrapeDone', { scraped: scrapeProgress.scraped, fallback: scrapeProgress.fallback, skipped: scrapeProgress.skipped }) }}
            </template>
          </el-tag>
        </div>
        <el-tooltip :content="t('artists.scrapeTooltip')" placement="top">
          <el-button :loading="scraping" @click="scrapeArtists"><MfIcon name="Wand2" />{{ t('artists.scrapeBtn') }}</el-button>
        </el-tooltip>
        <el-tooltip :content="t('artists.scrapeMissingTooltip')" placement="top">
          <el-button :loading="scrapingMissing" :badge="missingCount" @click="scrapeMissingArtists">
            <MfIcon name="RotateCcw" />{{ t('artists.scrapeMissingBtn') }}<template v-if="missingCount > 0">({{ missingCount }})</template>
          </el-button>
        </el-tooltip>
        <span class="search-label">{{ t('artists.search') }}</span>
        <el-dropdown trigger="click" @command="onSearchSourceCommand">
          <el-button>
            {{ currentSourceLabel }}
            <el-icon class="el-icon--right"><MfIcon name="ChevronDown" /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="aggregate">{{ t('artists.aggregate') }}</el-dropdown-item>
              <el-dropdown-item command="local" :divided="true">{{ t('artists.local') }}</el-dropdown-item>
              <el-dropdown-item v-for="(p, i) in searchProviders" :key="p.id" :command="p.id">{{ p.name }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-input v-model="searchQuery" :placeholder="searchPlaceholder" prefix-icon="Search" clearable style="width: 300px" @input="onSearchInput" @clear="onSearchClear" />
      </div>
    </div>
    <div class="artist-grid virt-grid" v-if="isLocalMode" ref="gridEl" v-loading="loading" :style="{ height: frameHeight }">
      <template v-for="g in gridViews" :key="g.item ? g.item.id : 'ph-' + g.idx">
      <div
        v-if="g.item"
        class="artist-card"
        :style="cardStyle(g.idx)"
        @contextmenu="openContextMenu($event, artistActions(g.item), g.item.name, formatAlbumCount(g.item.albumCount))"
        v-longpress="() => openActionSheet(artistActions(g.item), g.item.name, formatAlbumCount(g.item.albumCount))"
      >
        <div class="artist-avatar mf-coverwrap" @click="open(g.item)">
          <img v-if="g.item.coverArt" :src="coverUrl(g.item.coverArt)" loading="lazy" decoding="async" />
          <div v-else class="avatar-placeholder"><MfIcon name="User" :size="48"  /></div>
          <el-tooltip v-if="g.item.scrapeMissing" :content="t('artists.missingTooltip')" placement="top">
            <el-tag size="small" type="warning" class="missing-tag">{{ t('artists.missingInfo') }}</el-tag>
          </el-tooltip>
          <CoverPlay size="md" :label="t('artists.play', { name: g.item.name })" :action="() => playAr(g.item)" />
          <button
            class="card-fav-btn"
            :class="{ active: fav.isArtistFavorite(g.item.id) }"
            :title="fav.isArtistFavorite(g.item.id) ? t('artists.unfavorite') : t('artists.favorite')"
            @click.stop="toggleArtistFav(g.item)"
          >
            <MfIcon name="Heart" :filled="fav.isArtistFavorite(g.item.id)" :size="16" />
          </button>
        </div>
        <div class="artist-name" @click="open(g.item)">{{ g.item.name }}</div>
        <div class="artist-meta" @click="open(g.item)">{{ formatAlbumCount(g.item.albumCount) }}</div>
      </div>
      <div v-else class="artist-card is-placeholder" :style="cardStyle(g.idx)">
        <div class="artist-avatar ph-avatar"></div>
        <div class="artist-name ph-bar"></div>
        <div class="artist-meta ph-bar short"></div>
      </div>
      </template>
    </div>

    <!-- ===== 聚合搜索结果(默认模式):本地在上,全网并用分节标题放在下 ===== -->
    <div v-if="isAggregateMode" class="remote-results agg" v-loading="aggregateSearching">
      <div v-if="aggregateItems.length === 0 && !aggregateSearching" class="remote-empty">
        <MfIcon name="User" :size="40" />
        <p>{{ searchQuery.trim() ? t('artists.aggNoResult') : t('artists.aggHint') }}</p>
      </div>
      <template v-else>
        <div class="agg-head">
          <span class="agg-title"><MfIcon name="Globe" />{{ t('artists.webResult') }}</span>
          <span class="agg-meta">{{ t('artists.aggMeta') }}</span>
        </div>
        <div class="artist-grid" v-loading="aggregateSearching">
          <div class="artist-card" v-for="(item, i) in aggregateItems" :key="item.providerId + ':' + item.source + ':' + item.id">
            <div class="artist-avatar mf-coverwrap" @click="openRemote(item)">
              <img v-if="item.avatar" :src="item.avatar" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
              <div v-else class="avatar-placeholder"><MfIcon name="User" :size="48" /></div>
              <span class="remote-source-tag">{{ item.providerName ? item.providerName + "·" : "" }}{{ item.platformLabel }}</span>
              <CoverPlay size="md" :label="t('artists.play', { name: item.name })" :action="() => playRemoteAr(item)" />
            </div>
            <div class="artist-name" @click="openRemote(item)">{{ item.name }}</div>
            <div class="artist-meta" @click="openRemote(item)">{{ formatRemoteMeta(item) }}</div>
          </div>
        </div>
      </template>

      <!-- 聚合远程艺术家详情:点击卡片 → 按名字搜歌预览(仅展示+播放,无导入) -->
      <RemoteDetailDialog
        v-model="remoteDetailVisible"
        kind="artist"
        :provider-id="remoteDetailProviderId"
        :item="remoteDetailItem"
      />
    </div>

    <!-- 远程搜索结果(插件模式):由启用的 artistSearch 插件提供,仅展示(发现用,无导入) -->
    <div v-if="isRemoteMode" class="remote-results" v-loading="remoteSearching">
      <div v-if="remoteItems.length === 0 && !remoteSearching" class="remote-empty">
        <MfIcon name="User" :size="40" />
        <p>{{ searchQuery.trim() ? t('artists.noResult') : t('artists.remoteHint', { provider: currentProviderName }) }}</p>
      </div>
      <div v-else class="artist-grid">
        <div class="artist-card" v-for="(item, i) in remoteItems" :key="i">
          <div class="artist-avatar mf-coverwrap" @click="openRemote(item)">
            <img v-if="item.avatar" :src="item.avatar" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            <div v-else class="avatar-placeholder"><MfIcon name="User" :size="48" /></div>
            <span class="remote-source-tag">{{ item.platformLabel }}</span>
            <CoverPlay size="md" :label="t('artists.play', { name: item.name })" :action="() => playRemoteAr(item)" />
          </div>
          <div class="artist-name" @click="openRemote(item)">{{ item.name }}</div>
          <div class="artist-meta" @click="openRemote(item)">{{ formatRemoteMeta(item) }}</div>
        </div>
      </div>

      <!-- 远程艺术家详情:点击卡片 → 按名字搜歌预览(仅展示+播放,无导入) -->
      <RemoteDetailDialog
        v-model="remoteDetailVisible"
        kind="artist"
        :provider-id="remoteDetailProviderId"
        :item="remoteDetailItem"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import CoverPlay from "@/components/CoverPlay.vue";
import RemoteDetailDialog from "@/components/RemoteDetailDialog.vue";
import { useItemActions } from "@/composables/useItemActions";
import { usePlayContent } from "@/composables/usePlayContent";
import { useEntitySearch, playRemoteCollection } from "@/composables/useEntitySearch";
import { useCardGrid } from "@/composables/useCardGrid";
import { useFavoritesStore } from "@/stores/favorites";
import { coverUrl } from "@/utils/cover";
import api from "@/api";

const router = useRouter();
const { t } = useI18n();
const { openContextMenu, openActionSheet, menuGuard, artistActions } = useItemActions();
const play = usePlayContent();
const fav = useFavoritesStore();

// 远程搜索共享逻辑(本地/插件搜索来源下拉):插件没声明 artistSearch 就不出现在下拉里
const {
  searchMode, searchProviders, remoteItems, remoteSearching, aggregateItems, aggregateSearching,
  isLocalMode, isRemoteMode, isAggregateMode, currentProviderName, currentSourceLabel,
  loadSearchProviders, onSearchSourceCommand, doRemoteSearch, doAggregateSearch,
  setLocalLoader,
} = useEntitySearch("artist");
const searchPlaceholder = computed(() => {
  if (isAggregateMode.value) return t('artists.searchAggAll');
  return isRemoteMode.value ? t('artists.searchRemote', { provider: currentProviderName }) : t('artists.searchPlaceholder');
});
function formatRemoteMeta(item: any) {
  const parts: string[] = [];
  if (item.albumCount) parts.push(t('artists.albumCount', { count: item.albumCount }));
  if (item.songCount) parts.push(t('artists.songCount', { count: item.songCount }));
  return parts.join(" · ");
}

function open(artist: any) {
  if (menuGuard()) return;
  router.push(`/artists/${artist.id}`);
}
async function playAr(artist: any) {
  if (menuGuard()) return;
  const n = await play.playArtist(artist.id);
  if (n) ElMessage.success(t('artists.playing', { name: artist.name, count: n }));
  else ElMessage.warning(t('artists.noPlayable'));
}
async function toggleArtistFav(artist: any) {
  if (menuGuard()) return;
  try {
    const on = await fav.toggleArtistFavorite(artist.id);
    ElMessage.success(on ? t('artists.favorited') : t('artists.unfavorited'));
  } catch {
    ElMessage.error(t('common.operationFailed'));
  }
}

// ===== 远程艺术家:悬浮播放(按名字搜歌,未入库直接播) + 点击头像/名字看详情 =====
const remoteDetailVisible = ref(false);
const remoteDetailItem = ref<any>(null);
const remoteDetailProviderId = ref("");
function openRemote(item: any) {
  if (menuGuard()) return;
  remoteDetailItem.value = item;
  remoteDetailProviderId.value = item.providerId || searchMode.value;
  remoteDetailVisible.value = true;
}
async function playRemoteAr(item: any) {
  if (menuGuard()) return;
  const n = await playRemoteCollection("artist", item.providerId || searchMode.value, item);
  if (n) ElMessage.success(t('artists.playing', { name: item.name, count: n }));
  else ElMessage.warning(t('artists.noPlayable'));
}
// 本地艺术家网格:窗口化分块加载(与 HA 卡片同构),整页展示 + 滚动懒加载 + 越界剪枝。
const cardGrid = useCardGrid<any>(
  async (offset, size) => {
    const page = Math.floor(offset / size) + 1;
    const res = await api.get("/rest/api/v1/artists", {
      params: { page, pageSize: size, query: searchQuery.value },
    });
    return { items: res.data.items || [], total: res.data.total || 0 };
  },
  // 艺术家卡片为「圆形头像(固定120) + 文字」,行高不随卡宽线性变化 → 用固定行高。
  { chunk: 60, keepRows: 120, prefetchBlocks: 2, concurrency: 3, minTileWidth: 160, gap: 18, rowHeight: 212 }
);
const gridEl = cardGrid.gridEl;
const loading = cardGrid.loading;
const total = cardGrid.total;
const frameHeight = cardGrid.frameHeight;
const cardStyle = cardGrid.cardStyle;
const gridViews = computed(() => {
  const start = cardGrid.startIndex.value;
  const end = cardGrid.endIndex.value;
  const arr: { idx: number; item: any }[] = [];
  for (let i = Math.max(0, start); i < end; i++) arr.push({ idx: i, item: cardGrid.list.value[i] });
  return arr;
});
const scraping = ref(false);
const searchQuery = ref("");

// Scrape progress polling
const scrapeProgress = ref<any>(null);
const scrapeRunning = computed(() => scrapeProgress.value?.status === "running");
let scrapeTimer: ReturnType<typeof setInterval> | null = null;
const scrapingMissing = ref(false);
const missingCount = ref(0);

let searchTimer: ReturnType<typeof setTimeout> | null = null;

// 重新拉取本地艺术家(窗口化)。
async function loadArtists() { cardGrid.reload(); }

// Count of artists marked missing-info (shown on the "仅刮削缺失" button)
async function loadMissingCount() {
  try {
    const res = await api.get("/rest/api/v1/artists/missing-info-count");
    missingCount.value = res.data.count || 0;
  } catch { missingCount.value = 0; }
}

// Check scrape job status periodically while running
async function checkScrapeStatus() {
  try {
    const res = await api.get("/rest/api/v1/artists/scrape-status");
    const data = res.data;
    scrapeProgress.value = data;
    if (data.status === "running") {
      if (!scrapeTimer) {
        scrapeTimer = setInterval(checkScrapeStatus, 1500);
      }
    } else {
      if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
      if (data.status === "done" && data.progress) {
        const p = data.progress;
        if (p.status === "done" && p.total > 0) {
          ElMessage.success(t('artists.scrapeDone', { scraped: p.scraped, fallback: p.fallback, skipped: p.skipped }));
          loadArtists();
          loadMissingCount();
        }
      }
    }
  } catch { /* ignore */ }
}

// Manually trigger full scrape for all artists missing avatars (QQ first, NetEase fallback)
async function scrapeArtists() {
  scraping.value = true;
  try {
    const res = await api.post("/rest/api/v1/artists/scrape", {});
    if (res.data.success) {
      if (res.data.total === 0) {
        ElMessage.info(t('artists.scrapeNone'));
        scrapeProgress.value = { status: "done", progress: { status: "done", total: 0, scraped: 0, fallback: 0, skipped: 0 } };
      } else {
        ElMessage.info(t('artists.scrapeStart', { count: res.data.total }));
        scrapeProgress.value = { status: "running", progress: { status: "running", total: res.data.total, processed: 0, scraped: 0, fallback: 0, skipped: 0 } };
        checkScrapeStatus();
      }
    } else {
      ElMessage.error(res.data.error || t('artists.scrapeFailed'));
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t('artists.scrapeFailed'));
  } finally {
    scraping.value = false;
  }
}

// Retry scraping ONLY artists marked as missing-info (replace fallback cover with real avatar when found)
async function scrapeMissingArtists() {
  scrapingMissing.value = true;
  try {
    const res = await api.post("/rest/api/v1/artists/scrape-missing", {});
    if (res.data.success) {
      if (res.data.total === 0) {
        ElMessage.info(t('artists.scrapeNoMissing'));
      } else {
        ElMessage.info(t('artists.scrapeMissingStart', { count: res.data.total }));
        scrapeProgress.value = { status: "running", progress: { status: "running", total: res.data.total, processed: 0, scraped: 0, fallback: 0, skipped: 0 } };
        checkScrapeStatus();
      }
    } else {
      ElMessage.error(res.data.error || t('artists.scrapeFailed'));
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t('artists.scrapeFailed'));
  } finally {
    scrapingMissing.value = false;
  }
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (isAggregateMode.value) { loadArtists(); doAggregateSearch(searchQuery.value); return; }
    if (isRemoteMode.value) doRemoteSearch(searchQuery.value);
    else loadArtists();
  }, 300);
}

function onSearchClear() {
  if (isAggregateMode.value) { loadArtists(); doAggregateSearch(searchQuery.value); return; }
  if (isRemoteMode.value) { doRemoteSearch(searchQuery.value); return; }
  loadArtists();
}

function formatAlbumCount(n: number) {
  if (!n || n <= 0) return '';
  if (n === 1) return t('artists.albumCountOne');
  return t('artists.albumCount', { count: n });
}

// 切换搜索来源:聚合刷新本地+聚合全网;插件立即搜;切回本地由 composable 触发 localLoader
watch(() => searchMode.value, () => {
  if (!searchQuery.value.trim()) return;
  if (isAggregateMode.value) { loadArtists(); doAggregateSearch(searchQuery.value); }
  else if (isRemoteMode.value) doRemoteSearch(searchQuery.value);
});

onMounted(() => {
  setLocalLoader(loadArtists);
  loadSearchProviders();
  loadArtists();
  loadMissingCount();
  checkScrapeStatus();
  nextTick(() => cardGrid.bindGrid());
});

// 首块拉到总数后重算一次可见窗口;之后由滚动驱动。
watch(cardGrid.total, (t) => { if (t > 0) cardGrid.recomputeGrid(); });

// Stop the scrape-progress poll when leaving the page so the 1.5s interval
// doesn't keep running (and issuing requests) in the background.
onUnmounted(() => {
  if (scrapeTimer) { clearInterval(scrapeTimer); scrapeTimer = null; }
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
});
</script>

<style lang="scss" scoped>
.artists-page { padding: 24px 32px 130px; max-width: 1400px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px;
  h2 { font-size: 28px; font-weight: 700; margin: 0; display: flex; align-items: baseline; gap: 14px;
    .song-count { font-size: 14px; color: var(--fnos-text-tertiary); font-weight: 500; }
  }
  .header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
}
.artist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 18px; }
// 本地网格窗口化:固定高度 spacer + 绝对定位虚拟卡片;`.artist-grid`(远程结果)仍走自动 grid。
.artist-grid.virt-grid { display: block; position: relative; width: 100%; }
.artist-grid.virt-grid .artist-card { box-sizing: border-box; }
.artist-card.is-placeholder {
  cursor: default;
  .ph-avatar { width: 120px; height: 120px; border-radius: 50%; margin: 0 auto 12px; background: linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.1) 37%, rgba(255,255,255,0.05) 63%); background-size: 400% 100%; animation: mf-ph 1.2s ease-in-out infinite; }
  .ph-bar { display: block; height: 12px; margin: 5px auto 0; width: 55%; border-radius: 6px; background: rgba(255,255,255,0.08);
    &.short { width: 40%; }
  }
}
@keyframes mf-ph { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
.artist-card {
  cursor: pointer; text-align: center; padding: 16px 12px;
  border-radius: var(--fnos-radius-lg);
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06);
  transition: transform 0.22s ease, background 0.22s ease, box-shadow 0.22s ease;
  animation: home-card-in 0.45s ease backwards;  /* backwards: 动画结束后回退到元素常态（无 transform 残留），both 会保持 translateY(0) 终态形成永久 stacking context，旧 Chromium 上可能穿透 fixed 弹窗 */
  &:hover {
    transform: translateY(-5px);
    background: rgba(255,255,255,0.08);
    box-shadow: 0 14px 34px rgba(0,0,0,0.4);
  }
  &:active { transform: translateY(-2px) scale(0.98); }
  .artist-avatar { position: relative; width: 120px; height: 120px; border-radius: 50%; overflow: hidden; margin: 0 auto 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.45s ease; }
    .avatar-placeholder { width: 100%; height: 100%; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: var(--fnos-text-muted); border-radius: 50%; }
    .missing-tag { position: absolute; top: 4px; right: 4px; }
  }
  &:hover .artist-avatar img { transform: scale(1.06); }
  .artist-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fnos-text-primary); transition: color 0.18s ease; }
  .artist-name:hover { color: var(--fnos-red); }
  .artist-meta { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 5px; min-height: 16px; }
}
.search-label { font-size: 14px; color: var(--fnos-text-secondary); margin-right: 2px; white-space: nowrap; }
.remote-results {
  .remote-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 0; color: var(--fnos-text-tertiary); font-size: 13px; }
  .remote-source-tag {
    position: absolute; top: 6px; right: 6px; z-index: 2;
    padding: 2px 8px; border-radius: 6px; font-size: 11px;
    background: rgba(0,0,0,0.55); color: #fff; backdrop-filter: blur(4px);
  }
}
/* 聚合模式分节标题栏 */
.remote-results.agg {
  margin-top: 24px; padding-top: 20px;
  border-top: 1px solid rgba(255,255,255,0.1);
  .agg-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px;
    .agg-title { font-size: 15px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; color: var(--fnos-text-primary); }
    .agg-meta { font-size: 12px; color: var(--fnos-text-tertiary); }
  }
}
@keyframes home-card-in {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}

@media (max-width: 768px) {
  .artists-page { padding: 20px 16px; }
  .page-header { flex-direction: column; align-items: flex-start; }
  .header-actions { width: 100%; }
  .header-actions .el-input { width: 100% !important; flex: 1; }
  .artist-grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .artist-card { padding: 12px 8px; }
  .artist-card .artist-avatar { width: 100%; max-width: 160px; aspect-ratio: 1; height: auto; }
  .artist-card .artist-name { font-size: 13px; }
}
</style>