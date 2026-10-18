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
            <img v-if="card.coverArt" v-lazy-cover="cover(card.coverArt)" class="card-cover" decoding="async" fetchpriority="low" />
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
            <img v-if="pl.coverArt" v-lazy-cover="cover(pl.coverArt)" class="card-cover" decoding="async" fetchpriority="low" />
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

    <!-- 平台精选冷启动占位(后端后台拉取中;数据到位自动填充,不阻塞其它分区) -->
    <div v-if="recommendPending && platformGroups.length === 0" class="recommend-error recommend-pending">
      <MfIcon name="RefreshCw" :size="16" class="spinning" /> {{ t('home.recommendPending') }}
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
              <img v-if="pl.cover" v-lazy-cover="pl.cover" class="card-cover" decoding="async" fetchpriority="low" referrerpolicy="no-referrer" />
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
              <img v-if="pl.coverArt" v-lazy-cover="cover(pl.coverArt)" class="card-cover" decoding="async" fetchpriority="low" />
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
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated } from "vue";
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
  // 卡片封面实际显示约 140~160px:桌面上收紧到 150 而非默认 300,
  // 减少每张封面的解码/传输(详情页大图仍走 coverUrl 默认 300)。
  return coverUrl(id, 150);
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
// 核心经 /v1/recommend/home-cards 按位次排序返回,前端只做 >=30 首门槛过滤。
// (曾为 >30:历史日推等固定卡被误杀不显示,240 真机实锤 → 用户定调 >15。)
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
    .filter((c) => c.songCount > 15) // >15 首展示门槛(用户定调:保底展示历史日推等固定卡)
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
/** 安排下一轮本地随机重试。needRetry=true 且未耗尽次数 → 8s 后再拉;否则复位并停表。
 *  轮询自愈的两类触发:后端 pending(冷启动未产出)+ 请求失败(超时/网络)。 */
function scheduleLocalRecommendRetry(needRetry: boolean) {
  // localRecommendPaused:keep-alive 切走后为 true —— 在途请求 settle 回来时不得再起表。
  if (needRetry && !localRecommendPaused && localRecommendRetryCount < LOCAL_RECOMMEND_RETRY_MAX) {
    localRecommendRetryCount += 1;
    if (localRecommendRetryTimer) clearTimeout(localRecommendRetryTimer);
    localRecommendRetryTimer = setTimeout(loadLocalRandom, RECOMMEND_RETRY_MS);
  } else {
    localRecommendRetryCount = 0;
    if (localRecommendRetryTimer) {
      clearTimeout(localRecommendRetryTimer);
      localRecommendRetryTimer = null;
    }
  }
}

async function loadLocalRandom() {
  if (localRecommendInFlight) return; // 防重入:避免定时器/onActivated 触发并发请求
  localRecommendInFlight = true;
  try {
    const res = await api.get("/rest/api/v1/local-recommend");
    localRandomChannels.value = res.data.channels || [];
    // pending 可与「部分 provider 已返回」并存,故只看 pending 标志本身:只要后端本轮
    // 有 provider 未产出(冷启动),就继续轮询让其自愈。
    scheduleLocalRecommendRetry(!!res.data?.pending);
  } catch {
    // 请求失败(最典型:服务端偶发阻塞 > axios 15s 超时)。**必须继续轮询自愈**,否则
    // 该分区会永久空白直到整页刷新 —— 这正是 2026-10-15「首页偶发卡死」的形态:
    // 改造后 /v1/recommend 有轮询兜底,但本地随机仅在 pending 时轮询,超时落 catch
    // 后不再重试。此处不清空已渲染内容(保留 last-good),交由下一轮覆盖。
    scheduleLocalRecommendRetry(true);
  } finally {
    localRecommendInFlight = false;
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

// 平台精选冷启动轮询:后端无缓存时立即返回空频道 + pending:true(不再阻塞),
// 后台 single-flight 拉取。前端每 8s 重试一次(≤18 次 ≈144s,与改造前的 150s 超时
// 窗口对齐,避免上游聚合偏慢时内容永不出现),数据到位自动填充;轮询期间模板显示
// 占位提示(recommendPending)。重试耗尽仍无内容 → 置 recommendError 给出诊断提示
// (改造前后端会因 15s/150s 超时进入 catch 显示该提示,不能让这条路径静默消失)。
const recommendPending = ref(false);
let recommendRetryTimer: ReturnType<typeof setTimeout> | null = null;
let recommendRetryCount = 0;
const RECOMMEND_RETRY_MS = 8000;
const RECOMMEND_RETRY_MAX = 18;

// 本地随机(按平台)冷启动/失败轮询:后端 pending(冷启动未产出)或请求失败(超时)时,
// 前端每 8s 重试(≤6 次 ≈48s),数据到位自动填充;与 /v1/recommend 同策略。
let localRecommendRetryTimer: ReturnType<typeof setTimeout> | null = null;
let localRecommendRetryCount = 0;
let localRecommendInFlight = false;
let localRecommendPaused = false;
const LOCAL_RECOMMEND_RETRY_MAX = 6;

async function loadRecommend() {
  try {
    // 后端已非阻塞(冷启动返回 pending 空频道,SWR/热路径秒回),默认超时足够。
    const res = await api.get("/rest/api/v1/recommend");
    recommendChannels.value = res.data.channels || [];
    recommendProviderId.value = res.data.providerId || "";
    recommendError.value = false;
    const pending = !!res.data?.pending && recommendChannels.value.length === 0;
    recommendPending.value = pending;
    if (pending) {
      if (recommendRetryCount < RECOMMEND_RETRY_MAX) {
        recommendRetryCount += 1;
        if (recommendRetryTimer) clearTimeout(recommendRetryTimer);
        recommendRetryTimer = setTimeout(loadRecommend, RECOMMEND_RETRY_MS);
      } else {
        // 重试耗尽仍无内容:停止轮询,并给出诊断提示(而非静默留空区块)。
        recommendPending.value = false;
        recommendError.value = true;
      }
    } else {
      recommendRetryCount = 0;
      if (recommendRetryTimer) {
        clearTimeout(recommendRetryTimer);
        recommendRetryTimer = null;
      }
    }
  } catch {
    recommendChannels.value = [];
    recommendProviderId.value = "";
    recommendError.value = true;
    recommendPending.value = false;
  }
}

onUnmounted(() => {
  if (recommendRetryTimer) {
    clearTimeout(recommendRetryTimer);
    recommendRetryTimer = null;
  }
  if (localRecommendRetryTimer) {
    clearTimeout(localRecommendRetryTimer);
    localRecommendRetryTimer = null;
  }
});

// Home 位于 MainLayout 的 keep-alive(max=10)内:切走后 onUnmounted 不触发,轮询定时器
// 会继续在后台空跑(每 8s 重洗本地随机卡片、且计数耗尽后无法复位)。故 deactivated 时
// 停掉本地随机轮询、复位计数并**暂停续期**(在途请求 settle 后不得再起表);返回页面时
// 解除暂停并按需重新拉取(见 onActivated)。
onDeactivated(() => {
  localRecommendPaused = true;
  if (localRecommendRetryTimer) {
    clearTimeout(localRecommendRetryTimer);
    localRecommendRetryTimer = null;
  }
  localRecommendRetryCount = 0;
});

// 返回 cached 页面时:若上次离开前本地随机仍在等后端回填(pending),重新拉取一次让
// 分区自愈(keep-alive 命中的是旧实例,onMounted 不会重跑)。
onActivated(() => {
  localRecommendPaused = false;
  if (localRandomChannels.value.length === 0) void loadLocalRandom();
});

onMounted(async () => {
  // P1-3 渐进渲染:各分区基于各自响应式 ref 独立渲染(模板未整页骨架门控 loading)。
  // 快加载器(歌单/本地随机/配置/固定卡)决定首屏 loading 复位;loadRecommend 聚合
  // 自 2026-10-15 起后端非阻塞(冷启动返回 pending + 后台拉取,前端轮询自动填充),
  // 依旧独立进行、不阻塞其它分区与 loading 复位。
  loading.value = true;
  const fast = Promise.all([loadPlaylists(), loadLocalRandom(), loadHomeConfig(), loadHomeCards()]);
  const slow = loadRecommend();
  await fast;
  loading.value = false;
  await slow;
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
/* 冷启动占位:复用 recommend-error 版式但用中性色(它不是错误,是"后台搬运中") */
.recommend-pending {
  color: var(--fnos-text-tertiary);
  background: rgba(128, 128, 128, 0.08);
  border-color: rgba(128, 128, 128, 0.2);
  .spinning { animation: mf-spin 0.9s linear infinite; }
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
