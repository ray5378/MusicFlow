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

    <!-- Sendspin 设备管理:行结构与 DLNA **完全同构**(在线高亮/离线变暗 + 禁用/重命名)。
         列表 = 在线客户端 ＋ 已记住但当前离线的拨号目标(合并为一列,不再单列「已记住的播放器」)。
         删除语义 = `解绑`(常显):解绑后本行保留、标签回落「未配对」、按钮回落「配对」。 -->
    <div class="devices-section" style="margin-top: 28px">
      <div class="section-head">
        <h3>{{ t('groups.sendspinDevices') }}</h3>
        <el-button size="small" :loading="loadingSendspin" @click="loadSendspinClients"><MfIcon name="RefreshCw" />{{ t('groups.refresh') }}</el-button>
        <el-button v-if="canManage" size="small" type="primary" @click="showDialDialog = true"><MfIcon name="Plus" />{{ t('groups.sendspinAdd') }}</el-button>
      </div>
      <div class="section-note">{{ t('groups.sendspinNote', { url: sendspinUrl }) }}</div>
      <div class="devices-box" v-loading="loadingSendspin">
        <div
          v-for="dev in sendspinRows"
          :key="dev.rowKey"
          class="device-row"
          :class="{ 'is-disabled': dev.disabled }"
        >
          <MfIcon name="Speaker" class="device-row-icon" :class="{ offline: !dev.available }" />
          <div class="device-row-info">
            <div class="device-row-name">
              <!-- 在线,或「已禁用且离线但已知 clientId」:两者都有 clientId,显示设备名。 -->
              <template v-if="dev.clientId">
                {{ deviceDisplayName({ clientId: dev.clientId, name: dev.name }, `sendspin:${dev.clientId}`) }}
                <el-tag v-if="isDeviceRenamed({ clientId: dev.clientId }, `sendspin:${dev.clientId}`)" size="small" type="warning" style="margin-left: 6px">{{ t('groups.renamed') }}</el-tag>
                <template v-if="dev.online">
                  <el-tag v-if="dev.paired" size="small" type="success" style="margin-left: 6px">{{ t('groups.sendspinPaired') }}</el-tag>
                  <el-tag v-else-if="dev.legacy" size="small" type="warning" style="margin-left: 6px">{{ t('groups.sendspinLegacy') }}</el-tag>
                  <el-tag v-else size="small" type="info" style="margin-left: 6px">{{ t('groups.sendspinUnpaired') }}</el-tag>
                  <el-tag v-if="!dev.paired && !dev.legacy && dev.approved" size="small" style="margin-left: 6px">{{ t('groups.sendspinApproved') }}</el-tag>
                </template>
                <el-tag v-if="dev.disabled" size="small" type="danger" style="margin-left: 6px">{{ t('common.disabled') }}</el-tag>
                <span v-if="!dev.online" class="device-offline-tag">{{ t('groups.offline') }}</span>
              </template>
              <!-- 纯拨号目标(未连上,无 clientId):只能显示 host:port。 -->
              <template v-else>
                {{ dev.host }}:{{ dev.port }}
                <span class="device-offline-tag">{{ t('groups.offline') }}</span>
              </template>
            </div>
            <div class="device-row-meta">
              <template v-if="dev.online">{{ shortClientId(dev.clientId) }} · {{ (dev.roles || []).join(", ") }}</template>
              <template v-else-if="dev.host">{{ dev.host }}:{{ dev.port }}</template>
              <template v-else>{{ shortClientId(dev.clientId) }}</template>
            </div>
          </div>
          <div class="device-row-actions">
            <div class="device-hide-toggle" :title="t('groups.hideToggleTitle')">
              <el-switch
                :model-value="isHidden(`sendspin:${dev.clientId}`)"
                @change="(v: any) => setPeerHidden(`sendspin:${dev.clientId}`, !!v)"
                inline-prompt :active-text="t('groups.hide')" :inactive-text="t('groups.show')" size="small"
              />
            </div>
            <!-- 在线:禁用/恢复 → 配对/解绑 → 重命名(与 DLNA 同序)。 -->
            <template v-if="dev.online">
              <el-popconfirm
                v-if="canManage"
                :title="dev.disabled
                  ? t('groups.enableConfirm', { name: deviceDisplayName({ clientId: dev.clientId, name: dev.name }, `sendspin:${dev.clientId}`) })
                  : t('groups.disableConfirm', { name: deviceDisplayName({ clientId: dev.clientId, name: dev.name }, `sendspin:${dev.clientId}`) })"
                :confirm-button-text="dev.disabled ? t('groups.enable') : t('groups.disable')"
                :confirm-button-type="dev.disabled ? 'primary' : 'danger'"
                :cancel-button-text="t('common.cancel')"
                width="320"
                @confirm="toggleSendspinDisabled(dev, !dev.disabled)"
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
              <el-button
                v-if="canUse && !dev.disabled && !dev.paired && !dev.legacy"
                size="small"
                @click="openPairDialog(dev)"
              ><MfIcon name="KeyRound" />{{ t('groups.sendspinPair') }}</el-button>
              <el-button
                v-if="canManage && !dev.disabled && !dev.paired && !dev.legacy"
                size="small"
                @click="approveSendspin(dev, !dev.approved)"
              >{{ dev.approved ? t('groups.sendspinUnapprove') : t('groups.sendspinApprove') }}</el-button>
              <!-- 解绑(统一名称,= 删除):明文直连 legacy 没有配对记录可解,它解的是
                   「被服务端记住的拨号目标」—— 撤销添加 + 清改名,连接保持、行仍在线。
                   两种解绑共用同一个按钮与入口,不再另设「遗忘」。 -->
              <el-popconfirm
                v-if="canManage && !dev.disabled && sendspinBindable(dev)"
                :title="dev.paired && dev.clientId
                  ? t('groups.sendspinUnpairConfirm', { name: deviceDisplayName({ clientId: dev.clientId, name: dev.name }, `sendspin:${dev.clientId}`) })
                  : t('groups.sendspinUnbindTargetConfirm', { name: `${dev.host}:${dev.port}` })"
                :confirm-button-text="t('common.confirm')"
                :cancel-button-text="t('common.cancel')"
                width="300"
                @confirm="unbindSendspin(dev)"
              >
                <template #reference>
                  <el-button size="small" type="danger" plain><MfIcon name="Link2Off" />{{ t('groups.sendspinUnpair') }}</el-button>
                </template>
              </el-popconfirm>
              <el-button v-if="canUse" size="small" @click="openRenameSendspinDevice(dev)"><MfIcon name="Pencil" />{{ t('groups.rename') }}</el-button>
            </template>
            <!-- 离线:① 已禁用且离线(有 clientId)→ 恢复;② 记住的拨号目标 → 重连 / 遗忘。 -->
            <template v-else>
              <el-popconfirm
                v-if="canManage && dev.clientId && dev.disabled"
                :title="t('groups.enableConfirm', { name: deviceDisplayName({ clientId: dev.clientId, name: dev.name }, `sendspin:${dev.clientId}`) })"
                :confirm-button-text="t('groups.enable')"
                confirm-button-type="primary"
                :cancel-button-text="t('common.cancel')"
                width="320"
                @confirm="toggleSendspinDisabled(dev, false)"
              >
                <template #reference>
                  <el-button size="small" type="danger" class="device-disable-btn">
                    <MfIcon name="CircleSlash" />{{ t('groups.enable') }}
                  </el-button>
                </template>
              </el-popconfirm>
              <!-- 记住的拨号目标(离线):先「连接」,再可「解绑」。 -->
              <el-button v-if="dev.host" size="small" @click="redialTarget(dev)"><MfIcon name="RefreshCw" />{{ t('groups.sendspinReconnect') }}</el-button>
              <!-- 与在线行同一个「解绑」按钮:有配对记录就清配对,只是被记住就撤销添加。 -->
              <el-popconfirm
                v-if="canManage && sendspinBindable(dev)"
                :title="dev.paired && dev.clientId
                  ? t('groups.sendspinUnpairConfirm', { name: deviceDisplayName({ clientId: dev.clientId, name: dev.name }, `sendspin:${dev.clientId}`) })
                  : t('groups.sendspinUnbindTargetConfirm', { name: `${dev.host}:${dev.port}` })"
                :confirm-button-text="t('common.confirm')"
                :cancel-button-text="t('common.cancel')"
                width="300"
                @confirm="unbindSendspin(dev)"
              >
                <template #reference>
                  <el-button size="small" type="danger" plain><MfIcon name="Link2Off" />{{ t('groups.sendspinUnpair') }}</el-button>
                </template>
              </el-popconfirm>
            </template>
          </div>
        </div>
        <div v-if="!loadingSendspin && sendspinRows.length === 0" class="device-empty">
          {{ t('groups.noSendspinDevices') }}
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
            <template v-for="m in g.members" :key="m.deviceId">
              <span
                class="member-chip"
                :class="{ offline: !m.available }"
                @click="copyPeer(memberPeerId(m), m.name)"
                :title="t('groups.copyDeviceId', { id: m.deviceId })"
              >
                {{ m.name }}
                <MfIcon name="CopyDocument" class="member-copy-icon"  />
                <span v-if="!m.available" class="member-offline">{{ t('groups.offline') }}</span>
              </span>
              <!-- sendspin 成员:迷你音量条 + 静音键。离线成员显示持久库值(灰态),
                   但**仍可调节** —— 调完即落库,设备重连后按此生效。 -->
              <span
                v-if="isSendspinMember(m)"
                class="member-volume"
                :class="{ offline: !m.available }"
                :title="t('groups.memberVolumeTitle')"
              >
                <MfIcon
                  :name="memberMuted(m) ? 'VolumeX' : 'Volume2'"
                  :size="15"
                  class="member-vol-icon"
                  :class="{ muted: memberMuted(m) }"
                  @click="toggleMemberMute(m)"
                />
                <el-slider
                  class="member-vol-slider"
                  :model-value="displayMemberVolume(m)"
                  :min="0"
                  :max="100"
                  :show-tooltip="false"
                  size="small"
                  @input="(v: number | number[]) => onMemberVolumeInput(m, v)"
                />
                <span class="member-vol-num">{{ displayMemberVolume(m) }}</span>
              </span>
            </template>
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
                {{ dev.kind === "sendspin" ? deviceDisplayName(dev, dev.id) : dev.name }}
                <span v-if="!dev.available" class="device-offline-tag">{{ t('groups.offline') }}</span>
              </div>
              <div class="device-meta">
                <template v-if="dev.kind === 'sendspin'">Sendspin</template>
                <template v-else>
                  {{ dev.manufacturer || dev.model || t('groups.dlnaDeviceMeta') }}
                </template>
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

// ---- 群组成员音量(sendspin 成员;Groups 页迷你音量条) ----
// 成员 deviceId 是**命名空间化** id:`sendspin:<clientId>` / `dlna:<deviceId>` / 历史裸 id(=DLNA)。
/** 成员的 peerId(sendspin 成员本身已带前缀,其余补 dlna:)。 */
function memberPeerId(m: any): string {
  const id = typeof m?.deviceId === "string" ? m.deviceId : "";
  return id.includes(":") ? id : `dlna:${id}`;
}
function isSendspinMember(m: any): boolean {
  return typeof m?.deviceId === "string" && m.deviceId.startsWith("sendspin:");
}

/** 取 player store 里该 peer 的实时音量/静音(WS peer_volume_changed 已同步)。
 *  离线成员不在 store 的 peers 里(离线即从列表移除)→ 返回空,退回组快照的持久库值
 *  (后端 /v1/groups 对 sendspin 成员已做「实时优先、离线回退库值」)。 */
function storeVolumeOf(m: any): { volume?: number; muted?: boolean } {
  const p = (playerStore.peers as any[]).find((x) => x?.peerId === m?.deviceId);
  return p || {};
}
// 拖拽/静音中的本地草稿:优先于实时值,保证手感跟手、图标即时翻转,不被回声顶回。
const memberVolDraft = ref<Record<string, number>>({});
const memberMutedDraft = ref<Record<string, boolean>>({});
const memberVolTimers = new Map<string, ReturnType<typeof setTimeout>>();

function displayMemberVolume(m: any): number {
  const draft = memberVolDraft.value[m?.deviceId];
  if (typeof draft === "number") return draft;
  const live = storeVolumeOf(m).volume;
  if (typeof live === "number") return live;
  return typeof m?.volume === "number" ? m.volume : 100;
}
function memberMuted(m: any): boolean {
  const draft = memberMutedDraft.value[m?.deviceId];
  if (typeof draft === "boolean") return draft;
  const live = storeVolumeOf(m).muted;
  if (typeof live === "boolean") return live;
  return !!m?.muted;
}

/** 清某成员草稿(延迟:等 WS 回声 / 快照回写落位后再交回,避免滑块回弹)。 */
function clearMemberDraft(map: { value: Record<string, any> }, key: string) {
  setTimeout(() => {
    const next = { ...map.value };
    delete next[key];
    map.value = next;
  }, 600);
}

/** 拖拽:本地即时反馈 + 250ms 防抖下发(与 player store setVolume 同款,避免一帧一 POST)。 */
function onMemberVolumeInput(m: any, v: number | number[]) {
  const val = Math.round(Array.isArray(v) ? v[0] : v);
  memberVolDraft.value = { ...memberVolDraft.value, [m.deviceId]: val };
  const key = String(m.deviceId);
  const timer = memberVolTimers.get(key);
  if (timer) clearTimeout(timer);
  memberVolTimers.set(key, setTimeout(() => {
    memberVolTimers.delete(key);
    void postMemberVolume(m, val);
  }, 250));
}

async function postMemberVolume(m: any, val: number) {
  const clamped = Math.min(100, Math.max(0, Math.round(val)));
  try {
    // sendspin:<id> 直调单设备音量端点(写内存组 + 落库,由 setVolumeCore 收敛)。
    await api.post(`/rest/api/v1/peers/${encodeURIComponent(memberPeerId(m))}/volume`, { volume: clamped });
    m.volume = clamped; // 乐观回写快照:离线成员不在 store,只有快照能立刻反映新值
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("groups.memberVolumeFailed"));
    loadGroups().catch(() => {});
  } finally {
    clearMemberDraft(memberVolDraft, String(m.deviceId));
  }
}

async function toggleMemberMute(m: any) {
  const next = !memberMuted(m);
  memberMutedDraft.value = { ...memberMutedDraft.value, [m.deviceId]: next };
  try {
    await api.post(`/rest/api/v1/peers/${encodeURIComponent(memberPeerId(m))}/mute`, { muted: next });
    m.muted = next;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || t("groups.memberMuteFailed"));
    loadGroups().catch(() => {});
  } finally {
    clearMemberDraft(memberMutedDraft, String(m.deviceId));
  }
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

// 群组编辑对话框可选成员:排除禁用 DLNA 设备(禁用设备不可加入/保留在群组中)。
// sendspin 在线客户端以 `sendspin:<id>` 形式并入(与后端命名空间一致,裸 id 仍视为 DLNA)。
const selectableDevices = computed(() => {
  const dlna = (dlnaDevices.value || []).filter((d: any) => !d.disabled);
  const spin = (sendspinClients.value || []).map((c: any) => ({
    id: `sendspin:${c.clientId}`,
    name: c.name || c.clientId,
    available: true,
    kind: "sendspin",
  }));
  return [...dlna, ...spin];
});

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

/** 合并列表(对齐 DLNA 单列表):在线客户端为主体,追加两类离线行 ——
 *  ① 服务端标记 offline 的设备(已禁用且当前离线,保留在列表里才有入口重新启用);
 *  ② 已记住但当前不在线的拨号目标(仅服务端 /dial 才 remember,与拨入设备不相交)。
 *  在线行可 显示/禁用/配对解绑/重命名;离线行可 重连/遗忘,已禁用的可 恢复。 */
const sendspinRows = computed<any[]>(() => {
  const online = (sendspinClients.value || [])
    .filter((c: any) => !c.offline)
    .map((c: any) => ({
      ...c,
      rowKey: `c:${c.clientId}`,
      online: true,
      available: true,
    }));
  const onlineDialKeys = new Set(
    (sendspinClients.value || [])
      .filter((c: any) => c.dialed && c.host)
      .map((c: any) => `${c.host}:${c.port}`),
  );
  // ① 已禁用且离线(来自 /clients 的 offline 标记)。
  const offlineKnown = (sendspinClients.value || [])
    .filter((c: any) => !!c.offline)
    .map((c: any) => ({
      ...c,
      rowKey: `k:${c.clientId}`,
      online: false,
      available: false,
    }));
  // ② 记住的拨号目标但当前离线(排除已知设备与在线拨号)。
  const knownIds = new Set(offlineKnown.map((k: any) => k.clientId));
  const offlineTargets = (dialTargets.value || [])
    .filter((tg: any) => !tg.online && !onlineDialKeys.has(`${tg.host}:${tg.port}`))
    .map((tg: any) => ({
      ...tg,
      rowKey: `t:${tg.host}:${tg.port}`,
      online: false,
      available: false,
      clientId: "", // 未连上,无 clientId
    }))
    .filter((tg: any) => !knownIds.has(tg.clientId));
  return [...online, ...offlineKnown, ...offlineTargets];
});

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

/** 禁用/启用 Sendspin 设备(对齐 DLNA toggleDisabled):
 *  禁用 = 设备级持久偏好 → 后端断连接 + 停播清队列 + 移出群组 + 从 peer 层移除,
 *  设备从所有流转播放入口消失(切换器 / Flows / HA 卡片)。 */
async function toggleSendspinDisabled(dev: any, disabled: boolean): Promise<void> {
  if (!dev.clientId) return;
  try {
    const res = await api.put(`/rest/api/v1/sendspin/devices/${encodeURIComponent(dev.clientId)}/disabled`, { disabled });
    if (res.data?.success) {
      ElMessage.success(disabled
        ? t("groups.disabledNamed", { name: deviceDisplayName({ clientId: dev.clientId, name: dev.name }, `sendspin:${dev.clientId}`) })
        : t("groups.enabledNamed", { name: deviceDisplayName({ clientId: dev.clientId, name: dev.name }, `sendspin:${dev.clientId}`) }));
      await loadSendspinClients();
      await loadGroups(); // 禁用会把设备移出群组,组列表需要刷新
    }
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

/**
 * 统一的「解绑」入口 —— 三类设备都叫解绑,但各自解的是不同那层:
 *   - 已配对(加密设备)      → 清配对记录(后端会断开,设备重连后回落「未配对」);
 *   - 被服务端记住的拨号目标 → 撤销「添加播放器」:删拨号目标 + 清改名,
 *                             **连接保持**,行仍在线(只是不再自动重拨)。
 *
 * 一次只解一层、且配对优先:已配对且又被记住的设备,第一次点解的是配对(标签回落
 * 「未配对」,行还在),再点一次才是撤销添加。这样不会出现「一点就把设备删没了」,
 * 也符合「解绑后仍保留在这一行」。
 */
async function unbindSendspin(dev: any): Promise<void> {
  const hasPairing = !!dev.paired && !!dev.clientId;
  const hasTarget = !!dev.dialed && !!dev.host;
  if (!hasPairing && !hasTarget) return;
  try {
    if (hasPairing) {
      await api.post("/rest/api/v1/sendspin/unpair", { clientId: dev.clientId });
    } else {
      // 撤销添加:持久音量由后端一并清;改名在这边清(两者都是「添加」留下的痕迹)。
      await api.delete("/rest/api/v1/sendspin/dial-targets", {
        data: { host: dev.host, port: dev.port },
      });
      if (dev.clientId) await playerStore.setPeerName(`sendspin:${dev.clientId}`, "");
    }
    ElMessage.success(t("settings.saved"));
    await loadSendspinClients();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("common.operationFailed"));
  }
}

/** 该行是否还有可解的绑定(配对记录 / 记住的拨号目标)。 */
function sendspinBindable(dev: any): boolean {
  return (!!dev.paired && !!dev.clientId) || (!!dev.dialed && !!dev.host);
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
  if (sendspinClients.value.length === 0) await loadSendspinClients();
  showDialog.value = true;
}

async function openEditMembers(g: any) {
  editingGroup.value = g;
  formName.value = g.name;
  formMembers.value = [...(g.memberIds || [])];
  if (dlnaDevices.value.length === 0) await loadDlnaDevices();
  if (sendspinClients.value.length === 0) await loadSendspinClients();
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
    // sendspin 成员迷你音量条:与 member-chip 同排。只压缩尺寸,颜色交给 global.scss 的
    // el-slider 全局覆写(红条 + 红环白点),避免与那边的 !important 打架。
    .member-volume {
      display: inline-flex; align-items: center; gap: 6px;
      height: 26px; padding: 0 9px 0 7px; align-self: center;
      background: rgba(255,255,255,0.06); border-radius: 13px;
      // EP 滑块几何变量的作用域覆写:20px 把手区 + 4px 轨道 → 居中偏移 (4-20)/2 = -8
      --el-slider-button-size: 9px;
      --el-slider-button-wrapper-size: 20px;
      --el-slider-button-wrapper-offset: -8px;
      .member-vol-icon {
        flex: none; color: var(--fnos-text-secondary); cursor: pointer; transition: color 0.15s;
        &:hover { color: var(--fnos-text-primary); }
        &.muted { color: var(--fnos-red); }
      }
      .member-vol-slider {
        flex: none; width: 84px; height: 20px;
        :deep(.el-slider__runway) { height: 4px; margin: 8px 0; }
      }
      .member-vol-num {
        flex: none; min-width: 22px; text-align: right;
        font-size: 11px; color: var(--fnos-text-tertiary); font-variant-numeric: tabular-nums;
      }
      &.offline { opacity: 0.6; }
    }
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