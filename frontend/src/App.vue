<template>
  <el-config-provider :locale="localeStore.elementLocale">
    <router-view />
  </el-config-provider>
</template>

<script setup lang="ts">
import { watch } from "vue";
import { useRoute } from "vue-router";
import { useLocaleStore } from "@/stores/locale";

const route = useRoute();
const localeStore = useLocaleStore();

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