import { computed, reactive, ref, watch } from "vue";
import api from "@/api";

/** 每页歌单数量:生产账号 871 个歌单,全量响应约 356KB,分页后首屏只拉一页。 */
export const PLAYLIST_PAGE_SIZE = 50;

/**
 * 歌单分页 + 名称搜索(300ms 防抖)。
 * 后端 /rest/getPlaylists 已支持 query/size/offset,响应里带 playlists.total。
 * 返回值是 reactive,可直接在模板里用 `paged.items` / `paged.keyword`。
 */
export function usePagedPlaylists() {
  const items = ref<any[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const keyword = ref("");
  const hasMore = computed(() => items.value.length < total.value);

  // 请求序号:搜索词快速切换时丢弃过期响应,避免旧结果覆盖新结果。
  let seq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // load(true) 主动清空搜索词时,跳过一次 watch 回调(否则会再触发一次延迟请求)。
  let skipNextKeywordWatch = false;

  function clearDebounce() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  async function fetchPage(reset: boolean) {
    const reqId = ++seq;
    const offset = reset ? 0 : items.value.length;
    loading.value = true;
    try {
      const params = new URLSearchParams({
        f: "json",
        size: String(PLAYLIST_PAGE_SIZE),
        offset: String(offset),
      });
      const q = keyword.value.trim();
      if (q) params.set("query", q);
      const res = await api.get(`/rest/getPlaylists?${params.toString()}`);
      if (reqId !== seq) return;
      const page = res.data?.["subsonic-response"]?.playlists;
      const list = page?.playlist || [];
      total.value = Number(page?.total ?? 0);
      items.value = reset ? list : items.value.concat(list);
    } catch {
      if (reqId !== seq) return;
      if (reset) {
        items.value = [];
        total.value = 0;
      }
    } finally {
      if (reqId === seq) loading.value = false;
    }
  }

  /** 打开弹窗/重新搜索:加载第一页。resetKeyword=true 时同时清空搜索词。 */
  function load(resetKeyword = false) {
    if (resetKeyword && keyword.value) {
      skipNextKeywordWatch = true;
      keyword.value = "";
    }
    clearDebounce();
    return fetchPage(true);
  }

  /** 列表滚动到底部时加载下一页(loading 中或没有更多时自动跳过)。 */
  function loadMore() {
    if (loading.value || !hasMore.value) return;
    return fetchPage(false);
  }

  watch(keyword, () => {
    if (skipNextKeywordWatch) {
      skipNextKeywordWatch = false;
      return;
    }
    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      fetchPage(true);
    }, 300);
  });

  return reactive({ items, total, loading, keyword, hasMore, load, loadMore });
}
