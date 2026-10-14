import { createApp } from "vue";
import { createPinia } from "pinia";
import { Search, User, Lock } from "@element-plus/icons-vue";
import App from "./App.vue";
import router from "./router";
import { longpress } from "./directives/longpress";
import MfIcon from "./components/MfIcon.vue";
import PlatformBadge from "./components/PlatformBadge.vue";
import { i18n } from "./locales";
import { useLocaleStore } from "./stores/locale";
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

const app = createApp(App);

const pinia = createPinia();
app.use(pinia);
app.use(i18n);
app.use(router);

// 在首帧渲染前落地界面语言偏好(默认 zh-CN)。必须在 mount 之前执行,
// 否则 el-config-provider 第一次读取 locale 时拿不到持久化语言。
useLocaleStore(pinia);

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
