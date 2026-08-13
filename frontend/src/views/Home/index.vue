<template>
  <div class="home-page">
    <!-- ===== 顶部：每日推荐 + 本地推荐 + 并排随机歌单 ===== -->
    <section class="section">
      <div class="section-title">
        <span>每日推荐</span>
        <span class="section-sub">为你精选的歌单</span>
        <span class="more" @click="go('/playlists')">查看全部歌单 ›</span>
      </div>

      <div class="top-row">
        <!-- 每日推荐（固定第一张，在线发现：榜单 + 推荐池） -->
        <div
          class="card featured fnos-card-sheen"
          v-if="featured"
          @contextmenu="openContextMenu($event, playlistActions(featured), featured.name, '歌单')"
          v-longpress="() => openActionSheet(playlistActions(featured), featured.name, '歌单')"
        >
          <div class="card-cover-wrap mf-coverwrap" @click="go('/playlists/' + featured.id)">
            <img v-if="featured.coverArt" :src="cover(featured.coverArt)" class="card-cover" loading="lazy" decoding="async" />
            <div v-else class="card-cover-ph"><MfIcon name="Headphones" :size="48"  /></div>
            <span class="badge">每日推荐</span>
            <CoverPlay size="lg" :label="`播放 ${featured.name}`" :action="() => playPl(featured)" />
          </div>
          <div class="card-body" @click="go(`/playlists/${featured.id}`)">
            <div class="card-title">{{ featured.name }}</div>
            <div class="card-sub">{{ featured.songCount ? featured.songCount + ' 首' : '歌单' }}</div>
          </div>
        </div>

        <!-- 本地推荐（固定第二张，本地口味/参考歌单） -->
        <div
          class="card fnos-card-sheen"
          v-if="featuredLocal"
          @contextmenu="openContextMenu($event, playlistActions(featuredLocal), featuredLocal.name, '歌单')"
          v-longpress="() => openActionSheet(playlistActions(featuredLocal), featuredLocal.name, '歌单')"
        >
          <div class="card-cover-wrap mf-coverwrap" @click="go('/playlists/' + featuredLocal.id)">
            <img v-if="featuredLocal.coverArt" :src="cover(featuredLocal.coverArt)" class="card-cover" loading="lazy" decoding="async" />
            <div v-else class="card-cover-ph"><MfIcon name="Headphones" :size="32"  /></div>
            <span class="badge badge-local">本地推荐</span>
            <CoverPlay size="md" :label="`播放 ${featuredLocal.name}`" :action="() => playPl(featuredLocal)" />
          </div>
          <div class="card-body" @click="go(`/playlists/${featuredLocal.id}`)">
            <div class="card-title">{{ featuredLocal.name }}</div>
            <div class="card-sub">{{ featuredLocal.songCount ? featuredLocal.songCount + ' 首' : '歌单' }}</div>
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

        <!-- 占位（无数据时，按 homeCount 补齐） -->
        <div v-for="n in placeholderHomeCount()" :key="'ph-pl-' + n" class="card placeholder fnos-shimmer">
          <div class="card-cover-wrap"><div class="card-cover-ph"></div></div>
          <div class="card-body"><div class="sk-line"></div><div class="sk-line short"></div></div>
        </div>
      </div>
    </section>

    <!-- 平台精选加载失败提示 -->
    <div v-if="recommendError && platformGroups.length === 0" class="recommend-error">
      <MfIcon name="TriangleAlert" :size="16" /> 平台精选加载失败，请检查 go-music-dl 插件是否已启用并配置服务地址
    </div>

    <!-- ===== 各平台精选（go-music-dl recommend 能力输出，每平台数量由插件配置） ===== -->
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
        >
          <div class="card-cover-wrap mf-coverwrap" @click="playRemotePl(group, pl)">
            <img v-if="pl.cover" :src="pl.cover" class="card-cover" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            <div v-else class="card-cover-ph"><MfIcon name="Headphones" :size="28" /></div>
            <PlatformBadge :source="group.source" />
            <CoverPlay size="md" :label="`播放 ${pl.name}`" :action="() => playRemotePl(group, pl)" />
          </div>
          <div class="card-body" @click="playRemotePl(group, pl)">
            <div class="card-title">{{ pl.name }}</div>
            <div class="card-sub">{{ pl.trackCount ? pl.trackCount + ' 首' : '歌单' }}</div>
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
// 平台精选：由启用的 recommend 能力插件提供(如 go-music-dl /music/recommend)，
// 每平台歌单数由插件配置 homeCount 控制，核心透传。
const recommendChannels = ref<any[]>([]);
const recommendProviderId = ref("");
const recommendError = ref(false);
const importingId = ref("");
// 首页顶部展示张数(含每日推荐+本地推荐两张固定),由每日推荐插件配置 homeCount 控制(默认 8)。
const homeCount = ref(8);

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

// 每日推荐：daily-recommend 插件生成（在线发现：榜单 + 推荐池），固定第一张；
// 先决条件：必须匹配到本地库歌曲数 > 30 首才展示（不足 30 首不显示）。
const featured = computed(() =>
  playlists.value.find((p) => p.name === "每日推荐" && (p.songCount || 0) > 30) || null
);
// 本地推荐：local-recommend 插件生成（本地口味/参考歌单），固定第二张（同样 >30 首原则）。
const featuredLocal = computed(() =>
  playlists.value.find((p) => p.name === "本地推荐" && (p.songCount || 0) > 30) || null
);
// 并排随机：从全部歌单里随机抽（排除两张固定推荐；只抽音乐 ≥30 首的歌单），
// 与两张固定推荐合并成 homeCount 张等大卡片（默认 8，桌面 4 列 × 2 行）。
const sidePlaylists = computed(() => {
  const fixedIds = new Set<string>();
  if (featured.value) fixedIds.add(featured.value.id);
  if (featuredLocal.value) fixedIds.add(featuredLocal.value.id);
  const pool = playlists.value.filter(
    (p) => !fixedIds.has(p.id) && (p.songCount || 0) >= 30
  );
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.max(0, homeCount.value - fixedIds.size));
});

// 各平台精选：直接渲染 recommend 能力插件的输出（每个 channel = 一个平台分区）。
// 每平台歌单数已在插件内部按 homeCount 截断，前端不再写死 slice 数量。
const platformGroups = computed(() =>
  recommendChannels.value
    .map((ch: any) => ({
      source: ch.source || "",
      name: (ch.name || ch.source || "").replace(/音乐$/, ""),
      playlists: ch.playlists || [],
    }))
    .filter((g) => g.playlists.length > 0)
);

// 平台精选卡片：导入为本地歌单后播放（复用现有 recommend/import 接口）。
async function playRemotePl(group: any, pl: any) {
  if (menuGuard() || !pl || !recommendProviderId.value) return;
  importingId.value = pl.id;
  try {
    const res = await api.post(`/rest/api/v1/online/${recommendProviderId.value}/recommend/import`, {
      source: pl.source || group.source,
      id: pl.id,
      name: pl.name,
      cover: pl.cover || "",
      creator: pl.creator || "",
      trackCount: pl.trackCount || "",
      link: pl.link || "",
    });
    if (res.data?.playlistId) {
      const n = await play.playPlaylist(res.data.playlistId);
      if (n) ElMessage.success(`正在播放「${pl.name}」`);
      else ElMessage.warning("导入成功，但该歌单暂无可播放歌曲");
    } else {
      ElMessage.warning(res.data?.message || "导入失败");
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || e.message || "导入失败");
  } finally {
    importingId.value = "";
  }
}

// 无数据时补齐占位卡，保证版式可见（平台分区用）
function placeholderCount(featuredItem: any, list: any[], want: number) {
  const real = (featuredItem ? 1 : 0) + (list ? list.length : 0);
  const need = Math.max(0, want - real);
  return Array.from({ length: need }, (_, i) => i + 1);
}

// 首页顶部占位：按 homeCount 补齐（含两张固定推荐：每日推荐 + 本地推荐）
function placeholderHomeCount() {
  const fixed = (featured.value ? 1 : 0) + (featuredLocal.value ? 1 : 0);
  const real = fixed + sidePlaylists.value.length;
  const need = Math.max(0, homeCount.value - real);
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

async function loadHomeConfig() {
  try {
    const res = await api.get("/rest/api/v1/home/playlist-count");
    const n = parseInt(String(res.data?.count), 10);
    if (Number.isFinite(n) && n >= 1 && n <= 24) homeCount.value = n;
  } catch {
    /* 保持默认 8 */
  }
}

async function loadRecommend() {
  try {
    const res = await api.get("/rest/api/v1/recommend");
    recommendChannels.value = res.data.channels || [];
    recommendProviderId.value = res.data.providerId || "";
    recommendError.value = false;
  } catch {
    recommendChannels.value = [];
    recommendProviderId.value = "";
    recommendError.value = true;
  }
}

onMounted(async () => {
  loading.value = true;
  await Promise.all([loadPlaylists(), loadRecommend(), loadHomeConfig()]);
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
.recommend-error {
  display: flex; align-items: center; gap: 6px;
  margin: -18px 0 18px; padding: 10px 14px;
  font-size: 13px; color: var(--fnos-orange);
  background: rgba(255, 165, 0, 0.08); border: 1px solid rgba(255, 165, 0, 0.25);
  border-radius: 8px;
}
.section-title {
  display: flex; align-items: baseline; gap: 12px;
  font-size: 20px; font-weight: 700; margin-bottom: 16px;
  .section-sub { font-size: 13px; font-weight: 400; color: var(--fnos-text-tertiary); }
  .more { margin-left: auto; font-size: 13px; font-weight: 400; color: var(--fnos-text-secondary); cursor: pointer; }
  .more:hover { color: var(--fnos-red); }
}

/* 顶部：每日推荐 + 本地推荐固定，其余随机，全部等大（桌面 4 列 × 2 行 = 8 张） */
.top-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
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
.badge-local {
  background: var(--fnos-blue);
  box-shadow: 0 4px 12px rgba(27, 115, 251, 0.5);
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
  /* 平板：8 张等大卡 3 列换行（3+3+2，占位补满） */
  .top-row { grid-template-columns: repeat(3, 1fr); grid-auto-rows: auto; }
  .grid-row { grid-template-columns: repeat(3, 1fr); }
}
@media (max-width: 768px) {
  /* .main-scroll 已提供 88px 底部安全区，这里不再叠加 */
  .home-page { padding: 18px 16px 20px; }
  .section { margin-bottom: 28px; }
  .section-title { font-size: 18px; margin-bottom: 12px; }
  /* 移动端：8 张等大卡 2 列（4 行），正好铺满 */
  .top-row { grid-template-columns: repeat(2, 1fr); gap: 12px; grid-auto-rows: auto; }
  .grid-row { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .card-body { padding: 8px 10px 10px; }
  .card-title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-sub { font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: 11px; padding: 2px 8px; }
}
</style>
