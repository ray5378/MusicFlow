<template>
  <div class="home-page">
    <!-- ===== 顶部：今日推荐歌单 + 并排随机歌单 ===== -->
    <section class="section">
      <div class="section-title">
        <span>今日推荐</span>
        <span class="section-sub">为你精选的歌单</span>
        <span class="more" @click="go('/playlists')">查看全部歌单 ›</span>
      </div>

      <div class="top-row">
        <!-- 今日推荐（大卡） -->
        <div
          class="card featured fnos-card-sheen"
          v-if="featured"
          @contextmenu="openContextMenu($event, playlistActions(featured), featured.name, '歌单')"
          v-longpress="() => openActionSheet(playlistActions(featured), featured.name, '歌单')"
        >
          <div class="card-cover-wrap mf-coverwrap" @click="playPl(featured)">
            <img v-if="featured.coverArt" :src="cover(featured.coverArt)" class="card-cover" />
            <div v-else class="card-cover-ph"><MfIcon name="Headphones" :size="48"  /></div>
            <span class="badge">今日推荐</span>
            <CoverPlay size="lg" :label="`播放 ${featured.name}`" :action="() => playPl(featured)" />
          </div>
          <div class="card-body" @click="go(`/playlists/${featured.id}`)">
            <div class="card-title">{{ featured.name }}</div>
            <div class="card-sub">{{ featured.songCount ? featured.songCount + ' 首' : '歌单' }}</div>
          </div>
        </div>

        <!-- 并排随机抽取的歌单 -->
        <div
          v-for="(pl, idx) in sidePlaylists"
          :key="pl.id"
          class="card fnos-card-sheen"
          :style="{ '--stagger': idx + 1 }"
          @contextmenu="openContextMenu($event, playlistActions(pl), pl.name, '歌单')"
          v-longpress="() => openActionSheet(playlistActions(pl), pl.name, '歌单')"
        >
          <div class="card-cover-wrap mf-coverwrap" @click="playPl(pl)">
            <img v-if="pl.coverArt" :src="cover(pl.coverArt)" class="card-cover" />
            <div v-else class="card-cover-ph"><MfIcon name="Headphones" :size="32"  /></div>
            <CoverPlay size="md" :label="`播放 ${pl.name}`" :action="() => playPl(pl)" />
          </div>
          <div class="card-body" @click="go(`/playlists/${pl.id}`)">
            <div class="card-title">{{ pl.name }}</div>
            <div class="card-sub">{{ pl.songCount ? pl.songCount + ' 首' : '歌单' }}</div>
          </div>
        </div>

        <!-- 占位（无数据时） -->
        <div v-for="n in placeholderCount(featured, sidePlaylists, 7)" :key="'ph-pl-' + n" class="card placeholder fnos-shimmer">
          <div class="card-cover-wrap"><div class="card-cover-ph"></div></div>
          <div class="card-body"><div class="sk-line"></div><div class="sk-line short"></div></div>
        </div>
      </div>
    </section>

    <!-- ===== 中间：随机专辑 ===== -->
    <section class="section">
      <div class="section-title">
        <span>随机专辑</span>
        <span class="section-sub">随便听听</span>
        <span class="more" @click="go('/albums')">查看全部专辑 ›</span>
      </div>
      <div class="grid-row">
        <div
          v-for="(al, idx) in randomAlbums"
          :key="al.id"
          class="card fnos-card-sheen"
          :style="{ '--stagger': idx }"
          @contextmenu="openContextMenu($event, albumActions(al), al.name || al.title, al.artist || '专辑')"
          v-longpress="() => openActionSheet(albumActions(al), al.name || al.title, al.artist || '专辑')"
        >
          <div class="card-cover-wrap mf-coverwrap" @click="playAl(al)">
            <img v-if="al.coverArt" :src="cover(al.coverArt)" class="card-cover" />
            <div v-else class="card-cover-ph"><MfIcon name="Disc3" :size="28"  /></div>
            <CoverPlay size="md" :label="`播放 ${al.name || al.title}`" :action="() => playAl(al)" />
          </div>
          <div class="card-body" @click="go(`/albums/${al.id}`)">
            <div class="card-title">{{ al.name || al.title }}</div>
            <div class="card-sub">{{ al.artist || '' }}</div>
          </div>
        </div>
        <div v-for="n in placeholderCount(null, randomAlbums, 8)" :key="'ph-al-' + n" class="card placeholder fnos-shimmer">
          <div class="card-cover-wrap"><div class="card-cover-ph"></div></div>
          <div class="card-body"><div class="sk-line"></div><div class="sk-line short"></div></div>
        </div>
      </div>
    </section>

    <!-- ===== 底部：快捷方式 ===== -->
    <section class="section">
      <div class="section-title"><span>快捷方式</span></div>
      <div class="shortcut-row">
        <div class="shortcut fnos-reveal" :style="{ '--stagger': 0 }" @click="go('/favorites')">
          <div class="shortcut-icon fav"><MfIcon name="Heart" :filled="true" :size="22" /></div>
          <div class="shortcut-text">
            <div class="shortcut-title">我喜欢的音乐</div>
            <div class="shortcut-sub">你收藏的宝藏</div>
          </div>
        </div>
        <div class="shortcut fnos-reveal" :style="{ '--stagger': 1 }" @click="go('/history')">
          <div class="shortcut-icon hist"><MfIcon name="Clock" :size="22"  /></div>
          <div class="shortcut-text">
            <div class="shortcut-title">播放历史</div>
            <div class="shortcut-sub">最近听过的歌</div>
          </div>
        </div>
        <div class="shortcut fnos-reveal" :style="{ '--stagger': 2 }" @click="go('/songs')">
          <div class="shortcut-icon added"><MfIcon name="Plus" :size="22"  /></div>
          <div class="shortcut-text">
            <div class="shortcut-title">最近添加</div>
            <div class="shortcut-sub">最近新加入的歌</div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import api from "@/api";
import { ElMessage } from "element-plus";
import CoverPlay from "@/components/CoverPlay.vue";
import { useItemActions } from "@/composables/useItemActions";
import { usePlayContent } from "@/composables/usePlayContent";

const router = useRouter();
const {
  openContextMenu, openActionSheet, menuGuard,
  playlistActions, albumActions,
} = useItemActions();
const play = usePlayContent();

const playlists = ref<any[]>([]);
const recommendedIds = ref<Set<string>>(new Set());
const albums = ref<any[]>([]);
const loading = ref(false);

function cover(id: string) {
  return `/rest/getCoverArt?id=${id}&size=300`;
}
function go(path: string) {
  if (menuGuard()) return;
  router.push(path);
}

/** 封面点击：直接播放整张歌单 */
async function playPl(pl: any) {
  if (menuGuard() || !pl) return;
  const n = await play.playPlaylist(pl.id);
  if (n) ElMessage.success(`正在播放「${pl.name}」`);
  else ElMessage.warning("该歌单暂无可播放歌曲");
}
/** 封面点击：直接播放整张专辑 */
async function playAl(al: any) {
  if (menuGuard() || !al) return;
  const n = await play.playAlbum(al.id);
  if (n) ElMessage.success(`正在播放「${al.name || al.title}」`);
  else ElMessage.warning("该专辑暂无可播放歌曲");
}

// 今日推荐：优先取推荐池中的歌单，否则取列表第一个
const featured = computed(() => {
  const rec = playlists.value.find((p) => recommendedIds.value.has(p.id));
  return rec || playlists.value[0] || null;
});
// 并排随机：从全部歌单里随机抽 6 张（排除今日推荐大卡）
// 桌面 = 1 大 + 6 小（3 列 × 2 行）；移动端由 CSS 截断到 1 大 + 4 小
const sidePlaylists = computed(() => {
  const pool = playlists.value.filter((p) => p.id !== (featured.value && featured.value.id));
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 6);
});
// 随机专辑：洗牌后取前 8
const randomAlbums = computed(() => {
  const shuffled = [...albums.value].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 8);
});

// 无数据时补齐占位卡，保证版式可见
function placeholderCount(featuredItem: any, list: any[], want: number) {
  const real = (featuredItem ? 1 : 0) + (list ? list.length : 0);
  const need = Math.max(0, want - real);
  return Array.from({ length: need }, (_, i) => i + 1);
}

async function loadPlaylists() {
  try {
    const res = await api.get("/rest/api/v1/playlists", { params: { page: 1, pageSize: 30 } });
    playlists.value = res.data.items || [];
  } catch {
    playlists.value = [];
  }
}
async function loadPool() {
  try {
    const res = await api.get("/rest/api/v1/recommend-pool");
    const pool = res.data.pool || [];
    recommendedIds.value = new Set(pool.filter((p: any) => p.source_type === "playlist").map((p: any) => p.source_id));
  } catch {
    recommendedIds.value = new Set();
  }
}
async function loadAlbums() {
  try {
    const res = await api.get("/rest/api/v1/albums", { params: { page: 1, pageSize: 30 } });
    albums.value = res.data.items || [];
  } catch {
    albums.value = [];
  }
}

onMounted(async () => {
  loading.value = true;
  await Promise.all([loadPlaylists(), loadPool(), loadAlbums()]);
  loading.value = false;
});
</script>

<style lang="scss" scoped>
.home-page {
  padding: 28px 32px 130px;
  max-width: 1280px;
  margin: 0 auto;
}
.section { margin-bottom: 38px; }
.section-title {
  display: flex; align-items: baseline; gap: 12px;
  font-size: 20px; font-weight: 700; margin-bottom: 16px;
  .section-sub { font-size: 13px; font-weight: 400; color: var(--fnos-text-tertiary); }
  .more { margin-left: auto; font-size: 13px; font-weight: 400; color: var(--fnos-text-secondary); cursor: pointer; }
  .more:hover { color: var(--fnos-red); }
}

/* 顶部：今日推荐大卡 + 并排随机歌单 */
.top-row {
  display: grid;
  grid-template-columns: 1.6fr 1fr 1fr 1fr;
  grid-auto-rows: 1fr;
  gap: 16px;
}
.card {
  border-radius: var(--fnos-radius-lg);
  overflow: hidden;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  cursor: pointer;
  transition: transform 0.22s ease, box-shadow 0.22s ease, background 0.22s ease;
  display: flex; flex-direction: column;
  animation: home-card-in 0.45s ease both;
  animation-delay: calc(var(--stagger, 0) * 60ms);
  &:hover {
    transform: translateY(-5px);
    background: rgba(255, 255, 255, 0.08);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
    .card-cover { transform: scale(1.06); }
  }
  &:active { transform: translateY(-2px) scale(0.98); }
  &.featured { grid-row: span 2; }
}
@keyframes home-card-in {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}
.card-cover-wrap { position: relative; overflow: hidden; border-radius: var(--fnos-radius-lg) var(--fnos-radius-lg) 0 0; }
.card-cover { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; transition: transform 0.5s ease; }
.card-cover-ph {
  width: 100%; aspect-ratio: 1;
  background: linear-gradient(135deg, rgba(246, 44, 85, 0.32), rgba(27, 115, 251, 0.30));
  display: flex; align-items: center; justify-content: center;
  color: rgba(255, 255, 255, 0.55);
}
.badge {
  position: absolute; top: 10px; left: 10px;
  background: var(--fnos-red); color: #fff;
  font-size: 12px; font-weight: 600;
  padding: 3px 10px; border-radius: 999px;
  box-shadow: 0 4px 12px rgba(246, 44, 85, 0.5);
}
.card-cover-wrap { cursor: pointer; }
.card-body { padding: 10px 12px 12px; cursor: pointer; }
.card-body:hover .card-title { color: var(--fnos-red); }
.card-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 0.18s ease; }
.card-sub { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 占位骨架 */
.card.placeholder { cursor: default; &:hover { transform: none; box-shadow: none; background: rgba(255,255,255,0.05); } }
.sk-line { height: 10px; border-radius: 6px; background: rgba(255, 255, 255, 0.08); margin-bottom: 7px; }
.sk-line.short { width: 55%; }

/* 中间：随机专辑（横向网格，可换行） */
.grid-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

/* 底部：快捷方式 */
.shortcut-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
.shortcut {
  display: flex; align-items: center; gap: 14px;
  padding: 18px 20px;
  border-radius: var(--fnos-radius-lg);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  cursor: pointer;
  transition: transform 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
  animation: home-card-in 0.45s ease both;
  animation-delay: calc(var(--stagger, 0) * 80ms + 200ms);
  &:hover { transform: translateY(-4px); background: rgba(255, 255, 255, 0.08); box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4); }
  &:active { transform: translateY(-1px) scale(0.98); }
  .shortcut-icon {
    width: 46px; height: 46px; border-radius: 13px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; color: #fff;
    /* 统一图标视觉中心 */
    line-height: 1;
    > * { display: flex; align-items: center; justify-content: center; }
  }
  .shortcut-icon.fav { background: linear-gradient(135deg, #f62c55, #c934e1); }
  .shortcut-icon.hist { background: linear-gradient(135deg, #1b73fb, #16a34a); }
  .shortcut-icon.added { background: linear-gradient(135deg, #f8bf28, #fc5e25); }
  .shortcut-title { font-size: 15px; font-weight: 600; }
  .shortcut-sub { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 2px; }
}

@media (max-width: 1100px) {
  /* 平板：1 大（通栏）+ 4 小；行高改为自适应，避免小卡被大卡撑高 */
  .top-row { grid-template-columns: 1fr 1fr; grid-auto-rows: auto; }
  .card.featured { grid-column: span 2; grid-row: auto; }
  .top-row > *:nth-child(n + 6) { display: none; }
  .grid-row { grid-template-columns: repeat(3, 1fr); }
}
@media (max-width: 768px) {
  /* .main-scroll 已提供 88px 底部安全区，这里不再叠加 */
  .home-page { padding: 18px 16px 20px; }
  .section { margin-bottom: 28px; }
  .section-title { font-size: 18px; margin-bottom: 12px; }
  /* 移动端：1 大 + 4 小，正好铺满 2×2 */
  .top-row { grid-template-columns: 1fr 1fr; gap: 12px; grid-auto-rows: auto; }
  .card.featured { grid-column: span 2; grid-row: auto; }
  .top-row > *:nth-child(n + 6) { display: none; }
  .grid-row { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .shortcut-row { grid-template-columns: 1fr; gap: 10px; }
  .card-body { padding: 8px 10px 10px; }
  .card-title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-sub { font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .shortcut { padding: 14px 16px; }
  .badge { font-size: 11px; padding: 2px 8px; }
}
</style>
