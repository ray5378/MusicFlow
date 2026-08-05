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
        <div class="card featured" v-if="featured" @click="go('/playlists')">
          <div class="card-cover-wrap">
            <img v-if="featured.coverArt" :src="cover(featured.coverArt)" class="card-cover" />
            <div v-else class="card-cover-ph"><el-icon :size="48"><Headset /></el-icon></div>
            <span class="badge">今日推荐</span>
          </div>
          <div class="card-body">
            <div class="card-title">{{ featured.name }}</div>
            <div class="card-sub">{{ featured.songCount ? featured.songCount + ' 首' : '歌单' }}</div>
          </div>
        </div>

        <!-- 并排随机抽取的歌单 -->
        <div
          v-for="pl in sidePlaylists"
          :key="pl.id"
          class="card"
          @click="go('/playlists')"
        >
          <div class="card-cover-wrap">
            <img v-if="pl.coverArt" :src="cover(pl.coverArt)" class="card-cover" />
            <div v-else class="card-cover-ph"><el-icon :size="32"><Headset /></el-icon></div>
          </div>
          <div class="card-body">
            <div class="card-title">{{ pl.name }}</div>
            <div class="card-sub">{{ pl.songCount ? pl.songCount + ' 首' : '歌单' }}</div>
          </div>
        </div>

        <!-- 占位（无数据时） -->
        <div v-for="n in placeholderCount(featured, sidePlaylists, 4)" :key="'ph-pl-' + n" class="card placeholder">
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
          v-for="al in randomAlbums"
          :key="al.id"
          class="card"
          @click="go('/albums')"
        >
          <div class="card-cover-wrap">
            <img v-if="al.coverArt" :src="cover(al.coverArt)" class="card-cover" />
            <div v-else class="card-cover-ph"><el-icon :size="28"><Service /></el-icon></div>
          </div>
          <div class="card-body">
            <div class="card-title">{{ al.name || al.title }}</div>
            <div class="card-sub">{{ al.artist || '' }}</div>
          </div>
        </div>
        <div v-for="n in placeholderCount(null, randomAlbums, 8)" :key="'ph-al-' + n" class="card placeholder">
          <div class="card-cover-wrap"><div class="card-cover-ph"></div></div>
          <div class="card-body"><div class="sk-line"></div><div class="sk-line short"></div></div>
        </div>
      </div>
    </section>

    <!-- ===== 底部：快捷方式 ===== -->
    <section class="section">
      <div class="section-title"><span>快捷方式</span></div>
      <div class="shortcut-row">
        <div class="shortcut" @click="go('/favorites')">
          <div class="shortcut-icon fav"><HeartIcon :filled="true" :size="22" /></div>
          <div class="shortcut-text">
            <div class="shortcut-title">我喜欢的音乐</div>
            <div class="shortcut-sub">你收藏的宝藏</div>
          </div>
        </div>
        <div class="shortcut" @click="go('/history')">
          <div class="shortcut-icon hist"><el-icon :size="22"><Clock /></el-icon></div>
          <div class="shortcut-text">
            <div class="shortcut-title">播放历史</div>
            <div class="shortcut-sub">最近听过的歌</div>
          </div>
        </div>
        <div class="shortcut" @click="go('/songs')">
          <div class="shortcut-icon added"><el-icon :size="22"><Plus /></el-icon></div>
          <div class="shortcut-text">
            <div class="shortcut-title">最佳添加</div>
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
import { Headset, Service, Clock, Plus } from "@element-plus/icons-vue";
import HeartIcon from "@/components/HeartIcon.vue";

const router = useRouter();

const playlists = ref<any[]>([]);
const recommendedIds = ref<Set<string>>(new Set());
const albums = ref<any[]>([]);
const loading = ref(false);

function cover(id: string) {
  return `/rest/getCoverArt?id=${id}&size=300`;
}
function go(path: string) {
  router.push(path);
}

// 今日推荐：优先取推荐池中的歌单，否则取列表第一个
const featured = computed(() => {
  const rec = playlists.value.find((p) => recommendedIds.value.has(p.id));
  return rec || playlists.value[0] || null;
});
// 并排随机：从全部歌单里随机抽 3 张（排除今日推荐大卡）
const sidePlaylists = computed(() => {
  const pool = playlists.value.filter((p) => p.id !== (featured.value && featured.value.id));
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3);
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
  &:hover {
    transform: translateY(-5px);
    background: rgba(255, 255, 255, 0.08);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
  }
  &.featured { grid-row: span 2; }
}
.card-cover-wrap { position: relative; }
.card-cover { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
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
.card-body { padding: 10px 12px 12px; }
.card-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
  &:hover { transform: translateY(-4px); background: rgba(255, 255, 255, 0.08); box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4); }
  .shortcut-icon {
    width: 46px; height: 46px; border-radius: 13px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; color: #fff;
  }
  .shortcut-icon.fav { background: linear-gradient(135deg, #f62c55, #c934e1); }
  .shortcut-icon.hist { background: linear-gradient(135deg, #1b73fb, #16a34a); }
  .shortcut-icon.added { background: linear-gradient(135deg, #f8bf28, #fc5e25); }
  .shortcut-title { font-size: 15px; font-weight: 600; }
  .shortcut-sub { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 2px; }
}

@media (max-width: 1100px) {
  .top-row { grid-template-columns: 1fr 1fr; }
  .card.featured { grid-column: span 2; grid-row: auto; }
  .grid-row { grid-template-columns: repeat(3, 1fr); }
}
@media (max-width: 768px) {
  .home-page { padding: 18px 16px 120px; }
  .top-row { grid-template-columns: 1fr 1fr; }
  .grid-row { grid-template-columns: repeat(2, 1fr); }
  .shortcut-row { grid-template-columns: 1fr; }
}
</style>
