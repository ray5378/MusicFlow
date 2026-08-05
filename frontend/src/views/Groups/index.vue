<template>
  <div class="groups-page">
    <div class="page-header">
      <h2>播放器群组</h2>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建群组</el-button>
    </div>
    <div class="groups-tip">
      将多台 DLNA 设备加入一个群组,组持有自己的队列;播放时后端会并发向全部在线成员投递同一首歌(仿 Music Assistant Sync Group,不进行漂移校正)。
      一台设备可同时加入多个群组(如「客厅组」+「所有设备组」);设备同一时刻只能渲染一路流,多个组同时播放时以最后一次命令为准。
      组创建后可像单台设备一样在上方播放器切换器中选择并控制。
    </div>

    <div class="group-list" v-loading="loading">
      <div v-for="g in groups" :key="g.id" class="group-card">
        <div class="group-card-head">
          <div class="group-name">
            <el-icon class="group-name-icon"><Box /></el-icon>
            <span class="group-name-text">{{ g.name }}</span>
          </div>
          <div class="group-meta">
            <span>{{ g.members.length }} 台设备</span>
            <span class="meta-dot">·</span>
            <span :class="{ 'online': onlineCount(g) > 0 }">{{ onlineCount(g) }} 台在线</span>
          </div>
        </div>
        <div class="group-members">
          <template v-if="g.members.length > 0">
            <span
              v-for="m in g.members"
              :key="m.deviceId"
              class="member-chip"
              :class="{ offline: !m.available }"
            >
              {{ m.name }}
              <span v-if="!m.available" class="member-offline">离线</span>
            </span>
          </template>
          <span v-else class="member-empty">暂无成员,点击「编辑成员」添加设备</span>
        </div>
        <div class="group-actions">
          <el-button size="small" :icon="Monitor" :disabled="onlineCount(g) === 0" @click="controlGroup(g)">控制</el-button>
          <el-button size="small" :icon="Edit" @click="openEditMembers(g)">编辑成员</el-button>
          <el-button size="small" :icon="EditPen" @click="openRename(g)">重命名</el-button>
          <el-popconfirm
            title="确定删除该群组?组队列与成员集合将一并删除"
            confirm-button-text="删除"
            cancel-button-text="取消"
            width="240"
            @confirm="removeGroup(g)"
          >
            <template #reference>
              <el-button size="small" type="danger" :icon="Delete" plain>删除</el-button>
            </template>
          </el-popconfirm>
        </div>
      </div>
      <el-empty v-if="!loading && groups.length === 0" description="暂无群组">
        <el-button type="primary" :icon="Plus" @click="openCreate">新建群组</el-button>
      </el-empty>
    </div>

    <!-- Create / edit group dialog (name + full member set) -->
    <el-dialog
      v-model="showDialog"
      :title="editingGroup ? `编辑群组 - ${editingGroup.name}` : '新建群组'"
      width="480px"
    >
      <div class="dialog-field">
        <div class="dialog-label">群组名称</div>
        <el-input v-model="formName" placeholder="输入群组名称(必填,≤50 字符)" maxlength="50" />
      </div>
      <div class="dialog-field">
        <div class="dialog-label">成员设备</div>
        <div class="device-list">
          <div
            v-for="dev in dlnaDevices"
            :key="dev.id"
            class="device-item"
            :class="{ checked: formMembers.includes(dev.id) }"
            @click="toggleMember(dev)"
          >
            <el-checkbox
              :model-value="formMembers.includes(dev.id)"
              @change="(v: any) => setChecked(dev.id, !!v)"
              @click.stop
            />
            <el-icon class="device-icon" :class="{ offline: !dev.available }"><Monitor /></el-icon>
            <div class="device-info">
              <div class="device-name">
                {{ dev.name }}
                <span v-if="!dev.available" class="device-offline-tag">离线</span>
              </div>
              <div class="device-meta">
                {{ dev.manufacturer || dev.model || "DLNA 设备" }}
                <span v-if="otherGroupsOf(dev.id).length > 0" class="device-group-tip">
                  已在 {{ otherGroupsOf(dev.id).join("、") }}
                </span>
              </div>
            </div>
          </div>
          <div v-if="dlnaDevices.length === 0" class="device-empty">
            未发现 DLNA 设备。请确认设备已开启 DLNA 并处于同一局域网,稍后可在播放器管理中扫描。
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="showDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!formName.trim()" @click="saveGroup">
          {{ editingGroup ? "保存" : "创建" }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Rename-only dialog (quick action, keeps member edits untouched) -->
    <el-dialog v-model="showRenameDialog" title="重命名群组" width="380px">
      <el-input v-model="renameName" placeholder="输入新的群组名称" maxlength="50" @keyup.enter="saveRename" />
      <template #footer>
        <el-button @click="showRenameDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!renameName.trim()" @click="saveRename">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { usePlayerStore } from "@/stores/player";
import { Box, Plus, Edit, EditPen, Delete, Monitor } from "@element-plus/icons-vue";
import api from "@/api";

const playerStore = usePlayerStore();

const groups = ref<any[]>([]);
const dlnaDevices = ref<any[]>([]);
const loading = ref(false);
const saving = ref(false);

const showDialog = ref(false);
const editingGroup = ref<any>(null);
const formName = ref("");
const formMembers = ref<string[]>([]);

const showRenameDialog = ref(false);
const renameGroup = ref<any>(null);
const renameName = ref("");

function onlineCount(g: any): number {
  return (g.members || []).filter((m: any) => m.available).length;
}

// deviceId → 除当前编辑组外,还属于哪些组(仅展示提示,不阻止多组加入)。
function otherGroupsOf(deviceId: string): string[] {
  const out: string[] = [];
  for (const g of groups.value) {
    if (g.id === editingGroup.value?.id) continue;
    if ((g.memberIds || []).includes(deviceId)) out.push(g.name || g.id);
  }
  return out;
}

async function loadGroups(): Promise<void> {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/groups");
    groups.value = res.data?.groups || [];
  } catch { groups.value = []; }
  finally { loading.value = false; }
}

async function loadDlnaDevices(): Promise<void> {
  try {
    const res = await api.get("/rest/api/v1/dlna/devices");
    dlnaDevices.value = res.data?.devices || [];
  } catch { dlnaDevices.value = []; }
}

async function openCreate() {
  editingGroup.value = null;
  formName.value = "";
  formMembers.value = [];
  if (dlnaDevices.value.length === 0) await loadDlnaDevices();
  showDialog.value = true;
}

async function openEditMembers(g: any) {
  editingGroup.value = g;
  formName.value = g.name;
  formMembers.value = [...(g.memberIds || [])];
  if (dlnaDevices.value.length === 0) await loadDlnaDevices();
  showDialog.value = true;
}

function openRename(g: any) {
  renameGroup.value = g;
  renameName.value = g.name;
  showRenameDialog.value = true;
}

function toggleMember(dev: any) {
  const idx = formMembers.value.indexOf(dev.id);
  if (idx >= 0) formMembers.value.splice(idx, 1);
  else formMembers.value.push(dev.id);
}
function setChecked(deviceId: string, checked: boolean) {
  const idx = formMembers.value.indexOf(deviceId);
  if (checked && idx < 0) formMembers.value.push(deviceId);
  if (!checked && idx >= 0) formMembers.value.splice(idx, 1);
}

async function saveGroup() {
  const name = formName.value.trim();
  if (!name) { ElMessage.warning("请填写群组名称"); return; }
  if (saving.value) return;
  saving.value = true;
  try {
    if (editingGroup.value) {
      await api.put(`/rest/api/v1/groups/${editingGroup.value.id}`, {
        name,
        memberIds: formMembers.value,
      });
      ElMessage.success("群组已更新");
    } else {
      await api.post("/rest/api/v1/groups", { name, memberIds: formMembers.value });
      ElMessage.success("群组已创建");
    }
    showDialog.value = false;
    await loadGroups();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "保存失败");
  } finally { saving.value = false; }
}

async function saveRename() {
  const name = renameName.value.trim();
  if (!name || !renameGroup.value) return;
  if (saving.value) return;
  saving.value = true;
  try {
    await api.put(`/rest/api/v1/groups/${renameGroup.value.id}`, { name });
    ElMessage.success("已重命名");
    showRenameDialog.value = false;
    await loadGroups();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "重命名失败");
  } finally { saving.value = false; }
}

async function removeGroup(g: any) {
  try {
    await api.delete(`/rest/api/v1/groups/${g.id}`);
    ElMessage.success(`已删除「${g.name}」`);
    await loadGroups();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || "删除失败");
  }
}

// Switch the player bar to this group (peerId = group:<id>) so its controls
// and queue start routing to the group.
function controlGroup(g: any) {
  playerStore.switchPeer(`group:${g.id}`).then(() => playerStore.refreshPeers());
  ElMessage.success(`已切换到「${g.name}」`);
}

// Backend broadcasts group_changed / group_deleted over the WS channel; the
// player store bumps groupVersion so this page reloads live (no polling).
watch(() => playerStore.groupVersion, () => { loadGroups(); });

onMounted(loadGroups);
</script>

<style lang="scss" scoped>
.groups-page { padding: 20px 24px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.groups-tip {
  font-size: 12px; color: #909399; background: #f7f8fa; border: 1px solid #f0f0f0;
  border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; line-height: 1.6;
}
.group-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
.group-card {
  background: #fff; border: 1px solid #f0f0f0; border-radius: 10px; padding: 16px;
  transition: box-shadow 0.2s; &:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
  .group-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .group-name { display: flex; align-items: center; gap: 8px; min-width: 0;
    .group-name-icon { color: #c35f33; font-size: 18px; flex-shrink: 0; }
    .group-name-text { font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  }
  .group-meta { font-size: 12px; color: #909399; white-space: nowrap;
    .meta-dot { margin: 0 4px; }
    .online { color: #67c23a; }
  }
  .group-members { display: flex; flex-wrap: wrap; gap: 6px; min-height: 28px; margin-bottom: 14px;
    .member-chip { display: inline-flex; align-items: center; gap: 4px; background: #f2f3f5; border-radius: 12px;
      padding: 3px 10px; font-size: 12px; color: #333;
      &.offline { color: #999; }
      .member-offline { font-size: 11px; background: #c0c4cc; color: #fff; border-radius: 8px; padding: 0 6px; }
    }
    .member-empty { color: #bbb; font-size: 12px; align-self: center; }
  }
  .group-actions { display: flex; gap: 8px; }
}
@media (max-width: 768px) {
  .group-list { grid-template-columns: 1fr; }
  .group-card { padding: 12px; }
  .group-card-head { flex-direction: column; align-items: flex-start; gap: 6px; }
  .group-actions { flex-wrap: wrap; }
  .group-actions .el-button { margin-left: 0; }
  .groups-tip { padding: 8px 10px; }
}
.dialog-field { margin-bottom: 16px;
  .dialog-label { font-size: 13px; font-weight: 500; color: #606266; margin-bottom: 8px; }
}
.device-list { max-height: 300px; overflow-y: auto; border: 1px solid #f0f0f0; border-radius: 8px; padding: 4px; }
.device-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; transition: background 0.15s;
  &:hover { background: #f5f7fa; }
  &.checked { background: #fdf0ea; }
  .device-icon { font-size: 16px; color: #c35f33;
    &.offline { color: #c0c4cc; }
  }
  .device-info { flex: 1; min-width: 0;
    .device-name { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px;
      .device-offline-tag { font-size: 11px; background: #c0c4cc; color: #fff; border-radius: 8px; padding: 0 6px; }
    }
    .device-meta { font-size: 12px; color: #999; margin-top: 2px;
      .device-group-tip { color: #909399; margin-left: 6px; }
    }
  }
}
.device-empty { text-align: center; color: #999; font-size: 12px; padding: 24px 0; }
</style>