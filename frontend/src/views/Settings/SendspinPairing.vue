<!-- Sendspin 设备与配对管理(仅管理员):在线客户端一览、配对码/Token 配对、批准与解绑。 -->
<template>
  <el-card class="mt-card">
    <h3>{{ t('settings.sendspin.title') }}</h3>
    <div class="setting-item">
      <div class="setting-label">
        <div class="title">{{ t('settings.sendspin.desc') }}</div>
        <div class="desc">{{ t('settings.sendspin.descDetail') }}</div>
      </div>
      <div class="setting-value"><el-button size="small" :loading="loading" @click="load">{{ t('settings.sendspin.refresh') }}</el-button></div>
    </div>
    <div v-if="!enabled" class="sp-hint">{{ t('settings.sendspin.disabled') }}</div>
    <el-table v-else :data="clients" size="small" style="width: 100%" :empty-text="t('settings.sendspin.empty')">
      <el-table-column prop="name" :label="t('settings.sendspin.colName')" min-width="140">
        <template #default="{ row }">
          <div>{{ row.name }}</div>
          <div class="sp-id">{{ shortId(row.clientId) }}</div>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.sendspin.colStatus')" width="170">
        <template #default="{ row }">
          <el-tag v-if="row.paired" size="small" type="success">{{ t('settings.sendspin.paired') }}</el-tag>
          <el-tag v-else-if="row.legacy" size="small" type="warning">{{ t('settings.sendspin.legacy') }}</el-tag>
          <el-tag v-else size="small" type="info">{{ t('settings.sendspin.unpaired') }}</el-tag>
          <el-tag v-if="!row.paired && !row.legacy && row.approved" size="small" type="info" class="ml-1">{{ t('settings.sendspin.approved') }}</el-tag>
          <div v-if="attemptFor(row.clientId)?.pendingMessage" class="sp-pending">{{ attemptFor(row.clientId)?.pendingMessage }}</div>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.sendspin.colAction')" min-width="220">
        <template #default="{ row }">
          <template v-if="!pairing[row.clientId]">
            <el-button v-if="!row.paired && !row.legacy" size="small" @click="beginPair(row, 'static_pairing_code')">{{ t('settings.sendspin.pair') }}</el-button>
            <el-button v-if="!row.paired && !row.legacy" size="small" @click="beginToken(row)">{{ t('settings.sendspin.pairToken') }}</el-button>
            <el-button v-if="!row.paired && !row.legacy" size="small" @click="toggleApprove(row)">{{ row.approved ? t('settings.sendspin.unapprove') : t('settings.sendspin.approve') }}</el-button>
            <el-button v-if="row.paired" size="small" type="danger" @click="unpair(row)">{{ t('settings.sendspin.unpair') }}</el-button>
          </template>
          <template v-else>
            <div class="sp-pair-form">
              <template v-if="pairing[row.clientId].mode === 'code'">
                <el-select v-model="pairing[row.clientId].method" size="small" style="width: 130px">
                  <el-option :label="t('settings.sendspin.staticCode')" value="static_pairing_code" />
                  <el-option :label="t('settings.sendspin.dynamicCode')" value="dynamic_pairing_code" />
                </el-select>
                <el-input v-model="pairing[row.clientId].code" size="small" style="width: 130px" :placeholder="t('settings.sendspin.codePh')" @keyup.enter="submitCode(row)" />
                <el-button size="small" type="primary" :loading="pairing[row.clientId].busy" @click="submitCode(row)">{{ t('common.confirm') }}</el-button>
                <el-button size="small" @click="cancelPair(row)">{{ t('common.cancel') }}</el-button>
              </template>
              <template v-else>
                <el-input v-model="pairing[row.clientId].token" size="small" style="width: 230px" :placeholder="t('settings.sendspin.tokenPh')" />
                <el-button size="small" type="primary" :loading="pairing[row.clientId].busy" @click="submitToken(row)">{{ t('common.confirm') }}</el-button>
                <el-button size="small" @click="cancelPair(row)">{{ t('common.cancel') }}</el-button>
              </template>
            </div>
          </template>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import api from "@/api";

const { t } = useI18n();

interface SpClient {
  clientId: string;
  name: string;
  roles: string[];
  legacy: boolean;
  paired: boolean;
  approved: boolean;
}
interface PairAttempt {
  clientId: string;
  state: string;
  pendingMessage?: string;
}

const clients = ref<SpClient[]>([]);
const attempts = ref<PairAttempt[]>([]);
const enabled = ref(true);
const loading = ref(false);
const pairing = ref<Record<string, { mode: "code" | "token"; method: string; code: string; token: string; busy: boolean; started: boolean }>>({});
let pollTimer: ReturnType<typeof setInterval> | null = null;

function shortId(id: string) {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}
function attemptFor(clientId: string) {
  return attempts.value.find((a) => a.clientId === clientId);
}

async function load() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/sendspin/clients");
    clients.value = res.data?.clients || [];
    enabled.value = res.data?.enabled !== false;
    const a = await api.get("/rest/api/v1/sendspin/pairing/attempts").catch(() => null);
    if (a) attempts.value = a.data?.attempts || [];
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.saveFailed"));
  } finally {
    loading.value = false;
  }
}

function beginPair(row: any, method: string) {
  pairing.value[row.clientId] = { mode: "code", method, code: "", token: "", busy: false, started: false };
}
function beginToken(row: any) {
  pairing.value[row.clientId] = { mode: "token", method: "pairing_psk", code: "", token: "", busy: false, started: false };
}

async function submitCode(row: any) {
  const f = pairing.value[row.clientId];
  if (!f || !f.code.trim()) return;
  f.busy = true;
  try {
    if (!f.started) {
      await api.post("/rest/api/v1/sendspin/pairing/start", { clientId: row.clientId, method: f.method });
      f.started = true;
    }
    await api.post("/rest/api/v1/sendspin/pairing/code", { clientId: row.clientId, code: f.code.trim() });
    ElMessage.success(t("settings.sendspin.codeSent"));
    await load();
    // 配对完成(记录落盘)后收起表单;否则保持以便重试/取消。
    setTimeout(async () => {
      await load();
      const c = clients.value.find((x) => x.clientId === row.clientId);
      if (c?.paired) delete pairing.value[row.clientId];
      else f.busy = false;
    }, 4000);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.saveFailed"));
    f.busy = false;
  }
}

async function submitToken(row: any) {
  const f = pairing.value[row.clientId];
  if (!f || !f.token.trim()) return;
  f.busy = true;
  try {
    await api.post("/rest/api/v1/sendspin/pairing/token", { clientId: row.clientId, token: f.token.trim() });
    ElMessage.success(t("settings.sendspin.codeSent"));
    delete pairing.value[row.clientId];
    setTimeout(load, 4000);
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.saveFailed"));
    f.busy = false;
  }
}

async function cancelPair(row: any) {
  try {
    await api.post("/rest/api/v1/sendspin/pairing/cancel", { clientId: row.clientId });
  } catch { /* 无进行中配对也视为成功 */ }
  delete pairing.value[row.clientId];
  await load();
}

async function toggleApprove(row: any) {
  try {
    await api.post("/rest/api/v1/sendspin/approve", { clientId: row.clientId, approved: !row.approved });
    ElMessage.success(t("settings.saved"));
    await load();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.saveFailed"));
  }
}

async function unpair(row: any) {
  try {
    await api.post("/rest/api/v1/sendspin/unpair", { clientId: row.clientId });
    ElMessage.success(t("settings.saved"));
    await load();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || t("settings.saveFailed"));
  }
}

onMounted(() => {
  load();
  pollTimer = setInterval(async () => {
    try {
      const a = await api.get("/rest/api/v1/sendspin/pairing/attempts");
      attempts.value = a.data?.attempts || [];
      if (attempts.value.length) {
        const res = await api.get("/rest/api/v1/sendspin/clients");
        clients.value = res.data?.clients || [];
      }
    } catch { /* 静默 */ }
  }, 5000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style lang="scss" scoped>
.sp-hint { font-size: 12px; color: var(--fnos-text-tertiary); padding: 8px 0; }
.sp-id { font-size: 11px; color: var(--fnos-text-tertiary); font-family: monospace; }
.sp-pending { font-size: 11px; color: var(--el-color-warning); margin-top: 4px; }
.sp-pair-form { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ml-1 { margin-left: 4px; }
</style>
