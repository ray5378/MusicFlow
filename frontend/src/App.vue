<template>
  <el-config-provider :locale="localeStore.elementLocale">
    <router-view />
  </el-config-provider>
</template>

<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";
import { useLocaleStore } from "@/stores/locale";

const route = useRoute();
const localeStore = useLocaleStore();
const auth = useAuthStore();

// ---- 启动后一次性提醒(插件 cookie 过期等) ----
// 服务端把插件经 host.notify 写入的提醒按「每次进程启动只消费一次」下发;这里再做本地去重,
// 避免组件重挂载/路由切换时重复请求。仅管理员可见(接口是 admin 门禁)。
let bootNoticesFetched = false;
async function showBootNotices() {
  if (bootNoticesFetched || !auth.isLoggedIn || !auth.isAdmin) return;
  bootNoticesFetched = true;
  try {
    const res = await api.get("/rest/api/v1/system/boot-notices");
    const notices = res.data?.notices || [];
    for (const n of notices) {
      ElMessage({
        type: n.level === "error" ? "error" : "warning",
        message: String(n.message || ""),
        duration: 8000,
        showClose: true,
        grouping: true,
      });
    }
  } catch {
    bootNoticesFetched = false; // 网络抖动时允许下次重试
  }
}
onMounted(showBootNotices);
watch(
  () => auth.isLoggedIn,
  (v) => { if (v) showBootNotices(); }
);

// 登录页用专属主题（流动光斑在 global.scss 的 body.fnos-login 中定义）
watch(
  () => route.name,
  (name) => {
    if (name === "Login") {
      document.body.classList.add("fnos-login");
    } else {
      document.body.classList.remove("fnos-login");
    }
  },
  { immediate: true }
);
</script>