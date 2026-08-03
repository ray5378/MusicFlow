<template>
  <div class="admin-users">
    <div class="page-header">
      <h2>用户管理</h2>
      <el-button type="primary" @click="showAddDialog = true">新增用户</el-button>
    </div>
    <div class="user-grid">
      <el-card v-for="user in users" :key="user.id" class="user-card">
        <div class="user-header">
          <div class="user-info">
            <h3>{{ user.username }}</h3>
            <div class="tags">
              <el-tag :type="user.isAdmin ? 'danger' : ''" size="small">{{ user.isAdmin ? '管理员' : '普通用户' }}</el-tag>
              <el-tag :type="user.isActive ? 'success' : 'info'" size="small">{{ user.isActive ? '启用' : '失效' }}</el-tag>
              <el-tag v-if="user.apiKeySet" type="warning" size="small">API Key</el-tag>
            </div>
          </div>
        </div>
        <div class="user-actions">
          <el-button size="small" @click="showPasswordDialog(user)">修改密码</el-button>
        </div>
      </el-card>
    </div>

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
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage } from "element-plus";
import api from "@/api";

const users = ref<any[]>([]);
const showAddDialog = ref(false);
const showPwdDialog = ref(false);
const newUser = reactive({ username: "", password: "" });
const pwdForm = reactive({ userId: "", newPassword: "" });

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

onMounted(loadUsers);
</script>

<style lang="scss" scoped>
.admin-users { padding: 24px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; h2 { font-size: 24px; font-weight: 600; } }
.user-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.user-card { .user-header { display: flex; justify-content: space-between;
  .user-info { h3 { margin: 0 0 8px; } .tags { display: flex; gap: 4px; } } }
.user-actions { margin-top: 12px; display: flex; gap: 8px; } }
</style>
