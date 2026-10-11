<!--
  来源优先级行式列表(可复用组件):「播放来源优先级」「歌词来源优先级」「封面来源优先级」三处共用。

  - 已选项:序号 + 名称 + (不可用时的 warning 标签) + ↑↓(首末禁用) + 删除;
  - 添加区:下拉(排除已加入项) + 「添加」;
  - 空列表:显示提示文案;
  - 变更即 emit `update:modelValue`,由父组件决定是否即时保存。

  props.options 既作为下拉候选、也默认作为「可用来源」集合;父组件若候选里含不可用项
  (例如已禁用的插件仍需展示),可传 availableValues 覆盖「可用」判定,使不可用行打警示标签。
-->
<template>
  <div class="src-priority">
    <div v-for="(item, i) in modelValue" :key="item" class="src-priority-row">
      <span class="src-priority-idx">{{ i + 1 }}</span>
      <span class="src-priority-name">{{ labelFor(item) }}</span>
      <el-tag v-if="!isAvailable(item)" type="warning" size="small" effect="plain">{{ t('admin.plugins.sourcePriorityUnavailable') }}</el-tag>
      <el-button size="small" :disabled="i === 0" :title="t('common.moveUp')" @click="move(i, -1)">&#8593;</el-button>
      <el-button size="small" :disabled="i === modelValue.length - 1" :title="t('common.moveDown')" @click="move(i, 1)">&#8595;</el-button>
      <el-button size="small" type="danger" plain :title="t('admin.plugins.sourcePriorityRemove')" @click="remove(i)"><MfIcon name="X" /></el-button>
    </div>
    <div v-if="!modelValue.length" class="src-priority-empty field-hint">{{ t('admin.plugins.sourcePriorityEmpty') }}</div>
    <div class="src-priority-add">
      <el-select v-model="pending" clearable :placeholder="t('admin.plugins.sourcePrioritySelectPlaceholder')" style="width: 320px">
        <el-option v-for="o in addableOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-button size="small" type="primary" plain :disabled="!pending" @click="add">{{ t('admin.plugins.sourcePriorityAdd') }}</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

/** 一个可加入优先级的来源(插件级:value=插件 id)。 */
export interface SourcePriorityOption {
  value: string;
  label: string;
}

const props = defineProps<{
  /** 有序优先级列表(首个 = 首选源)。 */
  modelValue: string[];
  /** 下拉候选 + 默认「可用」集合。 */
  options: SourcePriorityOption[];
  /** 可选:覆盖「可用」判定(候选含不可用项时,用它标出哪些才真可用)。 */
  availableValues?: string[];
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string[]): void;
}>();

const { t } = useI18n();
const pending = ref("");

/** 可用集合:未传 availableValues 时=候选自身。 */
const availableSet = computed(() => new Set(props.availableValues ?? props.options.map((o) => o.value)));

/** 下拉候选:排除已加入项。 */
const addableOptions = computed(() => props.options.filter((o) => !props.modelValue.includes(o.value)));

/** 展示名:优先用候选 label,缺失(插件已卸载)回退原始值。 */
function labelFor(value: string): string {
  return props.options.find((o) => o.value === value)?.label || value;
}

function isAvailable(value: string): boolean {
  return availableSet.value.has(value);
}

function update(next: string[]) {
  emit("update:modelValue", next);
}

function add() {
  const value = pending.value;
  pending.value = "";
  if (!value || props.modelValue.includes(value)) return;
  update([...props.modelValue, value]);
}

function remove(i: number) {
  const next = [...props.modelValue];
  next.splice(i, 1);
  update(next);
}

function move(i: number, delta: number) {
  const j = i + delta;
  if (j < 0 || j >= props.modelValue.length) return;
  const next = [...props.modelValue];
  [next[i], next[j]] = [next[j], next[i]];
  update(next);
}
</script>

<style lang="scss" scoped>
.src-priority { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.src-priority-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.src-priority-idx { flex: 0 0 18px; text-align: center; font-size: 12px; color: var(--el-text-color-secondary); }
.src-priority-name { flex: 1; min-width: 0; font-size: 13px; color: var(--el-text-color-primary); word-break: break-all; }
.src-priority-empty { margin-left: 0; font-size: 12px; color: var(--el-text-color-secondary); }
.src-priority-add { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

@media (max-width: 768px) {
  .src-priority-add .el-select { width: 100% !important; }
}
</style>
