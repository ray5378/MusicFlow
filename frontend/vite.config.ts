import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig({
  plugins: [vue()],
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
    },
  },
});
