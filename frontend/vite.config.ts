import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({
      imports: ["vue"],
      // Element Plus API(如 ElMessage)自动导入 JS 即可；样式不在此动态注入(T12)——统一由
      // main.ts 静态按需引入 theme-chalk 的 el-*.css,保证与 global.scss 的先后顺序可控。
      resolvers: [ElementPlusResolver({ importStyle: false })],
      dts: "src/auto-imports.d.ts",
    }),
    Components({
      resolvers: [
        // Element Plus 组件 JS 按需导入；组件样式不按需注入（统一由 main.ts 静态按需引入），
        // 避免运行时动态 <style> 晚于 global.scss 加载而覆盖自定义主题底色。
        ElementPlusResolver({ importStyle: false }),
      ],
      dts: "src/components.d.ts",
    }),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 46399,
    proxy: {
      "/rest": {
        target: "http://127.0.0.1:46400",
        changeOrigin: true,
      },
      "/api": {
        target: "http://127.0.0.1:46400",
        changeOrigin: true,
      },
      "/ping": {
        target: "http://127.0.0.1:46400",
        changeOrigin: true,
      },
    },
  },
  // `vite preview`(生产构建预览)复用同一套代理,供 CI 响应式 e2e 在同源下登录 + 拉取数据。
  preview: {
    port: 4173,
    proxy: {
      "/rest": {
        target: "http://127.0.0.1:46400",
        changeOrigin: true,
      },
      "/api": {
        target: "http://127.0.0.1:46400",
        changeOrigin: true,
      },
      "/ping": {
        target: "http://127.0.0.1:46400",
        changeOrigin: true,
      },
    },
  },
});