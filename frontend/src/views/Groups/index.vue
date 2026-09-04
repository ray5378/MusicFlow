<template>
  <div class="groups-page">
    <div class="page-header">
      <h2>{{ t('groups.title') }}</h2>
      <el-button v-if="canUse" type="primary" @click="openCreate"><MfIcon name="Plus" />{{ t('groups.create') }}</el-button>
    </div>

    <!-- DLNA 设备管理:在线 + 离线全部展示,可重命名 / 删除离线设备 -->
    <div class="devices-section">
      <div class="section-head">
        <h3>{{ t('groups.dlnaDevices') }}</h3>
        <el-button v-if="canUse" size="small" :loading="scanning" @click="scanDevices"><MfIcon name="RefreshCw" />{{ t('groups.scan') }}</el-button>
      </div>
      <div class="devices-box" v-loading="loadingDevices">
        <div v-for="dev in dlnaDevices" :key="dev.id" class="device-row" :class="{ 'is-disabled': dev.disabled }">
          <MfIcon name="Monitor" class="device-row-icon" :class="{ offline: !dev.available }" />
          <div class="device-row-info">
            <div class="device-row-name">
              {{ deviceDisplayName(dev, `dlna:${dev.id}`) }}
              <el-tag v-if="isDeviceRenamed(dev, `dlna:${dev.id}`)" size="small" type="warning" style="margin-left: 6px">{{ t('groups.renamed') }}</el-tag>
              <span v-if="!dev.available" class="device-offline-tag">{{ t('groups.offline') }}</span>
              <el-tag v-if="dev.disabled" size="small" type="danger" style="margin-left: 6px">{{ t('common.disabled') }}</el-tag>
            </div>
            <div class="device-row-meta">{{ dev.manufacturer || dev.model || t('groups.dlnaDeviceMeta') }}</div>
          </div>
          <div class="device-row-actions">
            <div class="device-hide-toggle" :title="t('groups.hideToggleTitle')">
              <el-switch
                :model-value="isHidden(`dlna:${dev.id}`)"
                @change="(v: any) => setPeerHidden(`dlna:${dev.id}`, !!v)"
                inline-prompt :active-text="t('groups.hide')" :inactive-text="t('groups.show')" size="small"
              />
            </div>
            <el-popconfirm
              v-if="canManage"
              :title="dev.disabled
                ? t('groups.enableConfirm', { name: deviceDisplayName(dev, `dlna:${dev.id}`) })
                : t('groups.disableConfirm', { name: deviceDisplayName(dev, `dlna:${dev.id}`) })"
              :confirm-button-text="dev.disabled ? t('groups.enable') : t('groups.disable')"
              :confirm-button-type="dev.disabled ? 'primary' : 'danger'"
              :cancel-button-text="t('common.cancel')"
              width="320"
              @confirm="toggleDisabled(dev, !dev.disabled)"
            >
              <template #reference>
                <el-button
                  size="small"
                  :type="dev.disabled ? 'danger' : ''"
                  :plain="!dev.disabled"
                  class="device-disable-btn"
                >
                  <MfIcon name="CircleSlash" />{{ dev.disabled ? t('groups.enable') : t('groups.disable') }}
                </el-button>
              </template>
            </el-popconfirm>
            <el-button v-if="canUse" size="small" @click="openRenameDevice(dev)"><MfIcon name="Pencil" />{{ t('groups.rename') }}</el-button>
            <el-popconfirm
              v-if="canManage && !dev.available"
              :title="t('groups.deleteDeviceConfirm')"
              :confirm-button-text="t('common.delete')"
              :cancel-button-text="t('common.cancel')"
              width="240"
              @confirm="removeDevice(dev)"
            >
              <template #reference>
                <el-button size="small" type="danger" plain><MfIcon name="Trash2" />{{ t('groups.delete') }}</el-button>
              </template>
            </el-popconfirm>
          </div>
        </div>
        <div v-if="!loadingDevices && dlnaDevices.length === 0" class="device-empty">
          {{ t('groups.noDlnaDevices') }}
        </div>
      </div>
    </div>

    <!-- AirPlay 设备管理(mDNS 自动发现;可像 DLNA 设备一样重命名 / 禁用 / 删除) -->
    <div class="devices-section" style="margin-top: 28px">
      <div class="section-head">
        <h3>{{ t('groups.airplayDevices') }}</h3>
        <el-button size="small" :loading="loadingAirPlay" @click="loadAirPlayDevices"><MfIcon name="RefreshCw" />{{ t('groups.refresh') }}</el-button>
      </div>
      <div class="section-note">{{ t('groups.airplayNote') }}</div>
      <div class="devices-box" v-loading="loadingAirPlay">
        <div v-for="dev in airplayDevices" :key="dev.id" class="device-row" :class="{ 'is-disabled': dev.disabled }">
          <MfIcon name="Airplay" class="device-row-icon" :class="{ offline: !dev.available }"  />
          <div class="device-row-info">
            <div class="device-row-name">
              {{ deviceDisplayName(dev, `airplay:${dev.id}`) }}
              <el-tag v-if="isDeviceRenamed(dev, `airplay:${dev.id}`)" size="small" type="warning" style="margin-left: 6px">{{ t('groups.renamed') }}</el-tag>
              <span v-if="!dev.available" class="device-offline-tag">{{ t('groups.offline') }}</span>
              <el-tag v-if="dev.disabled" size="small" type="danger" style="margin-left: 6px">{{ t('common.disabled') }}</el-tag>
            </div>
            <div class="device-row-meta">
              {{ t('groups.airplayMeta', { enc: dev.supportsRsa ? t('groups.rsaEnc') : t('groups.noEnc'), host: dev.host, port: dev.port }) }}
            </div>
          </div>
          <div class="device-row-actions">
            <div class="device-hide-toggle" :title="t('groups.hideToggleTitle')">
              <el-switch
                :model-value="isHidden(`airplay:${dev.id}`)"
                @change="(v: any) => setPeerHidden(`airplay:${dev.id}`, !!v)"
                inline-prompt :active-text="t('groups.hide')" :inactive-text="t('groups.show')" size="small"
              />
            </div>
            <el-popconfirm
              v-if="canManage"
              :title="dev.disabled
                ? t('groups.enableConfirm', { name: deviceDisplayName(dev, `airplay:${dev.id}`) })
                : t('groups.disableConfirmAir', { name: deviceDisplayName(dev, `airplay:${dev.id}`) })"
              :confirm-button-text="dev.disabled ? t('groups.enable') : t('groups.disable')"
              :confirm-button-type="dev.disabled ? 'primary' : 'danger'"
              :cancel-button-text="t('common.cancel')"
              width="320"
              @confirm="toggleAirPlayDisabled(dev, !dev.disabled)"
            >
              <template #reference>
                <el-button
                  size="small"
                  :type="dev.disabled ? 'danger' : ''"
                  :plain="!dev.disabled"
                  class="device-disable-btn"
                >
                  <MfIcon name="CircleSlash" />{{ dev.disabled ? t('groups.enable') : t('groups.disable') }}
                </el-button>
              </template>
            </el-popconfirm>
            <el-button v-if="canUse" size="small" @click="openRenameAirPlayDevice(dev)"><MfIcon name="Pencil" />{{ t('groups.rename') }}</el-button>
            <el-popconfirm
              v-if="canManage && !dev.available"
              :title="t('groups.deleteDeviceConfirmShort')"
              :confirm-button-text="t('common.delete')"
              :cancel-button-text="t('common.cancel')"
              width="240"
              @confirm="removeAirPlayDevice(dev)"
            >
              <template #reference>
                <el-button size="small" type="danger" plain><MfIcon name="Trash2" />{{ t('groups.delete') }}</el-button>
              </template>
            </el-popconfirm>
          </div>
        </div>
        <div v-if="!loadingAirPlay && airplayDevices.length === 0" class="device-empty">
          {{ t('groups.noAirplayDevices') }}
        </div>
      </div>
    </div>

    <div class="section-head group-section-head">
      <h3>{{ t('groups.groupsTitle') }}</h3>
    </div>
    <div class="groups-tip">
      {{ t('groups.tip1') }}
      {{ t('groups.tip2') }}
      {{ t('groups.tip3') }}
    </div>

    <div class="group-list" v-loading="loading">
      <div v-for="g in groups" :key="g.id" class="group-card">
        <div class="group-card-head">
          <div class="group-name">
            <MfIcon name="Box" class="group-name-icon"  />
            <span class="group-name-text">{{ g.name }}</span>
          </div>
          <div class="group-meta">
            <span>{{ t('groups.deviceCount', { count: g.members.length }) }}</span>
            <span class="meta-dot">·</span>
            <span :class="{ 'online': onlineCount(g) > 0 }">{{ t('groups.onlineCount', { count: onlineCount(g) }) }}</span>
          </div>
        </div>
        <div class="group-id-row">
          <IdBadge :id="`group:${g.id}`" :copy-label="t('groups.groupId')" />
        </div>
        <div class="group-members">
          <template v-if="g.members.length > 0">
            <span
              v-for="m in g.members"
              :key="m.deviceId"
              class="member-chip"
              :class="{ offline: !m.available }"
              @click="copyPeer(`dlna:${m.deviceId}`, m.name)"
              :title="t('groups.copyDeviceId', { id: m.deviceId })"
            >
              {{ m.name }}
              <MfIcon name="CopyDocument" class="member-copy-icon"  />
              <span v-if="!m.available" class="member-offline">{{ t('groups.offline') }}</span>
            </span>
          </template>
          <span v-else class="member-empty">{{ t('groups.noMembers') }}</span>
        </div>
        <div class="group-actions">
          <div class="device-hide-toggle" :title="t('groups.hideToggleGroupTitle')">
            <el-switch
              :model-value="isHidden(`group:${g.id}`)"
              @change="(v: any) => setPeerHidden(`group:${g.id}`, !!v)"
              inline-prompt :active-text="t('groups.hide')" :inactive-text="t('groups.show')" size="small"
            />
          </div>
          <el-button size="small" :disabled="onlineCount(g) === 0" @click="controlGroup(g)"><MfIcon name="Monitor" />{{ t('groups.control') }}</el-button>
          <el-button v-if="canUse" size="small" @click="openEditMembers(g)"><MfIcon name="Pencil" />{{ t('groups.editMembers') }}</el-button>
          <el-button v-if="canUse" size="small" @click="openRename(g)"><MfIcon name="Pencil" />{{ t('groups.rename') }}</el-button>
          <el-popconfirm
            v-if="canUse"
            :title="t('groups.deleteGroupConfirm')"
            :confirm-button-text="t('common.delete')"
            :cancel-button-text="t('common.cancel')"
            width="240"
            @confirm="removeGroup(g)"
          >
            <template #reference>
              <el-button size="small" type="danger" plain><MfIcon name="Trash2" />{{ t('groups.delete') }}</el-button>
            </template>
          </el-popconfirm>
        </div>
      </div>
      <el-empty v-if="!loading && groups.length === 0" :description="t('groups.noGroups')">
        <el-button v-if="canUse" type="primary" @click="openCreate"><MfIcon name="Plus" />{{ t('groups.create') }}</el-button>
      </el-empty>
    </div>

    <!-- Create / edit group dialog (name + full member set) -->
    <el-dialog
      v-model="showDialog"
      :title="editingGroup ? t('groups.editGroup', { name: editingGroup.name }) : t('groups.create')"
      width="480px"
      :append-to-body="true"
    >
      <div class="dialog-field">
        <div class="dialog-label">{{ t('groups.nameLabel') }}</div>
        <el-input v-model="formName" :placeholder="t('groups.namePlaceholder')" maxlength="50" />
      </div>
      <div class="dialog-field">
        <div class="dialog-label">{{ t('groups.memberDevicesLabel') }}</div>
        <div class="device-list">
          <div
            v-for="dev in selectableDevices"
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
            <MfIcon name="Monitor" class="device-icon" :class="{ offline: !dev.available }"  />
            <div class="device-info">
              <div class="device-name">
                {{ dev.name }}
                <span v-if="!dev.available" class="device-offline-tag">{{ t('groups.offline') }}</span>
              </div>
              <div class="device-meta">
                {{ dev.manufacturer || dev.model || t('groups.dlnaDeviceMeta') }}
                <span v-if="otherGroupsOf(dev.id).length > 0" class="device-group-tip">
                  {{ t('groups.alreadyIn', { names: otherGroupsOf(dev.id).join("、") }) }}
                </span>
              </div>
            </div>
          </div>
          <div v-if="selectableDevices.length === 0" class="device-empty">
            {{ t('groups.noSelectableDevices') }}
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="showDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" :disabled="!formName.trim()" @click="saveGroup">
          {{ editingGroup ? t('common.save') : t('groups.createButton') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Rename-only dialog (quick action, keeps member edits untouched) -->
    <el-dialog v-model="showRenameDialog" :title="t('groups.renameGroup')" width="380px" :append-to-body="true">
      <el-input v-model="renameName" :placeholder="t('groups.renamePlaceholder')" maxlength="50" @keyup.enter="saveRename" />
      <template #footer>
        <el-button @click="showRenameDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" :disabled="!renameName.trim()" @click="saveRename">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <!-- Rename DLNA device (per-user display name) dialog -->
    <el-dialog v-model="showRenameDeviceDialog" :title="t('groups.renameDevice')" width="380px" :append-to-body="true">
      <el-input v-model="renameDeviceName" :placeholder="t('groups.renameDevicePlaceholder')" maxlength="50" @keyup.enter="saveRenameDevice" />
      <div class="form-tip">{{ t('groups.renameDeviceTip') }}</div>
      <template #footer>
        <el-button @click="showRenameDeviceDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="saveRenameDevice">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import { usePlayerStore } from "@/stores/player";
import { useAuthStore } from "@/stores/auth";
import { PERM } from "@/utils/perms";
import api from "@/api";
import IdBadge from "@/components/IdBadge.vue";
import { useCopy } from "@/composables/useCopy";

const { copy } = useCopy();
const { t } = useI18n();

const authStore = useAuthStore();
// 使用能力:管理员或具 renderer.use。拥有 use 的普通用户可:新建/删除自己的群组、扫描、
// 重命名(每用户显示名)、设置自己的显示/隐藏,并控制授权(或自建)的设备/群组。
const canUse = computed(() => authStore.isAdmin || authStore.hasPerm(PERM.RENDERER_USE));
// 管理能力:管理员或具 renderer.manage。仅 manage 可删除播放器设备本体、全局禁用。
// 删除设备是「根级」操作,普通用户一律不可(与 use 区分)。
const canManage = computed(() => authStore.isAdmin || authStore.hasPerm(PERM.RENDERER_MANAGE));

function copyPeer(peerId: string, name: string) {
  copy(peerId, t("groups.copyPeer", { name }));
}

const playerStore = usePlayerStore();

const groups = ref<any[]>([]);
const dlnaDevices = ref<any[]>([]);
const airplayDevices = ref<any[]>([]);
const loadingAirPlay = ref(false);
const loading = ref(false);
const saving = ref(false);

const showDialog = ref(false);
const editingGroup = ref<any>(null);
const formName = ref("");
const formMembers = ref<string[]>([]);

const showRenameDialog = ref(false);
const renameGroup = ref<any>(null);
const renameName = ref("");

// DLNA 设备管理(在线 + 离线)
const loadingDevices = ref(false);
const scanning = ref(false);
const showRenameDeviceDialog = ref(false);
const renameDeviceTarget = ref<any>(null);
const renameDeviceName = ref("");

function onlineCount(g: any): number {
  return (g.members || []).filter((m: any) => m.available).length;
}

// 每用户显示名:优先用「我」的改名覆盖,其次全局 alias,最后原始名。
// 改名是用户级动作(只影响我),故命名判定也用我自己的覆盖。
function deviceDisplayName(dev: any, peerId: string): string {
  return playerStore.getPeerName(peerId) || dev.alias || dev.name || dev.id || "";
}
function isDeviceRenamed(dev: any, peerId: string): boolean {
  return !!playerStore.getPeerName(peerId) || !!dev.alias;
}

// 群组编辑对话框可选成员:排除禁用设备(禁用设备不可加入/保留在群组中)。
const selectableDevices = computed(() =>
  (dlnaDevices.value || []).filter((d: any) => !d.disabled)
);

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
  loadingDevices.value = true;
  try {
    const res = await api.get("/rest/api/v1/dlna/devices");
    dlnaDevices.value = res.data?.devices || [];
  } catch { dlnaDevices.value = []; }
  finally { loadingDevices.value = false; }
}

async function scanDevices(): Promise<void> {
  scanning.value = true;
  try {
    const res = await api.post("/rest/api/v1/dlna/scan");
    dlnaDevices.value = res.data?.devices || [];
    ElMessage.success(t("groups.scanDone"));
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("groups.scanFailed"));
  } finally { scanning.value = false; }
}

function openRenameDevice(dev: any) {
  renameDeviceTarget.value = dev;
  renameDeviceName.value = playerStore.getPeerName(`dlna:${dev.id}`) || dev.alias || "";
  showRenameDeviceDialog.value = true;
}

async function saveRenameDevice() {
  const alias = renameDeviceName.value.trim();
  if (!renameDeviceTarget.value || saving.value) return;
  const isAirPlay = !!renameDeviceTarget.value.isAirPlay;
  const peerId = `${isAirPlay ? "airplay" : "dlna"}:${renameDeviceTarget.value.id}`;
  saving.value = true;
  try {
    // 按用户级改名:只改我自己看到的显示名,他人/设备原始名不受影响。
    const ok = await playerStore.setPeerName(peerId, alias);
    if (ok) {
      ElMessage.success(alias ? t("groups.renamedSelf") : t("groups.renamedReset"));
      showRenameDeviceDialog.value = false;
    } else {
      ElMessage.error(t("groups.renameFailedRollback"));
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("groups.renameFailed"));
  } finally { saving.value = false; }
}

async function removeDevice(dev: any) {
  try {
    await api.delete(`/rest/api/v1/dlna/devices/${dev.id}`);
    ElMessage.success(t("groups.deviceDeleted", { name: dev.displayName || dev.name }));
    await loadDlnaDevices();
    await loadGroups();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("groups.deleteFailed"));
  }
}

// 禁用/启用设备:禁用后设备从所有选择播放器的地方消失(切换器/HA 卡片/投屏),
// 后端会停止播放、清队列、移出群组并广播 peer_unavailable。
async function toggleDisabled(dev: any, disabled: boolean) {
  try {
    const res = await api.put(`/rest/api/v1/dlna/devices/${dev.id}/disabled`, { disabled });
    if (res.data.success) {
      ElMessage.success(disabled
        ? t("groups.disabledNamed", { name: dev.displayName || dev.name })
        : t("groups.enabledNamed", { name: dev.displayName || dev.name }));
      await loadDlnaDevices();
      await loadGroups(); // 禁用会把设备移出群组,组列表需要刷新
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("common.operationFailed"));
  }
}

async function loadAirPlayDevices(): Promise<void> {
  loadingAirPlay.value = true;
  try {
    const res = await api.get("/rest/api/v1/airplay/devices");
    airplayDevices.value = res.data?.devices || [];
  } catch { airplayDevices.value = []; }
  finally { loadingAirPlay.value = false; }
}

// ---- AirPlay 设备管理(对标 DLNA) ----
function openRenameAirPlayDevice(dev: any) {
  renameDeviceTarget.value = { ...dev, isAirPlay: true };
  renameDeviceName.value = playerStore.getPeerName(`airplay:${dev.id}`) || dev.alias || "";
  showRenameDeviceDialog.value = true;
}

async function removeAirPlayDevice(dev: any) {
  try {
    await api.delete(`/rest/api/v1/airplay/devices/${dev.id}`);
    ElMessage.success(t("groups.deviceDeleted", { name: dev.displayName || dev.name }));
    await loadAirPlayDevices();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("groups.deleteFailed"));
  }
}

async function toggleAirPlayDisabled(dev: any, disabled: boolean) {
  try {
    const res = await api.put(`/rest/api/v1/airplay/devices/${dev.id}/disabled`, { disabled });
    if (res.data.success) {
      ElMessage.success(disabled
        ? t("groups.disabledNamed", { name: dev.displayName || dev.name })
        : t("groups.enabledNamed", { name: dev.displayName || dev.name }));
      await loadAirPlayDevices();
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("common.operationFailed"));
  }
}

// 播放器「按用户级隐藏」偏好:peerId = "dlna:<id>" | "airplay:<id>" | "group:<id>"。
// 仅影响本人切换弹窗的显示,不禁用设备(他人/其他用户仍可用),独立于权限。
// 单一数据源在 player store(hiddenPeers),切换弹窗与之共用,保证隐藏后不重现。
function isHidden(peerId: string): boolean {
  return playerStore.isPeerHidden(peerId);
}

async function setPeerHidden(peerId: string, hidden: boolean) {
  const ok = await playerStore.setPeerHidden(peerId, hidden);
  ElMessage[ok ? "success" : "error"](ok
    ? (hidden ? t("groups.hiddenMsg") : t("groups.shownMsg"))
    : t("groups.opFailedRollback"));
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
  if (!name) { ElMessage.warning(t("groups.enterName")); return; }
  if (saving.value) return;
  saving.value = true;
  try {
    if (editingGroup.value) {
      await api.put(`/rest/api/v1/groups/${editingGroup.value.id}`, {
        name,
        memberIds: formMembers.value,
      });
      ElMessage.success(t("groups.updated"));
    } else {
      await api.post("/rest/api/v1/groups", { name, memberIds: formMembers.value });
      ElMessage.success(t("groups.groupCreated"));
    }
    showDialog.value = false;
    await loadGroups();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("groups.saveFailed"));
  } finally { saving.value = false; }
}

async function saveRename() {
  const name = renameName.value.trim();
  if (!name || !renameGroup.value) return;
  if (saving.value) return;
  saving.value = true;
  try {
    await api.put(`/rest/api/v1/groups/${renameGroup.value.id}`, { name });
    ElMessage.success(t("groups.renamed"));
    showRenameDialog.value = false;
    await loadGroups();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("groups.renameFailed"));
  } finally { saving.value = false; }
}

async function removeGroup(g: any) {
  try {
    await api.delete(`/rest/api/v1/groups/${g.id}`);
    ElMessage.success(t("groups.groupDeleted", { name: g.name }));
    await loadGroups();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("groups.deleteFailed"));
  }
}

// Switch the player bar to this group (peerId = group:<id>) so its controls
// and queue start routing to the group.
function controlGroup(g: any) {
  playerStore.switchPeer(`group:${g.id}`).then(() => playerStore.refreshPeers());
  ElMessage.success(t("groups.switchedTo", { name: g.name }));
}

// Backend broadcasts group_changed / group_deleted over the WS channel; the
// player store bumps groupVersion so this page reloads live (no polling).
watch(() => playerStore.groupVersion, () => { loadGroups(); });

onMounted(() => { loadGroups(); loadDlnaDevices(); loadAirPlayDevices(); playerStore.loadHiddenPrefs(); playerStore.loadNamePrefs(); });
</script>

<style lang="scss" scoped>
.groups-page { padding: 24px 32px 130px; max-width: 1100px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;
  h2 { font-size: 28px; font-weight: 700; margin: 0; }
}
.section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;
  h3 { font-size: 16px; font-weight: 600; margin: 0; color: var(--fnos-text-primary); }
}
.group-section-head { margin-top: 28px; }
.section-note { color: var(--fnos-text-tertiary); font-size: 12px; margin: -4px 0 12px; line-height: 1.6; }
.devices-box { border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 6px; background: rgba(0,0,0,0.15); min-height: 60px; }
.device-row { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 8px; transition: background 0.15s, border-color 0.15s; border: 1px solid transparent;
  &:hover { background: rgba(255,255,255,0.05); }
  &.is-disabled { opacity: 0.62; border-color: rgba(245,108,108,0.45); background: rgba(245,108,108,0.05);
    &:hover { background: rgba(245,108,108,0.08); }
    .device-row-icon { color: var(--fnos-text-muted); }
  }
  .device-disable-btn { min-width: 76px; }
  .device-row-icon { font-size: 17px; color: var(--fnos-orange); flex-shrink: 0;
    &.offline { color: var(--fnos-text-muted); }
  }
  .device-row-info { flex: 1; min-width: 0;
    .device-row-name { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px; color: var(--fnos-text-primary);
      .device-offline-tag { font-size: 11px; background: rgba(255,255,255,0.14); color: var(--fnos-text-secondary); border-radius: 8px; padding: 0 6px; }
    }
    .device-row-meta { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 2px; }
  }
  .device-row-actions { display: flex; gap: 8px; flex-shrink: 0; }
}
.device-hide-toggle { display: inline-flex; align-items: center; }
.group-actions .device-hide-toggle { margin-right: 2px; }
.group-actions .el-button { margin-left: 0; }
.device-empty { text-align: center; color: var(--fnos-text-tertiary); font-size: 12px; padding: 22px 0; }
.form-tip { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 6px; }
.groups-tip {
  font-size: 12px; color: var(--fnos-text-tertiary); background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08); border-left: 3px solid var(--fnos-orange);
  border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; line-height: 1.6;
}
.group-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
.group-card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
  border-radius: var(--fnos-radius); padding: 16px;
  transition: transform 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
  &:hover { transform: translateY(-2px); background: rgba(255,255,255,0.07); box-shadow: 0 12px 30px rgba(0,0,0,0.4); }
  &:active { transform: translateY(0) scale(0.99); }
  .group-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .group-name { display: flex; align-items: center; gap: 8px; min-width: 0;
    .group-name-icon { color: var(--fnos-orange); font-size: 18px; flex-shrink: 0; }
    .group-name-text { font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fnos-text-primary); }
  }
  .group-meta { font-size: 12px; color: var(--fnos-text-tertiary); white-space: nowrap;
    .meta-dot { margin: 0 4px; }
    .online { color: var(--fnos-green); }
  }
  .group-id-row { display: flex; margin-bottom: 12px; }
  .group-members { display: flex; flex-wrap: wrap; gap: 6px; min-height: 28px; margin-bottom: 14px;
    .member-chip { display: inline-flex; align-items: center; gap: 4px; background: rgba(255,255,255,0.08); border-radius: 12px;
      padding: 3px 10px; font-size: 12px; color: var(--fnos-text-primary-dim); cursor: pointer;
      transition: background 0.15s;
      &:hover { background: rgba(255,255,255,0.14); }
      .member-copy-icon { font-size: 11px; color: var(--fnos-text-tertiary); opacity: 0.6; }
      &.offline { color: var(--fnos-text-muted); }
      .member-offline { font-size: 11px; background: rgba(255,255,255,0.14); color: var(--fnos-text-secondary); border-radius: 8px; padding: 0 6px; }
    }
    .member-empty { color: var(--fnos-text-muted); font-size: 12px; align-self: center; }
  }
  .group-actions { display: flex; gap: 8px; }
}
@media (max-width: 768px) {
  .groups-page { padding: 20px 16px; }
  .group-list { grid-template-columns: 1fr; }
  .group-card { padding: 12px; }
  .group-card-head { flex-direction: column; align-items: flex-start; gap: 6px; }
  .group-actions { flex-wrap: wrap; }
  .group-actions .el-button { margin-left: 0; }
  .groups-tip { padding: 8px 10px; }
  // 设备行窄屏布局:信息区一行、操作按钮整行右对齐(允许换行)。
  // 修复:禁用设备(恢复/重命名/删除)按钮在 ≤360px 下把行挤爆/按钮越界的问题。
  .device-row { flex-wrap: wrap; }
  .device-row-info { flex: 1 1 calc(100% - 30px); }
  .device-row-actions {
    flex: 1 1 100%;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 6px;
    .el-button { margin-left: 0; }
  }
}
.dialog-field { margin-bottom: 16px;
  .dialog-label { font-size: 13px; font-weight: 500; color: var(--fnos-text-secondary); margin-bottom: 8px; }
}
.device-list { max-height: 300px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 4px; background: rgba(0,0,0,0.2); }
.device-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; transition: background 0.15s;
  &:hover { background: rgba(255,255,255,0.06); }
  &.checked { background: var(--fnos-red-soft); }
  .device-icon { font-size: 16px; color: var(--fnos-orange);
    &.offline { color: var(--fnos-text-muted); }
  }
  .device-info { flex: 1; min-width: 0;
    .device-name { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px; color: var(--fnos-text-primary);
      .device-offline-tag { font-size: 11px; background: rgba(255,255,255,0.14); color: var(--fnos-text-secondary); border-radius: 8px; padding: 0 6px; }
    }
    .device-meta { font-size: 12px; color: var(--fnos-text-tertiary); margin-top: 2px;
      .device-group-tip { color: var(--fnos-text-secondary); margin-left: 6px; }
    }
  }
}
.device-empty { text-align: center; color: var(--fnos-text-tertiary); font-size: 12px; padding: 24px 0; }
</style>