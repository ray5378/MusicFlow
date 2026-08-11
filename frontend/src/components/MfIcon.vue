<template>
  <span class="mf-icon" :class="{ 'mf-icon--spin': spin }" :style="rootStyle">
    <component
      :is="resolved"
      v-if="resolved"
      :size="pixel"
      :stroke-width="filled ? 0 : strokeWidth"
      :fill="filled ? 'currentColor' : 'none'"
    />
    <slot v-else />
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  ArrowLeft, Box, Cable, Check, ChevronDown, ChevronRight, CircleCheck, CircleSlash,
  Clock, Copy, Disc3, Download, FolderOpen, Headphones, Heart, Home, Info, KeyRound,
  Library, List, ListMusic, ListOrdered, Loader2, Menu, MessageCircle, Monitor,
  MoreHorizontal, Pause, Pencil, Play, Plus, Radar, RefreshCw, Repeat, Repeat1,
  RotateCcw, Search, Settings, Shuffle, SkipBack, SkipForward, SlidersHorizontal,
  Speaker, Trash2, TriangleAlert, Upload, User, Volume2, VolumeX, Wand2, Workflow, X,
  Zap,
} from "lucide-vue-next";

const props = withDefaults(
  defineProps<{
    /** 图标名（lucide 名，或旧的 Element Plus 名会自动映射） */
    name?: string;
    /** 直接传入一个 lucide 组件（用于菜单等动态图标） */
    icon?: any;
    /** 尺寸：数字=px；字符串=任意 CSS 长度（如 "1.2em"） */
    size?: number | string;
    /** 描边宽度，统一 2 */
    strokeWidth?: number;
    /** 旋转动画（加载/刷新用） */
    spin?: boolean;
    /** 实心填充（如已收藏的红心） */
    filled?: boolean;
  }>(),
  { strokeWidth: 2, spin: false, filled: false }
);

// Element Plus 图标名 -> lucide 名的别名映射（让迁移更平滑）
const ALIAS: Record<string, string> = {
  HomeFilled: "Home",
  UserFilled: "User",
  Headset: "Headphones",
  Collection: "Library",
  Service: "Disc3",
  Connection: "Cable",
  FolderOpened: "FolderOpen",
  Setting: "Settings",
  ChatDotRound: "MessageCircle",
  MoreFilled: "MoreHorizontal",
  InfoFilled: "Info",
  VideoPlay: "Play",
  Loading: "Loader2",
  Edit: "Pencil",
  Delete: "Trash2",
  MagicStick: "Wand2",
  Warning: "TriangleAlert",
  CopyDocument: "Copy",
  RefreshLeft: "RotateCcw",
  Refresh: "RefreshCw",
  Close: "X",
};

// Curated lucide icon set (only the names referenced across the app). Keeping
// this as an explicit map lets the bundler tree-shake lucide-vue-next instead of
// pulling in every icon like the old `import * from lucide-vue-next`.
const ICONS: Record<string, any> = {
  ArrowLeft, Box, Cable, Check, ChevronDown, ChevronRight, CircleCheck, CircleSlash,
  Clock, Copy, Disc3, Download, FolderOpen, Headphones, Heart, Home, Info, KeyRound,
  Library, List, ListMusic, ListOrdered, Loader2, Menu, MessageCircle, Monitor,
  MoreHorizontal, Pause, Pencil, Play, Plus, Radar, RefreshCw, Repeat, Repeat1,
  RotateCcw, Search, Settings, Shuffle, SkipBack, SkipForward, SlidersHorizontal,
  Speaker, Trash2, TriangleAlert, Upload, User, Volume2, VolumeX, Wand2, Workflow, X,
  Zap,
};

function toPascal(s: string): string {
  return s
    .split(/[-_\s]+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

const resolved = computed(() => {
  if (props.icon) return props.icon;
  if (!props.name) return null;
  return (
    ICONS[props.name] ||
    ICONS[toPascal(props.name)] ||
    (ALIAS[props.name] && ICONS[ALIAS[props.name]]) ||
    (ALIAS[toPascal(props.name)] && ICONS[ALIAS[toPascal(props.name)]]) ||
    null
  );
});

const pixel = computed(() => {
  if (props.size == null) return 20;
  if (typeof props.size === "number") return props.size;
  const n = parseFloat(props.size);
  return isNaN(n) ? 20 : n;
});

const rootStyle = computed(() => {
  if (typeof props.size === "string") {
    return { width: props.size, height: props.size };
  }
  return {};
});
</script>

<style scoped>
.mf-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  line-height: 0;
  color: currentColor;
}
.mf-icon :deep(svg) {
  display: block;
}
.mf-icon--spin {
  animation: mf-icon-spin 0.9s linear infinite;
}
@keyframes mf-icon-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
