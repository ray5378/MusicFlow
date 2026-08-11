import { createApp } from "vue";
import { createPinia } from "pinia";
import { Search, User, Lock } from "@element-plus/icons-vue";
import App from "./App.vue";
import router from "./router";
import { longpress } from "./directives/longpress";
import MfIcon from "./components/MfIcon.vue";
import PlatformBadge from "./components/PlatformBadge.vue";
// Element Plus 组件基础样式以静态方式整体引入，保证加载顺序先于 global.scss 的主题覆盖，
// 避免 on-demand 动态注入的组件默认样式覆盖自定义主题变量（如输入框底色）。
import "element-plus/dist/index.css";
import "./assets/styles/global.scss";

const app = createApp(App);

app.use(createPinia());
app.use(router);

// Element Plus components/icons are auto-imported on demand (unplugin-vue-components).
// Only these three icons are used by string prop (prefix-icon etc.), so they must stay
// registered globally — nothing else is pulled in from the icon set.
app.component("Search", Search);
app.component("User", User);
app.component("Lock", Lock);

app.directive("longpress", longpress);
app.component("MfIcon", MfIcon);
app.component("PlatformBadge", PlatformBadge);

app.mount("#app");
