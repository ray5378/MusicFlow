<template>
  <div class="groups-page">
    <div class="page-header">
      <h2>{{ t('groups.title') }}</h2>
      <el-button v-if="canUse" type="primary" @click="openCreate"><MfIcon name="Plus" />{{ t('groups.create') }}</el-button>
    </div>

    <!-- 客户端(Android / Windows 原生客户端的本机播放):**与 DLNA 设备行完全同构**。
         数据源同 DLNA —— 页面本地列表(取自 /v1/peers?includeHidden=1,未按隐藏剪枝),
         所以「隐藏」开关拨动后行仍在、可反复切换;离线实例保留显示并打「离线」标签,
         与 DLNA 离线设备的表现一致(不消失)。
         本机实例按「账号」可见:同账号的每个客户端各占一行,各带自己的播放队列。
         此处**不判本机**(不置顶、不打「本机」角标)—— 谁是本机只在「能播放的选择器」
         界面里判定;这一页只按设备名片显示,同一个实例在客户端上显示机型名、在网页上
         显示「浏览器 · 系统」。 -->
    <div class="devices-section">
      <div class="section-head">
        <h3>{{ t('groups.clientPlayers') }}</h3>
        <el-button size="small" :loading="loadingClients" @click="loadLocalPlayers"><MfIcon name="RefreshCw" />{{ t('groups.refresh') }}</el-button>
      </div>
      <div class="section-note">{{ t('groups.clientPlayersNote') }}</div>
      <div class="devices-box" v-loading="loadingClients">
        <div v-for="p in clientPlayers" :key="p.peerId" class="device-row">
          <MfIcon :name="localPeerIcon(p)" class="device-row-icon" :class="{ offline: p.available === false }" />
          <div class="device-row-info">
            <div class="device-row-name">
              {{ localPeerLabel(p) }}
              <el-tag v-if="isLocalPeerRenamed(p)" size="small" type="warning" style="margin-left: 6px">{{ t('groups.renamed') }}</el-tag>
              <span v-if="p.available === false" class="device-offline-tag">{{ t('groups.offline') }}</span>
            </div>
            <div class="device-row-meta">{{ localPeerMeta(p) }}</div>
          </div>
          <div class="device-row-actions">
            <div class="device-hide-toggle" :title="t('groups.hideToggleTitle')">
              <el-switch
                :model-value="isHidden(localPeerPrefKey(p))"
                @change="(v: any) => setPeerHidden(localPeerPrefKey(p), !!v)"
                inline-prompt :active-text="t('groups.hide')" :inactive-text="t('groups.show')" size="small"
              />
            </div>
            <el-button v-if="canUse" size="small" @click="openRenameLocalPeer(p)"><MfIcon name="Pencil" />{{ t('groups.rename') }}</el-button>
          </div>
        </div>
        <div v-if="!loadingClients && clientPlayers.length === 0" class="device-empty">
          {{ t('groups.noClientPlayers') }}
        </div>
      </div>
    </div>

    <!-- DLNA 设备管理:在线 + 离线全部展示,可重命名 / 删除离线设备 -->
    <div class="devices-section" style="margin-top: 28px">
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

    <!-- Sendspin 设备管理(客户端拨入为主;也可手动拨号添加;配对/批准在设置页) -->
    <div class="devices-section" style="margin-top: 28px">
      <div class="section-head">
        <h3>{{ t('groups.sendspinDevices') }}</h3>
        <el-button size="small" :loading="loadingSendspin" @click="loadSendspinClients"><MfIcon name="RefreshCw" />{{ t('groups.refresh') }}</el-button>
        <el-button v-if="canManage" size="small" type="primary" @click="showDialDialog = true"><MfIcon name="Plus" />{{ t('groups.sendspinAdd') }}</el-button>
      </div>
      <div class="section-note">{{ t('groups.sendspinNote', { url: sendspinUrl }) }}</div>
      <div class="devices-box" v-loading="loadingSendspin">
        <div v-for="dev in sendspinClients" :key="dev.clientId" class="device-row">
          <MfIcon name="Speaker" class="device-row-icon" />
          <div class="device-row-info">
            <div class="device-row-name">
              {{ deviceDisplayName(dev, `sendspin:${dev.clientId}`) }}
              <el-tag v-if="isDeviceRenamed(dev, `sendspin:${dev.clientId}`)" size="small" type="warning" style="margin-left: 6px">{{ t('groups.renamed') }}</el-tag>
              <el-tag v-if="dev.paired" size="small" type="success" style="margin-left: 6px">{{ t('groups.sendspinPaired') }}</el-tag>
              <el-tag v-else-if="dev.legacy" size="small" type="warning" style="margin-left: 6px">{{ t('groups.sendspinLegacy') }}</el-tag>
              <el-tag v-else size="small" type="info" style="margin-left: 6px">{{ t('groups.sendspinUnpaired') }}</el-tag>
              <el-tag v-if="!dev.paired && !dev.legacy && dev.approved" size="small" style="margin-left: 6px">{{ t('groups.sendspinApproved') }}</el-tag>
            </div>
            <div class="device-row-meta">{{ shortClientId(dev.clientId) }} · {{ (dev.roles || []).join(", ") }}</div>
          </div>
          <div class="device-row-actions">
            <div class="device-hide-toggle" :title="t('groups.hideToggleTitle')">
              <el-switch
                :model-value="isHidden(`sendspin:${dev.clientId}`)"
                @change="(v: any) => setPeerHidden(`sendspin:${dev.clientId}`, !!v)"
                inline-prompt :active-text="t('groups.hide')" :inactive-text="t('groups.show')" size="small"
              />
            </div>
            <el-button v-if="canUse && !dev.paired && !dev.legacy" size="small" @click="openPairDialog(dev)"><MfIcon name="KeyRound" />{{ t('groups.sendspinPair') }}</el-button>
            <el-button v-if="canManage && !dev.paired && !dev.legacy" size="small" @click="approveSendspin(dev, !dev.approved)">{{ dev.approved ? t('groups.sendspinUnapprove') : t('groups.sendspinApprove') }}</el-button>
            <el-popconfirm
              v-if="canManage && dev.paired"
              :title="t('groups.sendspinUnpairConfirm', { name: deviceDisplayName(dev, `sendspin:${dev.clientId}`) })"
              :confirm-button-text="t('common.confirm')"
              :cancel-button-text="t('common.cancel')"
              width="280"
              @confirm="unpairSendspin(dev)"
            >
              <template #reference>
                <el-button size="small" type="danger" plain><MfIcon name="Trash2" />{{ t('groups.sendspinUnpair') }}</el-button>
              </template>
            </el-popconfirm>
            <el-button v-if="canUse" size="small" @click="openRenameSendspinDevice(dev)"><MfIcon name="Pencil" />{{ t('groups.rename') }}</el-button>
          </div>
        </div>
        <div v-if="!loadingSendspin && sendspinClients.length === 0" class="device-empty">
          {{ t('groups.noSendspinDevices') }}
        </div>
      </div>
      <div v-if="dialTargets.length" class="remembered-box">
        <div class="remembered-title">{{ t('groups.sendspinRemembered') }}</div>
        <div v-for="tg in dialTargets" :key="`${tg.host}:${tg.port}`" class="device-row">
          <MfIcon name="Speaker" class="device-row-icon" :class="{ offline: !tg.online }" />
          <div class="device-row-info">
            <div class="device-row-name">
              {{ tg.host }}:{{ tg.port }}
              <el-tag v-if="tg.online" size="small" type="success" style="margin-left: 6px">{{ t('groups.online') }}</el-tag>
              <el-tag v-else size="small" type="info" style="margin-left: 6px">{{ t('groups.offline') }}</el-tag>
            </div>
          </div>
          <div class="device-row-actions">
            <el-button v-if="!tg.online" size="small" @click="redialTarget(tg)">{{ t('groups.sendspinReconnect') }}</el-button>
            <el-popconfirm
              :title="t('groups.sendspinForgetConfirm', { name: `${tg.host}:${tg.port}` })"
              :confirm-button-text="t('common.delete')"
              :cancel-button-text="t('common.cancel')"
              width="260"
              @confirm="forgetTarget(tg)"
            >
              <template #reference>
                <el-button size="small" type="danger" plain><MfIcon name="Trash2" />{{ t('common.delete') }}</el-button>
              </template>
            </el-popconfirm>
          </div>
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

    <el-dialog v-model="showDialDialog" :title="t('groups.sendspinAdd')" width="420px" :append-to-body="true">
      <div class="form-tip">{{ t('groups.sendspinDialTip') }}</div>
      <el-input v-model="dialHost" :placeholder="t('groups.sendspinDialPh')" clearable @keyup.enter="dialPlayer" />
      <div style="margin-top: 10px; display: flex; gap: 8px; align-items: center">
        <span style="font-size: 12px; color: var(--fnos-text-secondary)">{{ t('groups.sendspinDialPort') }}</span>
        <el-input-number v-model="dialPort" :min="1" :max="65535" size="small" />
      </div>
      <template #footer>
        <el-button @click="showDialDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="dialing" @click="dialPlayer">{{ t('common.confirm') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showPairDialog" :title="t('groups.sendspinPairTitle')" width="760px" :append-to-body="true" @closed="loadSendspinClients">
      <SendspinPairing :client-id="pairTarget" />
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
import SendspinPairing from "@/views/Settings/SendspinPairing.vue";
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

// ---- 本机播放器实例(仅「客户端」模块) ----
// 服务端把同账号的每个本机实例各返一行(kind === "local"),自带设备名片
// platform/model。本机实例只列「客户端」(web 平台经 clientPlayers 过滤排除)。
//
// **与 DLNA 设备模块同构**:数据源是页面本地列表(同 DLNA 的 dlnaDevices),不订阅 WS;
// 行**不因隐藏而消失**,离线实例保留显示并打「离线」标签。因此这里用
// `/v1/peers?includeHidden=1` —— 服务端在这种模式下不剪掉该用户隐藏的行,改为逐条打
// hidden 标记。用默认的 /v1/peers 会拿不到隐藏行,表现为「一拨隐藏,行就没了,
// 再也取消不回来」(强刷也救不回,因为隐藏行本就不在默认响应里)。
//
// 这一页**不判本机**:不置顶、不打「本机」角标 —— 谁是本机只在「能播放的选择器」
// 界面里判定(MainLayout 的切换器)。此处名字一律取「用户改名 → 设备名片 → 上报名的
// 兜底」,所以同一个实例在客户端上显示机型名、在网页上显示「浏览器 · 系统」。
const playerInstances = ref<any[]>([]);
const loadingClients = ref(false);

/** 本机实例的**偏好键**(隐藏 / 改名都按它存):一律按「实例」而非「账号」。
 *  自己那条的对外 peerId 是账号级的 local:<uid>,拿它当偏好键会串味 ——
 *  在手机上给「本机」改名,电脑上的「本机」会跟着变。服务端为此额外下发
 *  instancePeerId(不可逆实例键),它才是稳定且唯一的那把钥匙。 */
function localPeerPrefKey(p: any): string {
  return p?.instancePeerId || p?.peerId || "";
}

async function loadLocalPlayers(): Promise<void> {
  loadingClients.value = true;
  try {
    const res = await api.get("/rest/api/v1/peers?includeHidden=1");
    playerInstances.value = (res.data?.peers || []).filter((p: any) => p.kind === "local");
  } catch { playerInstances.value = []; }
  finally { loadingClients.value = false; }
}

// 本机实例只列「客户端」(windows/macos/linux/android 等);web 平台不在此展示
// (播放器统一化方案收敛:Web 仅作遥控面 + 自身本机播放,不再作为可管理/被控端)。
const clientPlayers = computed(() => playerInstances.value.filter((p: any) => p.platform !== "web"));

/** 本机实例的显示名:我改过的名优先,其次设备名片(机型名 / 浏览器·系统),最后上报名。 */
function localPeerLabel(p: any): string {
  return playerStore.getPeerName(localPeerPrefKey(p)) || p.model || p.name || t("groups.localPlayerFallback");
}
function isLocalPeerRenamed(p: any): boolean {
  return !!playerStore.getPeerName(localPeerPrefKey(p));
}

/** 平台标签:Android / Windows / iOS / macOS / 网页,未知时原样回显平台串。 */
function platformLabel(platform?: string): string {
  switch (platform) {
    case "web": return t("groups.platformWeb");
    case "android": return "Android";
    case "windows": return "Windows";
    case "ios": return "iOS";
    case "macos": return "macOS";
    case "linux": return "Linux";
    default: return platform || t("groups.platformUnknown");
  }
}

function localPeerIcon(p: any): string {
  if (p.platform === "windows" || p.platform === "macos" || p.platform === "linux") return "Laptop";
  return "Smartphone";
}

/** 副标题:未改名时名字本身就是机型名,不重复展示;改名后补上机型避免信息丢失。 */
function localPeerMeta(p: any): string {
  const plat = platformLabel(p.platform);
  return isLocalPeerRenamed(p) && p.model ? `${plat} · ${p.model}` : plat;
}

function openRenameLocalPeer(p: any) {
  // 本机实例不是 dlna/airplay/sendspin,拼不出前缀 id —— 直接把**偏好键**带进弹窗,
  // 提交时原样使用(见 saveRenameDevice 的 peerId 分支)。
  renameDeviceTarget.value = { ...p, isLocalPeer: true, peerId: localPeerPrefKey(p) };
  renameDeviceName.value = playerStore.getPeerName(localPeerPrefKey(p)) || "";
  showRenameDeviceDialog.value = true;
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
  const isSendspin = !!renameDeviceTarget.value.isSendspin;
  // 本机实例(安卓 / Windows / 网页)在 openRenameLocalPeer 里已经带了**偏好键**,
  // 原样使用即可 —— 绝不能落到下面的 dlna: 分支(那会拼出 "dlna:undefined",
  // 写进偏好表等于凭空造了个不存在的键,表现为「改名保存了但界面毫无变化」)。
  const target = renameDeviceTarget.value;
  const peerId = target.isLocalPeer && target.peerId
    ? target.peerId
    : (isSendspin
        ? `sendspin:${target.id}`
        : `${isAirPlay ? "airplay" : "dlna"}:${target.id}`);
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

// 禁用/启用设备:禁用后设备从所有流转播放的地方消失(切换器/HA 卡片/投屏),
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

// ---- Sendspin 设备管理(在线客户端;拨入为主,也可手动拨号添加) ----
const sendspinClients = ref<any[]>([]);
const loadingSendspin = ref(false);
const sendspinPort = ref(38927);
const dialTargets = ref<any[]>([]);
const showDialDialog = ref(false);
const dialHost = ref("");
const dialPort = ref(8928);
const dialing = ref(false);

const sendspinUrl = computed(() => `ws://${window.location.hostname}:${sendspinPort.value}/sendspin`);

function shortClientId(id: string) {
  return id && id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-6)}` : (id || "");
}

async function loadSendspinClients(): Promise<void> {
  loadingSendspin.value = true;
  try {
    const res = await api.get("/rest/api/v1/sendspin/clients");
    sendspinClients.value = res.data?.clients || [];
    if (Number.isInteger(res.data?.port)) sendspinPort.value = res.data.port;
  } catch { sendspinClients.value = []; }
  try {
    const res = await api.get("/rest/api/v1/sendspin/dial-targets");
    dialTargets.value = res.data?.targets || [];
  } catch { dialTargets.value = []; }
  finally { loadingSendspin.value = false; }
}

async function redialTarget(tg: any): Promise<void> {
  try {
    const res = await api.post("/rest/api/v1/sendspin/dial", { host: tg.host, port: tg.port });
    if (res.data?.success) {
      ElMessage.success(t("groups.sendspinDialOk", { name: res.data?.name || `${tg.host}:${tg.port}` }));
      await loadSendspinClients();
    } else {
      ElMessage.error(res.data?.error || t("groups.sendspinDialFailed"));
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("groups.sendspinDialFailed"));
  }
}

async function forgetTarget(tg: any): Promise<void> {
  try {
    await api.delete("/rest/api/v1/sendspin/dial-targets", { data: { host: tg.host, port: tg.port } });
    ElMessage.success(t("settings.saved"));
    await loadSendspinClients();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("common.operationFailed"));
  }
}

async function dialPlayer(): Promise<void> {
  const host = dialHost.value.trim();
  if (!host || dialing.value) return;
  dialing.value = true;
  try {
    const res = await api.post("/rest/api/v1/sendspin/dial", { host, port: dialPort.value });
    if (res.data?.success) {
      ElMessage.success(t("groups.sendspinDialOk", { name: res.data?.name || res.data?.clientId || host }));
      showDialDialog.value = false;
      dialHost.value = "";
      await loadSendspinClients();
    } else {
      ElMessage.error(res.data?.error || t("groups.sendspinDialFailed"));
    }
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("groups.sendspinDialFailed"));
  } finally {
    dialing.value = false;
  }
}

function openRenameSendspinDevice(dev: any) {
  renameDeviceTarget.value = { ...dev, id: dev.clientId, isSendspin: true };
  renameDeviceName.value = playerStore.getPeerName(`sendspin:${dev.clientId}`) || dev.name || "";
  showRenameDeviceDialog.value = true;
}

async function approveSendspin(dev: any, approved: boolean): Promise<void> {
  try {
    await api.post("/rest/api/v1/sendspin/approve", { clientId: dev.clientId, approved });
    ElMessage.success(t("settings.saved"));
    await loadSendspinClients();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("common.operationFailed"));
  }
}

async function unpairSendspin(dev: any): Promise<void> {
  try {
    await api.post("/rest/api/v1/sendspin/unpair", { clientId: dev.clientId });
    ElMessage.success(t("settings.saved"));
    await loadSendspinClients();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("common.operationFailed"));
  }
}

const showPairDialog = ref(false);
const pairTarget = ref("");

function openPairDialog(dev: any): void {
  pairTarget.value = dev.clientId;
  showPairDialog.value = true;
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

onMounted(() => {
  loadGroups(); loadDlnaDevices(); loadAirPlayDevices(); loadSendspinClients();
  // 隐藏/改名的偏好是本机实例(「客户端」模块)开关回位与名字回显的依据,先加载。
  playerStore.loadHiddenPrefs(); playerStore.loadNamePrefs();
  // 本机实例列表:与 DLNA 设备一样走页面本地加载(includeHidden=1,隐藏行不剪),
  // 行因此恒在、开关可反复切换。
  loadLocalPlayers();
});
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
.remembered-box { margin-top: 10px; }
.remembered-title { font-size: 12px; font-weight: 600; color: var(--fnos-text-secondary); margin: 2px 2px 6px; }
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