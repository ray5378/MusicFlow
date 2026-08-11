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
          <div class="card-cover-wrap mf-coverwrap" @click="go('/playlists/' + featured.id)">
            <img v-if="featured.coverArt" :src="cover(featured.coverArt)" class="card-cover" loading="lazy" decoding="async" />
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
          <div class="card-cover-wrap mf-coverwrap" @click="go('/playlists/' + pl.id)">
            <img v-if="pl.coverArt" :src="cover(pl.coverArt)" class="card-cover" loading="lazy" decoding="async" />
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

    <!-- ===== 各平台精选歌单 ===== -->
    <section class="section" v-for="group in platformGroups" :key="group.source">
      <div class="section-title">
        <span>{{ group.name }}精选</span>
        <span class="section-sub">为你精选的 {{ group.name }} 歌单</span>
        <span class="more" @click="go('/playlists')">查看全部歌单 ›</span>
      </div>
      <div class="grid-row">
        <div
          v-for="pl in group.playlists"
          :key="pl.id"
          class="card fnos-card-sheen"
          @contextmenu="openContextMenu($event, playlistActions(pl), pl.name, '歌单')"
          v-longpress="() => openActionSheet(playlistActions(pl), pl.name, '歌单')"
        >
          <div class="card-cover-wrap mf-coverwrap" @click="go('/playlists/' + pl.id)">
            <img v-if="pl.coverArt" :src="cover(pl.coverArt)" class="card-cover" loading="lazy" decoding="async" />
            <div v-else class="card-cover-ph"><MfIcon name="Headphones" :size="28"  /></div>
            <PlatformBadge :source="group.source" />
            <CoverPlay size="md" :label="`播放 ${pl.name}`" :action="() => playPl(pl)" />
          </div>
          <div class="card-body" @click="go(`/playlists/${pl.id}`)">
            <div class="card-title">{{ pl.name }}</div>
            <div class="card-sub">{{ pl.songCount ? pl.songCount + ' 首' : '歌单' }}</div>
          </div>
        </div>
        <div v-for="n in placeholderCount(null, group.playlists, 6)" :key="'ph-' + group.source + '-' + n" class="card placeholder fnos-shimmer">
          <div class="card-cover-wrap"><div class="card-cover-ph"></div></div>
          <div class="card-body"><div class="sk-line"></div><div class="sk-line short"></div></div>
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
import { coverUrl } from "@/utils/cover";

const router = useRouter();
const {
  openContextMenu, openActionSheet, menuGuard,
  playlistActions,
} = useItemActions();
const play = usePlayContent();

const playlists = ref<any[]>([]);
const loading = ref(false);

function cover(id: string) {
  return coverUrl(id);
}
function go(path: string) {
  if (menuGuard()) return;
  router.push(path);
}

/** CoverPlay 悬浮按钮：播放整张歌单 */
async function playPl(pl: any) {
  if (menuGuard() || !pl) return;
  const n = await play.playPlaylist(pl.id);
  if (n) ElMessage.success(`正在播放「${pl.name}」`);
  else ElMessage.warning("该歌单暂无可播放歌曲");
}

// 今日推荐：固定为后端每日自动生成的名为「今日推荐」的歌单，
// 先决条件：必须匹配到本地库歌曲数 > 30 首才作为今日推荐展示（不足 30 首不显示大卡）
const featured = computed(() =>
  playlists.value.find((p) => p.name === "今日推荐" && (p.songCount || 0) > 30) || null
);
// 并排随机：从全部歌单里随机抽 6 张（排除今日推荐大卡；只抽音乐 ≥30 首的歌单）
// 桌面 = 1 大 + 6 小（3 列 × 2 行）；移动端由 CSS 截断到 1 大 + 4 小
const sidePlaylists = computed(() => {
  const pool = playlists.value.filter(
    (p) => p.id !== (featured.value && featured.value.id) && (p.songCount || 0) >= 30
  );
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 6);
});

// 各平台精选：按 sourcePlatform 分组，每个平台随机抽 6 张歌单在首页分类展示
//（只抽音乐 ≥30 首的歌单）。
const PLATFORM_META: Array<{ source: string; name: string }> = [
  { source: "netease", name: "网易云" },
  { source: "qq", name: "QQ音乐" },
  { source: "kugou", name: "酷狗" },
  { source: "kuwo", name: "酷我" },
];
const platformGroups = computed(() =>
  PLATFORM_META.map((meta) => {
    const pool = playlists.value.filter(
      (p) => (p.sourcePlatform || "") === meta.source && (p.songCount || 0) >= 30
    );
    return {
      ...meta,
      playlists: [...pool].sort(() => Math.random() - 0.5).slice(0, 6),
    };
  }).filter((g) => g.playlists.length > 0)
);

// 无数据时补齐占位卡，保证版式可见
function placeholderCount(featuredItem: any, list: any[], want: number) {
  const real = (featuredItem ? 1 : 0) + (list ? list.length : 0);
  const need = Math.max(0, want - real);
  return Array.from({ length: need }, (_, i) => i + 1);
}

async function loadPlaylists() {
  try {
    // 拉全量歌单(含各平台导入歌单)以便按平台分组;后台每日同步会产生 60+ 平台歌单。
    const res = await api.get("/rest/api/v1/playlists", { params: { page: 1, pageSize: 200 } });
    playlists.value = res.data.items || [];
    // 首页无专辑区块,不再拉专辑。
  } catch {
    playlists.value = [];
  }
}

onMounted(async () => {
  loading.value = true;
  await loadPlaylists();
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
  animation: home-card-in 0.45s ease backwards;  /* backwards: 动画结束后回退到元素常态（无 transform 残留），both 会保持 translateY(0) 终态形成永久 stacking context，旧 Chromium 上可能穿透 fixed 弹窗 */
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
.card-cover-wrap { position: relative; overflow: hidden; border-radius: var(--fnos-radius-lg) var(--fnos-radius-lg) 0 0; background: rgba(255,255,255,0.04); }
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
  .card-body { padding: 8px 10px 10px; }
  .card-title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-sub { font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: 11px; padding: 2px 8px; }
}
</style>
