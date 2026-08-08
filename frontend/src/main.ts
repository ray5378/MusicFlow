import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import * as Lucide from "lucide-vue-next";
import App from "./App.vue";
import router from "./router";
import { longpress } from "./directives/longpress";
import MfIcon from "./components/MfIcon.vue";
import PlatformBadge from "./components/PlatformBadge.vue";
import "./assets/styles/global.scss";

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(ElementPlus);

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}
// Unified line-icon set (registered after EP so it wins on name collisions).
for (const [key, component] of Object.entries(Lucide)) {
  if (key === "createLucideIcon") continue;
  if (typeof component !== "function" && typeof component !== "object") continue;
  app.component(key, component as any);
}

app.directive("longpress", longpress);
app.component("MfIcon", MfIcon);
app.component("PlatformBadge", PlatformBadge);

app.mount("#app");
