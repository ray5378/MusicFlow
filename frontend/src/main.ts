import { createApp } from "vue";
import { createPinia } from "pinia";
import { Search, User, Lock } from "@element-plus/icons-vue";
import App from "./App.vue";
import router from "./router";
import { longpress } from "./directives/longpress";
import { lazyCover } from "./directives/lazyCover";
import MfIcon from "./components/MfIcon.vue";
import PlatformBadge from "./components/PlatformBadge.vue";
import { i18n, loadLocaleMessages } from "./locales";
import { useLocaleStore } from "./stores/locale";
import { useAuthStore } from "./stores/auth";
// Element Plus 组件样式：**按需**引入(T12 打开速度优化)。
// 说明:不再整体引入 element-plus/dist/index.css(全量样式),改为逐组件引入
// theme-chalk 下的 el-*.css,只覆盖本项目实际用到的组件;并补齐共享基座
// (CSS 变量 / reset / popper / overlay / scrollbar)与弹层服务(message / message-box / loading)。
// 所有 EP 样式仍**静态**排在 global.scss 之前,保证自定义主题(global.scss)能覆盖 EP 默认样式。
import "element-plus/theme-chalk/el-var.css";
import "element-plus/theme-chalk/base.css";
import "element-plus/theme-chalk/el-reset.css";
import "element-plus/theme-chalk/el-popper.css";
import "element-plus/theme-chalk/el-overlay.css";
import "element-plus/theme-chalk/el-scrollbar.css";
import "element-plus/theme-chalk/el-icon.css";
import "element-plus/theme-chalk/el-button.css";
import "element-plus/theme-chalk/el-card.css";
import "element-plus/theme-chalk/el-alert.css";
import "element-plus/theme-chalk/el-tag.css";
import "element-plus/theme-chalk/el-divider.css";
import "element-plus/theme-chalk/el-link.css";
import "element-plus/theme-chalk/el-form.css";
import "element-plus/theme-chalk/el-form-item.css";
import "element-plus/theme-chalk/el-input.css";
import "element-plus/theme-chalk/el-input-number.css";
import "element-plus/theme-chalk/el-checkbox.css";
import "element-plus/theme-chalk/el-checkbox-group.css";
import "element-plus/theme-chalk/el-radio.css";
import "element-plus/theme-chalk/el-radio-group.css";
import "element-plus/theme-chalk/el-radio-button.css";
import "element-plus/theme-chalk/el-switch.css";
import "element-plus/theme-chalk/el-slider.css";
import "element-plus/theme-chalk/el-select.css";
import "element-plus/theme-chalk/el-option.css";
import "element-plus/theme-chalk/el-select-dropdown.css";
import "element-plus/theme-chalk/el-dropdown.css";
import "element-plus/theme-chalk/el-dropdown-menu.css";
import "element-plus/theme-chalk/el-dropdown-item.css";
import "element-plus/theme-chalk/el-tooltip.css";
import "element-plus/theme-chalk/el-popover.css";
import "element-plus/theme-chalk/el-popconfirm.css";
import "element-plus/theme-chalk/el-dialog.css";
import "element-plus/theme-chalk/el-tabs.css";
import "element-plus/theme-chalk/el-tab-pane.css";
import "element-plus/theme-chalk/el-table.css";
import "element-plus/theme-chalk/el-table-column.css";
import "element-plus/theme-chalk/el-pagination.css";
import "element-plus/theme-chalk/el-menu.css";
import "element-plus/theme-chalk/el-menu-item.css";
import "element-plus/theme-chalk/el-sub-menu.css";
import "element-plus/theme-chalk/el-descriptions.css";
import "element-plus/theme-chalk/el-descriptions-item.css";
import "element-plus/theme-chalk/el-progress.css";
import "element-plus/theme-chalk/el-empty.css";
import "element-plus/theme-chalk/el-skeleton.css";
import "element-plus/theme-chalk/el-skeleton-item.css";
import "element-plus/theme-chalk/el-time-picker.css";
import "element-plus/theme-chalk/el-upload.css";
import "element-plus/theme-chalk/el-config-provider.css";
import "element-plus/theme-chalk/el-message.css";
import "element-plus/theme-chalk/el-message-box.css";
import "element-plus/theme-chalk/el-loading.css";
import "./assets/styles/global.scss";

/**
 * 首页第一排固定推荐卡的封面 id(顺序与推荐插件的 homePosition 一致)。
 * 这些 id 由推荐插件固定产出,不随会话/日期变化,因此可以在接口返回前预加载。
 */
const HOME_COVER_IDS = ["pl-pl-daily-roam", "pl-pl-daily-today", "pl-pl-daily-local"];

const app = createApp(App);

const pinia = createPinia();
app.use(pinia);
app.use(i18n);
app.use(router);

// Element Plus components/icons are auto-imported on demand (unplugin-vue-components).
// Only these three icons are used by string prop (prefix-icon etc.), so they must stay
// registered globally — nothing else is pulled in from the icon set.
app.component("Search", Search);
app.component("User", User);
app.component("Lock", Lock);

app.directive("longpress", longpress);
app.directive("lazy-cover", lazyCover);
app.component("MfIcon", MfIcon);
app.component("PlatformBadge", PlatformBadge);

async function bootstrap() {
  // 在首帧渲染前落地界面语言偏好(默认 zh-CN)。必须在 mount 之前执行,
  // 否则 el-config-provider 第一次读取 locale 时拿不到持久化语言。
  const localeStore = useLocaleStore(pinia);
  // 英文用户:先拉 en-US 语言包再首帧渲染,避免首屏回落到中文。
  await loadLocaleMessages(localeStore.lang);
  app.mount("#app");
  preloadHomeCovers();
}

/**
 * 首屏固定卡封面预加载(2026-11-09 首页提速)。
 *
 * 这三张卡的封面 id 固定,但 <img> 要等 /recommend/home-cards 返回(~300ms)才知道
 * URL;提前发起请求可让图片在卡片渲染时就已就绪(实测封面请求 327ms → 21ms)。
 *
 * **必须在登录态确定之后**:封面端点受鉴权保护,无凭据时返回 401,而 <img> 会复用
 * 这条失败响应 —— 实测封面直接变成 naturalWidth=0 的空图。这里先实例化 auth store
 * (它把 JWT 同步到 mf_token cookie,见 stores/auth.ts),由 cookie 随图片请求自动
 * 鉴权;没有 token(未登录)时完全不预加载,避免把匿名请求打进去。
 */
function preloadHomeCovers() {
  const auth = useAuthStore(pinia);
  if (!auth.token) return;
  HOME_COVER_IDS.forEach((id, i) => {
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = `/rest/getCoverArt?id=${id}&size=150`;
    if (i === 0) link.setAttribute("fetchpriority", "high");
    document.head.appendChild(link);
  });
}
void bootstrap();
