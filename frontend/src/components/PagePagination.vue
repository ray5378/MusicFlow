<template>
  <div class="page-pagination">
    <el-pagination
      layout="total, sizes, prev, pager, next, jumper"
      :total="total"
      :page-size="currentSize"
      :page-sizes="sizes"
      :current-page="currentPage"
      background
      @current-change="onCurrent"
      @size-change="onSize"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

/**
 * 公共分页组件：统一「总数 / 每页条数 / 上一页 / 页码 / 下一页 / 跳转」控件。
 * - storageKey 传入时，每页条数记忆到 localStorage（不同页面用不同 key）
 * - 页面通过 @change="(page, size) => ..." 拿到页码与条数后自行重新加载
 * - total 变化（如删除数据）时自动把越界页码修正回最后一页
 */
const props = withDefaults(defineProps<{
  total: number;
  page?: number;
  pageSize?: number;
  sizes?: number[];
  storageKey?: string;
}>(), {
  page: 1,
  pageSize: 25,
  sizes: () => [15, 25, 50, 100],
  storageKey: "",
});

const emit = defineEmits<{ (e: "change", page: number, size: number): void }>();

const currentSize = ref(
  props.storageKey
    ? (parseInt(localStorage.getItem(props.storageKey) || String(props.pageSize)) || props.pageSize)
    : props.pageSize,
);
const currentPage = ref(props.page);

watch(() => props.total, (t) => {
  const max = Math.max(1, Math.ceil(t / currentSize.value));
  if (currentPage.value > max) {
    currentPage.value = max;
    emit("change", max, currentSize.value);
  }
});

function onCurrent(p: number) {
  currentPage.value = p;
  emit("change", p, currentSize.value);
}

function onSize(s: number) {
  currentSize.value = s;
  if (props.storageKey) localStorage.setItem(props.storageKey, String(s));
  currentPage.value = 1;
  emit("change", 1, s);
}
</script>

<style scoped>
.page-pagination {
  display: flex;
  justify-content: center;
  margin-top: 24px;
}
/* 移动端：分页条允许换行，隐藏跳转框避免溢出被悬浮播放条挤压 */
@media (max-width: 768px) {
  .page-pagination { margin-top: 16px; }
  .page-pagination :deep(.el-pagination) {
    flex-wrap: wrap;
    row-gap: 6px;
    justify-content: center;
    max-width: 100%;
  }
  .page-pagination :deep(.el-pagination .el-pagination__jump) { display: none; }
}
</style>
