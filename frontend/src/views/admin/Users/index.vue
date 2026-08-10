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

    <el-dialog v-model="showAddDialog" title="新增用户" width="400px">
      <el-form label-width="80px">
        <el-form-item label="用户名"><el-input v-model="newUser.username" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="newUser.password" type="password" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="addUser">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showPwdDialog" title="修改密码" width="400px">
      <el-form label-width="80px">
        <el-form-item label="新密码"><el-input v-model="pwdForm.newPassword" type="password" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showPwdDialog = false">取消</el-button>
        <el-button type="primary" @click="changePassword">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showNameDialog" title="修改用户名" width="400px">
      <el-form label-width="80px">
        <el-form-item label="新用户名"><el-input v-model="nameForm.username" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showNameDialog = false">取消</el-button>
        <el-button type="primary" @click="changeUsername">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showKeyDialog" :title="`API Key — ${keyForm.username}`" width="520px">
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
@media (max-width: 768px) {
  .admin-users { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  .user-grid { grid-template-columns: 1fr; }
  .user-actions .el-button { margin-left: 0; }
}
</style>
