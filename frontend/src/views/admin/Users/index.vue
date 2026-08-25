<template>
  <div class="admin-users">
    <div class="page-header">
      <h2>用户管理</h2>
      <el-button type="primary" @click="showAddDialog = true">新增用户</el-button>
    </div>
    <div class="user-grid" v-if="users.length > 0">
      <el-card v-for="user in users" :key="user.id" class="user-card">
        <div class="user-header">
          <div class="user-info">
            <h3>{{ user.username }}</h3>
            <div class="tags">
              <el-tag :type="user.isAdmin ? 'danger' : undefined" size="small">{{ user.isAdmin ? '管理员' : '普通用户' }}</el-tag>
              <el-tag :type="user.isActive ? 'success' : 'info'" size="small">{{ user.isActive ? '启用' : '失效' }}</el-tag>
              <el-tag v-if="user.apiKeySet" type="warning" size="small">API Key</el-tag>
            </div>
          </div>
        </div>
        <div class="user-actions">
          <el-button size="small" type="primary" plain @click="openAccessDialog(user)">权限</el-button>
          <el-button size="small" @click="showUsernameDialog(user)">修改用户名</el-button>
          <el-button size="small" @click="showPasswordDialog(user)">修改密码</el-button>
          <el-button size="small" @click="openKeyDialog(user)">API Key</el-button>
          <el-button size="small" type="danger" plain :disabled="user.id === authStore.userId" @click="deleteUser(user)">删除用户</el-button>
        </div>
      </el-card>
    </div>
    <EmptyState v-else icon="user" title="暂无用户" description="添加用户后即可多人共享音乐库">
      <template #action>
        <el-button type="primary" @click="showAddDialog = true">新增用户</el-button>
      </template>
    </EmptyState>

    <el-dialog v-model="showAddDialog" title="新增用户" width="400px" :append-to-body="true">
      <el-form label-width="80px">
        <el-form-item label="用户名"><el-input v-model="newUser.username" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="newUser.password" type="password" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="addUser">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showPwdDialog" title="修改密码" width="400px" :append-to-body="true">
      <el-form label-width="80px">
        <el-form-item label="新密码"><el-input v-model="pwdForm.newPassword" type="password" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showPwdDialog = false">取消</el-button>
        <el-button type="primary" @click="changePassword">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showNameDialog" title="修改用户名" width="400px" :append-to-body="true">
      <el-form label-width="80px">
        <el-form-item label="新用户名"><el-input v-model="nameForm.username" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showNameDialog = false">取消</el-button>
        <el-button type="primary" @click="changeUsername">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showKeyDialog" :title="`API Key — ${keyForm.username}`" width="520px" :append-to-body="true">
      <div class="key-dialog" v-loading="keyForm.loading">
        <p class="key-desc">
          供 Home Assistant 集成等常驻客户端使用的长期凭据。登录用的 JWT 24 小时过期，第三方客户端要用这里的 Key。
        </p>
        <div v-if="keyForm.apiKey" class="key-box">
          <el-input
            v-model="keyForm.apiKey"
            readonly
            class="key-input"
            :type="keyForm.visible ? 'text' : 'password'"
          >
            <template #append>
              <el-button @click="keyForm.visible = !keyForm.visible">{{ keyForm.visible ? '隐藏' : '显示' }}</el-button>
            </template>
          </el-input>
          <el-button
            class="key-copy"
            type="primary"
            plain
            @click="copyKey"
          >
            复制
          </el-button>
          <div class="key-meta">
            有效期：{{ keyForm.expiresAt ? keyForm.expiresAt.slice(0, 10) + ' 到期' : '永不过期' }}
          </div>
        </div>
        <el-empty v-else description="该用户尚未生成 API Key" :image-size="60" />

        <el-form label-width="80px" class="key-form">
          <el-form-item label="有效期">
            <el-select v-model="keyForm.expiresInDays" style="width: 160px">
              <el-option label="永不过期" :value="0" />
              <el-option label="30 天" :value="30" />
              <el-option label="90 天" :value="90" />
              <el-option label="365 天" :value="365" />
            </el-select>
          </el-form-item>
        </el-form>

        <el-alert type="warning" :closable="false" show-icon>
          修改该用户密码会自动使 Key 失效，请先改密码再生成。
        </el-alert>
      </div>
      <template #footer>
        <el-button @click="showKeyDialog = false">关闭</el-button>
        <el-button v-if="keyForm.apiKey" type="danger" plain :loading="keyForm.loading" @click="revokeKey">撤销</el-button>
        <el-button type="primary" :loading="keyForm.loading" @click="generateKey">
          {{ keyForm.apiKey ? '重新生成' : '生成' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showAccessDialog" :title="`权限设置 — ${accessForm.username}`" width="720px" :append-to-body="true" class="access-dialog">
      <div v-loading="accessForm.loading" class="access-body">
        <el-alert v-if="accessForm.isAdmin" type="info" :closable="false" show-icon>
          管理员不受细粒度权限限制，始终拥有全部功能权限与播放器控制权。
        </el-alert>
        <template v-else>
          <div class="access-section-title">功能权限</div>
          <div v-for="cat in accessCategories" :key="cat" class="access-cat">
            <div class="access-cat-name">{{ cat }}</div>
            <div class="access-perm-grid">
              <div v-for="p in accessForm.catalog.filter(x => x.category === cat)" :key="p.key" class="access-perm-item">
                <el-checkbox v-model="accessForm.permissions[p.key]">
                  <span class="perm-label">{{ p.label }}</span>
                  <el-tag :type="p.defaultGranted ? 'success' : 'info'" size="small" effect="plain" class="perm-default-tag">
                    {{ p.defaultGranted ? '默认开启' : '默认关闭' }}
                  </el-tag>
                </el-checkbox>
                <div class="perm-desc">{{ p.desc }}</div>
              </div>
            </div>
          </div>
          <el-divider />
          <div class="access-section-title">播放器授权</div>
          <el-alert v-if="!accessForm.permissions['renderer.use']" type="warning" :closable="false" show-icon class="renderer-hint">
            尚未勾选「使用播放器」功能权限，下方的设备授权不会生效。请先在上方勾选。
          </el-alert>
          <div v-if="accessForm.renderers.length === 0" class="no-renderers">
            当前没有可授权的 DLNA / AirPlay 设备或播放器群组（扫描到设备后会出现在这里）。
          </div>
          <div v-else class="access-renderer-grid">
            <el-checkbox
              v-for="r in accessForm.renderers"
              :key="r.deviceKey"
              :model-value="rendererChecked(r.deviceKey)"
              :disabled="!!r.disabled"
              @change="(v: any) => toggleRenderer(r.deviceKey, !!v)"
            >
              <el-tag :type="r.kind === 'group' ? 'warning' : (r.kind === 'airplay' ? 'success' : 'primary')" size="small" effect="plain" class="renderer-kind-tag">
                {{ r.kind === 'group' ? '群组' : r.kind.toUpperCase() }}
              </el-tag>
              <span class="renderer-name">{{ r.name }}</span>
              <span v-if="r.kind === 'group' && r.memberCount" class="renderer-meta">（{{ r.memberCount }} 台）</span>
            </el-checkbox>
          </div>
        </template>
      </div>
      <template #footer>
        <el-button @click="showAccessDialog = false">取消</el-button>
        <el-button type="primary" :loading="accessForm.saving" :disabled="accessForm.isAdmin" @click="saveAccess">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import api from "@/api";
import { useAuthStore } from "@/stores/auth";
import { copyText } from "@/utils/clipboard";

const authStore = useAuthStore();
const users = ref<any[]>([]);
const showAddDialog = ref(false);
const showPwdDialog = ref(false);
const showNameDialog = ref(false);
const newUser = reactive({ username: "", password: "" });
const pwdForm = reactive({ userId: "", newPassword: "" });
const nameForm = reactive({ userId: "", username: "" });

const showKeyDialog = ref(false);
const keyForm = reactive({
  userId: "",
  username: "",
  apiKey: "",
  expiresAt: null as string | null,
  expiresInDays: 0,
  visible: false,
  loading: false,
});

// 细粒度权限(功能权限 + 播放器授权)
const showAccessDialog = ref(false);
const accessCategories = ["曲库", "歌单", "互动", "推荐", "播放器", "系统"];
const accessForm = reactive<{
  userId: string;
  username: string;
  isAdmin: boolean;
  loading: boolean;
  saving: boolean;
  catalog: { key: string; label: string; category: string; desc: string; defaultGranted: boolean }[];
  permissions: Record<string, boolean>;
  rendererGrants: string[];
  renderers: { kind: string; deviceKey: string; name: string; disabled?: boolean; memberCount?: number }[];
}>({
  userId: "",
  username: "",
  isAdmin: false,
  loading: false,
  saving: false,
  catalog: [],
  permissions: {},
  rendererGrants: [],
  renderers: [],
});

async function openAccessDialog(user: any) {
  accessForm.userId = user.id;
  accessForm.username = user.username;
  accessForm.isAdmin = !!user.isAdmin;
  accessForm.permissions = {};
  accessForm.rendererGrants = [];
  accessForm.renderers = [];
  showAccessDialog.value = true;
  accessForm.loading = true;
  try {
    const [accessRes, rendererRes] = await Promise.all([
      api.get(`/rest/api/v1/users/${user.id}/access`),
      api.get("/rest/api/v1/access/renderers"),
    ]);
    accessForm.catalog = accessRes.data.catalog || [];
    accessForm.permissions = { ...(accessRes.data.permissions || {}) };
    accessForm.rendererGrants = accessRes.data.rendererGrants || [];
    accessForm.renderers = rendererRes.data.renderers || [];
  } catch {
    ElMessage.error("读取权限配置失败");
  } finally {
    accessForm.loading = false;
  }
}

function rendererChecked(deviceKey: string): boolean {
  return accessForm.rendererGrants.includes(deviceKey);
}

function toggleRenderer(deviceKey: string, on: boolean) {
  const idx = accessForm.rendererGrants.indexOf(deviceKey);
  if (on && idx === -1) accessForm.rendererGrants.push(deviceKey);
  if (!on && idx >= 0) accessForm.rendererGrants.splice(idx, 1);
}

async function saveAccess() {
  accessForm.saving = true;
  try {
    await api.put(`/rest/api/v1/users/${accessForm.userId}/access`, {
      permissions: accessForm.permissions,
      renderers: accessForm.rendererGrants,
    });
    ElMessage.success("权限已保存");
    showAccessDialog.value = false;
  } catch {
    ElMessage.error("保存失败");
  } finally {
    accessForm.saving = false;
  }
}

async function loadUsers() { try { users.value = (await api.get("/rest/api/v1/users")).data; } catch { users.value = []; } }

async function addUser() {
  if (!newUser.username || !newUser.password) { ElMessage.warning("请填写完整信息"); return; }
  await api.post("/rest/api/v1/users", newUser);
  showAddDialog.value = false;
  newUser.username = "";
  newUser.password = "";
  ElMessage.success("创建成功");
  loadUsers();
}

function showPasswordDialog(user: any) { pwdForm.userId = user.id; pwdForm.newPassword = ""; showPwdDialog.value = true; }
async function changePassword() {
  if (!pwdForm.newPassword) { ElMessage.warning("请输入新密码"); return; }
  await api.put(`/rest/api/v1/users/${pwdForm.userId}/password`, { newPassword: pwdForm.newPassword });
  showPwdDialog.value = false;
  ElMessage.success("密码已修改");
}

function showUsernameDialog(user: any) { nameForm.userId = user.id; nameForm.username = user.username; showNameDialog.value = true; }
async function changeUsername() {
  if (!nameForm.username?.trim()) { ElMessage.warning("请输入新用户名"); return; }
  const res = await api.put(`/rest/api/v1/users/${nameForm.userId}/username`, { username: nameForm.username.trim() });
  showNameDialog.value = false;
  if (nameForm.userId === authStore.userId) authStore.setUsername(res.data.username);
  ElMessage.success("用户名已修改");
  loadUsers();
}

async function openKeyDialog(user: any) {
  keyForm.userId = user.id;
  keyForm.username = user.username;
  keyForm.apiKey = "";
  keyForm.expiresAt = null;
  keyForm.expiresInDays = 0;
  keyForm.visible = false;
  showKeyDialog.value = true;
  keyForm.loading = true;
  try {
    const res = await api.get(`/rest/api/v1/users/${user.id}/api-key`);
    keyForm.apiKey = res.data.apiKey || "";
    keyForm.expiresAt = res.data.expiresAt || null;
  } catch {
    ElMessage.error("读取 API Key 失败");
  } finally {
    keyForm.loading = false;
  }
}

async function generateKey() {
  if (keyForm.apiKey) {
    try {
      await ElMessageBox.confirm(
        `重新生成会立即让「${keyForm.username}」现有的 Key 失效，正在使用它的客户端（如 Home Assistant）需要重新填写。`,
        "重新生成 API Key",
        { type: "warning" },
      );
    } catch { return; }
  }
  keyForm.loading = true;
  try {
    const res = await api.post(`/rest/api/v1/users/${keyForm.userId}/api-key`, {
      expiresInDays: keyForm.expiresInDays,
    });
    keyForm.apiKey = res.data.apiKey;
    keyForm.expiresAt = res.data.expiresAt || null;
    keyForm.visible = true;
    ElMessage.success("已生成，请复制保存");
    loadUsers();
  } catch {
    ElMessage.error("生成失败");
  } finally {
    keyForm.loading = false;
  }
}

async function revokeKey() {
  try {
    await ElMessageBox.confirm(
      `撤销后「${keyForm.username}」使用该 Key 的客户端会立即无法访问。`,
      "撤销 API Key",
      { type: "warning" },
    );
  } catch { return; }
  keyForm.loading = true;
  try {
    await api.delete(`/rest/api/v1/users/${keyForm.userId}/api-key`);
    keyForm.apiKey = "";
    keyForm.expiresAt = null;
    keyForm.visible = false;
    ElMessage.success("已撤销");
    loadUsers();
  } catch {
    ElMessage.error("撤销失败");
  } finally {
    keyForm.loading = false;
  }
}

async function copyKey() {
  await copyText(keyForm.apiKey);
}

async function deleteUser(user: any) {
  try {
    await ElMessageBox.confirm(`确定删除用户「${user.username}」？该用户的歌单、收藏、播放历史将一并删除。`, "删除用户", { type: "warning" });
  } catch { return; }
  await api.delete(`/rest/api/v1/users/${user.id}`);
  ElMessage.success("已删除");
  loadUsers();
}

onMounted(loadUsers);
</script>

<style lang="scss" scoped>
.admin-users { padding: 24px 32px 130px; max-width: 1200px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.user-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.user-card {
  background: rgba(255,255,255,0.04) !important;
  border: 1px solid rgba(255,255,255,0.07) !important;
  border-radius: var(--fnos-radius-lg) !important;
  color: var(--fnos-text-primary-dim);
  .user-header { display: flex; justify-content: space-between;
    .user-info { h3 { margin: 0 0 10px; color: var(--fnos-text-primary); font-size: 16px; } .tags { display: flex; gap: 6px; flex-wrap: wrap; } }
  }
  .user-actions { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
}
.key-dialog {
  .key-desc { margin: 0 0 14px; font-size: 13px; line-height: 1.6; color: var(--fnos-text-secondary); }
  .key-box { margin-bottom: 8px; display: flex; gap: 8px; align-items: stretch; flex-wrap: wrap; }
  .key-box .key-input { flex: 1 1 auto; min-width: 0; }
  .key-box .key-copy { flex: 0 0 auto; }
  .key-meta { flex-basis: 100%; margin-top: 8px; font-size: 12px; color: var(--fnos-text-tertiary); }
  .key-form { margin-top: 12px; :deep(.el-form-item) { margin-bottom: 12px; } }
}
.access-dialog {
  .access-body { min-height: 120px; max-height: 60vh; overflow-y: auto; padding-right: 4px; }
  .access-section-title { font-size: 15px; font-weight: 600; color: var(--fnos-text-primary); margin: 4px 0 12px; }
  .access-cat { margin-bottom: 16px;
    .access-cat-name { font-size: 13px; font-weight: 600; color: var(--fnos-text-secondary); margin-bottom: 8px; }
  }
  .access-perm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px 16px; }
  .access-perm-item {
    padding: 8px 10px; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; background: rgba(255,255,255,0.03);
    .el-checkbox { height: auto; margin-right: 0; white-space: normal; }
    .perm-label { font-size: 13px; }
    .perm-default-tag { margin-left: 6px; transform: scale(0.85); transform-origin: left center; }
    .perm-desc { font-size: 12px; color: var(--fnos-text-tertiary); line-height: 1.5; margin-top: 4px; padding-left: 24px; }
  }
  .renderer-hint { margin-bottom: 12px; }
  .no-renderers { padding: 16px; text-align: center; color: var(--fnos-text-tertiary); font-size: 13px; border: 1px dashed rgba(255,255,255,0.12); border-radius: 8px; }
  .access-renderer-grid { display: flex; flex-direction: column; gap: 8px; }
  .access-renderer-grid .el-checkbox { height: auto; margin-right: 0; white-space: normal; }
  .renderer-kind-tag { margin-right: 8px; transform: scale(0.9); transform-origin: left center; }
  .renderer-name { font-size: 13px; }
  .renderer-meta { font-size: 12px; color: var(--fnos-text-tertiary); }
}
@media (max-width: 768px) {
  .admin-users { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .user-grid { grid-template-columns: 1fr; }
  .user-actions .el-button { margin-left: 0; }
}
</style>
