<template>
  <div class="home-page">
    <!-- ===== 顶部：首页固定推荐卡(插件自治) + 并排随机歌单 ===== -->
    <section class="section">
      <div class="section-title">
        <span>{{ t('home.forYou') }}</span>
        <span class="section-sub">{{ t('home.fixedPlaylists') }}</span>
        <span class="more" @click="go('/playlists?filter=favorite')">{{ t('home.viewFavPlaylists') }} ›</span>
      </div>

      <div class="top-row">
        <!-- 固定推荐卡：由各推荐插件配置 showOnHome + homePosition 决定(按位次排序)。
             今日漫游(combo 能力)卡片带刷新按钮。 -->
        <div
          v-for="(card, idx) in fixedCards"
          :key="card.pluginId"
          class="card fnos-card-sheen"
          :style="{ '--stagger': idx + 1 }"
          @contextmenu="openContextMenu($event, playlistActions(card), card.playlistName, t('home.playlist'))"
          v-longpress="() => openActionSheet(playlistActions(card), card.playlistName, t('home.playlist'))"
        >
          <div class="card-cover-wrap mf-coverwrap" @click="go('/playlists/' + card.playlistId)">
            <img v-if="card.coverArt" :src="cover(card.coverArt)" class="card-cover" loading="lazy" decoding="async" />
            <div v-else class="card-cover-ph"><MfIcon name="Headphones" :size="32"  /></div>
            <span class="badge">{{ card.playlistName || card.name }}</span>
            <CoverPlay size="md" :label="t('home.play', { name: card.playlistName })" :action="() => playPl(card)" />
            <button
              v-if="card.isCombo"
              class="refresh-btn"
              :title="t('home.refreshRoamTitle')"
              :disabled="refreshing"
              @click.stop="refreshRoam"
            >
              <MfIcon name="RefreshCw" :size="16" :class="{ spinning: refreshing }" />
            </button>
          </div>
          <div class="card-body" @click="go(`/playlists/${card.playlistId}`)">
            <div class="card-title">{{ card.playlistName || card.name }}</div>
            <div class="card-sub">{{ card.songCount ? t('home.trackCount', { count: card.songCount }) : t('home.playlist') }}</div>
          </div>
        </div>

        <!-- 并排随机抽取的歌单 -->
        <div
          v-for="(pl, idx) in sidePlaylists"
          :key="pl.id"
          class="card fnos-card-sheen"
          :style="{ '--stagger': idx + 1 }"
          @contextmenu="openContextMenu($event, playlistActions(pl), pl.name, t('home.playlist'))"
          v-longpress="() => openActionSheet(playlistActions(pl), pl.name, t('home.playlist'))"
        >
          <div class="card-cover-wrap mf-coverwrap" @click="go('/playlists/' + pl.id)">
            <img v-if="pl.coverArt" :src="cover(pl.coverArt)" class="card-cover" loading="lazy" decoding="async" />
            <div v-else class="card-cover-ph"><MfIcon name="Headphones" :size="32"  /></div>
            <CoverPlay size="md" :label="t('home.play', { name: pl.name })" :action="() => playPl(pl)" />
          </div>
          <div class="card-body" @click="go(`/playlists/${pl.id}`)">
            <div class="card-title">{{ pl.name }}</div>
            <div class="card-sub">{{ pl.songCount ? t('home.trackCount', { count: pl.songCount }) : t('home.playlist') }}</div>
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
      <MfIcon name="TriangleAlert" :size="16" /> {{ t('home.recommendError') }}
    </div>

    <!-- ===== 首页推荐分区（按 sortOrder 排序，go-music-dl 推荐 + 本地随机混合排列） ===== -->
    <section class="section" v-for="group in sortedAllGroups" :key="group.type + '-' + group.source + '-' + (group._pluginId || '')">
      <template v-if="group.type === 'recommend'">
        <div class="section-title">
          <span>{{ group.name }}{{ t('home.featured') }}</span>
          <span class="section-sub">{{ t('home.forYouSub', { name: group.name }) }}</span>
          <span class="more" @click="go('/playlists?filter=' + encodeURIComponent(group.source))">{{ t('home.viewGroupPlaylists', { name: group.name }) }} ›</span>
        </div>
        <div class="grid-row">
          <div
            v-for="pl in group.playlists"
            :key="pl.id"
            class="card fnos-card-sheen"
          >
            <div class="card-cover-wrap mf-coverwrap" @click="pl.imported ? playPl(pl) : playRemotePl(group, pl)">
              <img v-if="pl.cover" :src="pl.cover" class="card-cover" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
              <div v-else class="card-cover-ph"><MfIcon name="Headphones" :size="28" /></div>
              <PlatformBadge :source="group.source" />
              <CoverPlay size="md" :label="t('home.play', { name: pl.name })" :action="() => pl.imported ? playPl(pl) : playRemotePl(group, pl)" />
            </div>
            <div class="card-body" @click="pl.imported ? playPl(pl) : playRemotePl(group, pl)">
              <div class="card-title">{{ pl.name }}</div>
              <div class="card-sub">{{ pl.trackCount ? t('home.trackCount', { count: pl.trackCount }) : t('home.playlist') }}</div>
            </div>
          </div>
          <div v-for="n in placeholderCount(null, group.playlists, 6)" :key="'ph-' + group.source + '-' + (group._pluginId || '') + '-' + n" class="card placeholder fnos-shimmer">
            <div class="card-cover-wrap"><div class="card-cover-ph"></div></div>
            <div class="card-body"><div class="sk-line"></div><div class="sk-line short"></div></div>
          </div>
        </div>
      </template>
      <template v-else>
        <div class="section-title">
          <span>{{ group.subtag ? group.name + '·' + group.subtag : group.name + '·' + t('home.localRandom') }}</span>
          <span v-if="group.tagline" class="section-sub">{{ group.tagline }}</span>
          <span class="more" @click="go('/playlists?filter=' + encodeURIComponent(group.source))">{{ t('home.viewGroupPlaylists', { name: group.name }) }} ›</span>
        </div>
        <div class="grid-row">
          <div
            v-for="pl in group.playlists"
            :key="'lr-' + group.source + '-' + pl.id"
            class="card fnos-card-sheen"
          >
            <div class="card-cover-wrap mf-coverwrap" @click="go('/playlists/' + pl.id)">
              <img v-if="pl.coverArt" :src="cover(pl.coverArt)" class="card-cover" loading="lazy" decoding="async" />
              <div v-else class="card-cover-ph"><MfIcon name="Headphones" :size="28" /></div>
              <PlatformBadge :source="group.source" />
              <CoverPlay size="md" :label="t('home.play', { name: pl.name })" :action="() => playPl(pl)" />
            </div>
            <div class="card-body" @click="go('/playlists/' + pl.id)">
              <div class="card-title">{{ pl.name }}</div>
              <div class="card-sub">{{ pl.songCount ? t('home.trackCount', { count: pl.songCount }) : t('home.playlist') }}</div>
            </div>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import api, { formatApiError } from "@/api";
import { waitAsyncTask } from "@/utils/asyncTask";
import { ElMessage } from "element-plus";
import CoverPlay from "@/components/CoverPlay.vue";
import { useItemActions } from "@/composables/useItemActions";
import { usePlayContent } from "@/composables/usePlayContent";
import { coverUrl } from "@/utils/cover";

const { t } = useI18n();
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
// 首页顶部展示张数(含今日漫游固定卡),由每日推荐插件配置 homeCount 控制(默认 8)。
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
  if (n) ElMessage.success(t("home.playingPlaylist", { name: pl.name }));
  else ElMessage.warning(t("home.playlistEmpty"));
}

// 首页固定推荐卡：由各推荐插件配置 showOnHome + homePosition 决定。
// 核心经 /v1/recommend/home-cards 按位次排序返回,前端只做 >30 首门槛过滤。
const homeCards = ref<any[]>([]);
async function loadHomeCards() {
  try {
    const res = await api.get("/rest/api/v1/recommend/home-cards");
    homeCards.value = res.data?.cards || [];
  } catch {
    homeCards.value = [];
  }
}
// 归一化为歌单形状(playPl/playlistActions 都按 id/name 工作),带 isCombo 标记。
const fixedCards = computed<any[]>(() =>
  homeCards.value
    .filter((c) => c.songCount > 30) // 保持 >30 首展示门槛(用户确认)
    .map((c) => ({
      id: c.playlistId,
      playlistId: c.playlistId, // 模板点击跳转用(此前缺失 → /playlists/undefined)
      name: c.playlistName || c.name,
      coverArt: c.coverArt,
      songCount: c.songCount,
      pluginId: c.pluginId,
      isCombo: !!c.isCombo,
      position: c.position || 0,
    })),
);
// 并排随机：从全部歌单里随机抽（排除固定卡；只抽音乐 ≥30 首的歌单），
// 与固定卡合并成 homeCount 张等大卡片（默认 8，桌面 4 列 × 2 行）。
const sidePlaylists = computed(() => {
  const fixedIds = new Set(fixedCards.value.map((c) => c.id));
  const pool = playlists.value.filter(
    (p) => !fixedIds.has(p.id) && (p.songCount || 0) >= 30
  );
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.max(0, homeCount.value - fixedIds.size));
});

// 手动刷新：重新触发每日推荐 + 本地推荐随机生成，再重组今日漫游。
// 异步契约(方案3)：POST 立即返回 taskId(202)，生成跑在一次性批量子进程里，
// 前端轮询 GET /v1/tasks/:id 拿结果，不长时间挂起单个 HTTP 请求。
const refreshing = ref(false);
async function refreshRoam() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const res = await api.post("/rest/api/v1/recommend/refresh", {}, { timeout: 15000 });
    const taskId: string | undefined = res.data?.taskId;
    if (!taskId) throw new Error(t("home.noTaskId"));
    // 结果仅在任务完成时携带(每日/本地/漫游各生成一张歌单),耗时通常秒级。
    await waitAsyncTask(taskId, { timeoutMs: 600000 });
    ElMessage.success(t("home.roamRegenerated"));
    await Promise.all([loadPlaylists(), loadHomeCards()]);
  } catch (e: any) {
    ElMessage.error(formatApiError(e, t("home.refreshFailed")));
  } finally {
    refreshing.value = false;
  }
}

// 各平台精选：直接渲染 recommend 能力插件的输出（每个 channel = 一个平台分区）。
// 每平台歌单数已在插件内部按 homeCount 截断，前端不再写死 slice 数量。
const platformGroups = computed(() =>
  recommendChannels.value
    .map((ch: any) => ({
      source: ch.source || "",
      name: (ch.name || ch.source || "").replace(/\u97f3\u4e50$/, ""),
      playlists: ch.playlists || [],
    }))
    .filter((g) => g.playlists.length > 0)
);

// 本地随机(按平台)：由 local-random-recommend 插件(localPlatformRecommend 能力)
// 输出——从本地库按 source_platform 分组随机挑歌单，每次刷新内容不同。歌单均已
// 入库，可直接打开/播放（playPl 按本地 id 播放），无需走导入。数据由后端提供，
// 前端不做平台硬编码。
const localRandomChannels = ref<any[]>([]);
const localRandomGroups = computed(() =>
  localRandomChannels.value
    .map((ch: any) => ({
      type: "localRandom" as const,
      source: ch.source || "",
      name: (ch.name || ch.source || "").replace(/\u97f3\u4e50$/, ""),
      playlists: ch.playlists || [],
      sortOrder: typeof ch.sortOrder === "number" ? ch.sortOrder : 99,
      subtag: ch.subtag,
      tagline: ch.tagline,
      _pluginId: "",
    }))
    .filter((g) => g.playlists.length > 0)
);

// 合并推荐 + 本地随机，按 sortOrder 升序排列（数值越小越靠前）
const sortedAllGroups = computed(() => {
  const recommend = recommendChannels.value
    .map((ch: any) => ({
      type: "recommend" as const,
      source: ch.source || "",
      name: (ch.name || ch.source || "").replace(/\u97f3\u4e50$/, ""),
      playlists: ch.playlists || [],
      sortOrder: typeof ch.sortOrder === "number" ? ch.sortOrder : 99,
      _pluginId: ch._pluginId || "",
    }))
    .filter((g) => g.playlists.length > 0);
  return [...recommend, ...localRandomGroups.value].sort((a, b) => a.sortOrder - b.sortOrder);
});
async function loadLocalRandom() {
  try {
    const res = await api.get("/rest/api/v1/local-recommend");
    localRandomChannels.value = res.data.channels || [];
  } catch {
    localRandomChannels.value = [];
  }
}

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
      if (n) ElMessage.success(t("home.playingPlaylist", { name: pl.name }));
      else ElMessage.warning(t("home.importedEmpty"));
    } else {
      ElMessage.warning(res.data?.message || t("home.importFailed"));
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || e.message || t("home.importFailed"));
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

// 首页顶部占位：按 homeCount 补齐（含全部固定推荐卡）
function placeholderHomeCount() {
  const fixed = fixedCards.value.length;
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
    // 聚合请求包含 go-music-dl + 全部榜单插件频道,冷缓存下可能较慢(榜单插件首页需
    // 拉取歌单明细)。超时放宽到 150s,避免请求被 15s 默认超时整单中止导致首页精选
    // (含 go-music-dl)一起消失;第二次命中后端缓存即秒开。
    const res = await api.get("/rest/api/v1/recommend", { timeout: 150000 });
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
  await Promise.all([loadPlaylists(), loadRecommend(), loadLocalRandom(), loadHomeConfig(), loadHomeCards()]);
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

/* 顶部：插件自治固定推荐卡 + 随机补齐，全部等大（桌面 4 列 × 2 行 = 8 张） */
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
/* 今日漫游卡刷新按钮 */
.refresh-btn {
  position: absolute; top: 10px; right: 10px;
  width: 32px; height: 32px; border-radius: 50%;
  border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: #fff; background: rgba(0, 0, 0, 0.45);
  transition: background 0.18s ease, transform 0.18s ease;
  &:hover { background: rgba(0, 0, 0, 0.65); }
  &:disabled { cursor: default; opacity: 0.7; }
}
.refresh-btn .spinning { animation: mf-spin 0.9s linear infinite; }
@keyframes mf-spin { to { transform: rotate(360deg); } }
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
