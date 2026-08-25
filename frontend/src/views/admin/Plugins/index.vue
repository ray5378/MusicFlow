<template>
  <div class="admin-plugins">
    <el-tabs v-model="activeTab" @tab-change="onTabChange">
      <!-- ============ Installed plugins ============ -->
      <el-tab-pane label="已安装" name="installed">
        <div class="page-header">
          <h2>插件管理</h2>
          <el-button type="primary" @click="showAddDialog = true">添加插件</el-button>
        </div>

        <template v-if="plugins.length > 0">
          <el-table v-if="!isMobile" :data="plugins" stripe v-loading="loading">
            <el-table-column label="插件名称" min-width="200">
              <template #default="{ row }">
                <div class="plugin-name">{{ displayName(row) }}</div>
                <div class="plugin-id">{{ row.name }}</div>
              </template>
            </el-table-column>
            <el-table-column label="类型" width="110">
              <template #default="{ row }">
                <el-tag size="small" :type="typeTagColor(row)" effect="light">{{ typeLabel(row) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="version" label="版本" width="90" />
            <el-table-column label="说明" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">{{ parseManifest(row).description || row.description || "—" }}</template>
            </el-table-column>
            <el-table-column label="健康" width="96">
              <template #default="{ row }">
                <el-tag size="small" :type="healthType(row.name)" effect="dark">{{ healthLabel(row.name) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="104">
              <template #default="{ row }">
                <!-- 内置插件也可停用(服务生命周期联动);仅删除受限 -->
                <el-switch v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="210">
              <template #default="{ row }">
                <el-button size="small" type="primary" plain @click="editPlugin(row)">
                  {{ hasConfig(row) ? "配置" : "详情" }}
                </el-button>
                <el-button v-if="!row.builtin" size="small" type="danger" plain @click="confirmDelete(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <!-- 移动端卡片列表:保留配置/详情/删除/启停,避免 el-table 横向滚动 -->
          <div v-else class="plugin-cards">
            <div v-for="row in plugins" :key="row.name" class="plugin-card">
              <div class="pc-row">
                <div class="pc-id">
                  <div class="plugin-name">{{ displayName(row) }}</div>
                  <div class="plugin-id">{{ row.name }}</div>
                </div>
                <el-tag size="small" :type="typeTagColor(row)" effect="light">{{ typeLabel(row) }}</el-tag>
              </div>
              <div class="pc-meta">
                <span class="pc-ver">v{{ row.version }}</span>
                <el-tag size="small" :type="healthType(row.name)" effect="dark">{{ healthLabel(row.name) }}</el-tag>
              </div>
              <div class="pc-desc m-sub">{{ parseManifest(row).description || row.description || "—" }}</div>
              <div class="pc-actions">
                <el-switch v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" />
                <el-button size="small" type="primary" plain @click="editPlugin(row)">
                  {{ hasConfig(row) ? "配置" : "详情" }}
                </el-button>
                <el-button v-if="!row.builtin" size="small" type="danger" plain @click="confirmDelete(row)">删除</el-button>
              </div>
            </div>
          </div>
        </template>
        <EmptyState v-else icon="cable" title="暂无插件" description="插件用于扩展搜索、下载、刮削、歌词、封面、设备投屏等功能">
          <template #action>
            <el-button type="primary" @click="showAddDialog = true">添加插件</el-button>
          </template>
        </EmptyState>
      </el-tab-pane>

      <!-- ============ Plugin marketplace ============ -->
      <el-tab-pane label="插件市场" name="market">
        <div class="page-header">
          <h2>插件市场</h2>
          <el-button type="primary" plain @click="loadMarketplace" :loading="marketLoading">刷新</el-button>
        </div>

        <el-card class="market-card" shadow="never">
          <template #header>
            <div class="card-head">
              <span>注册表来源</span>
              <el-button size="small" type="primary" plain @click="showRegDialog = true">添加注册表</el-button>
            </div>
          </template>
          <template v-if="registries.length > 0">
            <el-table v-if="!isMobile" :data="registries" stripe size="small">
              <el-table-column prop="url" label="URL" min-width="320" show-overflow-tooltip />
              <el-table-column label="状态" width="120">
                <template #default="{ row }">
                  <el-tag v-if="row.error" size="small" type="danger" effect="light">加载失败</el-tag>
                  <el-tag v-else size="small" :type="row.enabled ? 'success' : 'info'" effect="light">{{ row.enabled ? "启用" : "停用" }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button size="small" type="danger" plain @click="removeRegistry(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div v-else class="registry-cards">
              <div v-for="row in registries" :key="row.id" class="registry-card">
                <div class="rc-url">{{ row.url }}</div>
                <div class="rc-meta">
                  <el-tag v-if="row.error" size="small" type="danger" effect="light">加载失败</el-tag>
                  <el-tag v-else size="small" :type="row.enabled ? 'success' : 'info'" effect="light">{{ row.enabled ? "启用" : "停用" }}</el-tag>
                  <el-button size="small" type="danger" plain @click="removeRegistry(row)">删除</el-button>
                </div>
              </div>
            </div>
          </template>
          <el-empty v-else description="尚未添加任何插件注册表" :image-size="60" />
        </el-card>

        <el-card class="market-card" shadow="never">
          <template #header><span>插件市场（按注册表来源分组）</span></template>
          <div v-for="group in groupedMarket" :key="group.key" class="market-group">
            <div class="group-head">
              <span class="group-title">{{ group.title }}</span>
              <el-tag v-if="group.sourceLabel" size="small" type="primary" effect="plain">{{ group.sourceLabel }}</el-tag>
              <el-tag v-if="group.error" size="small" type="danger" effect="plain">加载失败</el-tag>
            </div>
            <el-alert
              v-if="group.error && group.items.length === 0"
              type="warning"
              :closable="false"
              show-icon
              class="market-group-err"
              title="该注册表加载失败"
              :description="`${group.error}。请检查该地址是否可达，或当前网络是否能访问该托管平台（例如容器内访问 raw.githubusercontent.com 常因网络不可达而失败，可改用 Gitee 源）。`"
            />
            <template v-if="group.items.length > 0">
              <el-table v-if="!isMobile" :data="group.items" stripe v-loading="marketLoading">
                <el-table-column label="名称" min-width="200">
                  <template #default="{ row }">
                    <div class="plugin-name">
                      {{ row.name }}
                      <el-tag v-if="row.builtin" size="small" type="warning" effect="light">内置</el-tag>
                    </div>
                    <div class="plugin-id">{{ row.id }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="类型 / 能力" min-width="200">
                  <template #default="{ row }">
                    <div class="cap-row">
                      <el-tag size="small" :type="typeTagColor(row)" effect="light">{{ typeLabel(row) }}</el-tag>
                      <el-tag v-for="cap in capabilityList(row).slice(0, 5)" :key="cap" size="small" effect="plain">{{ capLabel(cap) }}</el-tag>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column prop="version" label="版本" width="86" />
                <el-table-column prop="description" label="说明" min-width="200" show-overflow-tooltip />
                <el-table-column label="状态" width="104">
                  <template #default="{ row }">
                    <!-- 内置插件也可停用(服务生命周期联动);仅删除受限 -->
                    <el-switch v-if="row.installed" v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" />
                    <el-tag v-else size="small" type="info" effect="light">未安装</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="190">
                  <template #default="{ row }">
                    <template v-if="!row.builtin">
                      <el-button v-if="!row.installed" size="small" type="success" plain :loading="installing === installKey(row)" @click="installPlugin(row)">安装</el-button>
                      <el-button v-else-if="isUpdatable(row)" size="small" type="primary" :loading="installing === installKey(row)" @click="installPlugin(row)">更新</el-button>
                      <el-button v-else size="small" plain :loading="installing === installKey(row)" @click="installPlugin(row)">重装</el-button>
                    </template>
                    <el-button size="small" plain @click="editPlugin(row)">详情</el-button>
                  </template>
                </el-table-column>
              </el-table>
              <!-- 移动端卡片列表 -->
              <div v-else class="plugin-cards">
                <div v-for="row in group.items" :key="row.id" class="plugin-card">
                  <div class="pc-row">
                    <div class="pc-id">
                      <div class="plugin-name">
                        {{ row.name }}
                        <el-tag v-if="row.builtin" size="small" type="warning" effect="light">内置</el-tag>
                      </div>
                      <div class="plugin-id">{{ row.id }}</div>
                    </div>
                    <el-tag size="small" :type="typeTagColor(row)" effect="light">{{ typeLabel(row) }}</el-tag>
                  </div>
                  <div class="cap-row">
                    <el-tag v-for="cap in capabilityList(row).slice(0, 5)" :key="cap" size="small" effect="plain">{{ capLabel(cap) }}</el-tag>
                  </div>
                  <div class="pc-desc m-sub">{{ row.description }}</div>
                  <div class="pc-meta">
                    <span class="pc-ver">v{{ row.version }}</span>
                    <el-switch v-if="row.installed" v-model="row.enabled" :active-value="1" :inactive-value="0" @change="togglePlugin(row)" />
                    <el-tag v-else size="small" type="info" effect="light">未安装</el-tag>
                  </div>
                  <div class="pc-actions">
                    <template v-if="!row.builtin">
                      <el-button v-if="!row.installed" size="small" type="success" plain :loading="installing === installKey(row)" @click="installPlugin(row)">安装</el-button>
                      <el-button v-else-if="isUpdatable(row)" size="small" type="primary" :loading="installing === installKey(row)" @click="installPlugin(row)">更新</el-button>
                      <el-button v-else size="small" plain :loading="installing === installKey(row)" @click="installPlugin(row)">重装</el-button>
                    </template>
                    <el-button size="small" plain @click="editPlugin(row)">详情</el-button>
                  </div>
                </div>
              </div>
            </template>
            <el-empty v-else description="该注册表暂无可用插件" :image-size="50" />
          </div>
          <p v-if="groupedMarket.length > 0" class="market-note">同一插件可来自多个注册表，按来源分组显示（来源 github / gitee / 自建），请选择你要安装的源头。</p>
          <el-empty v-else description="尚未添加任何插件注册表" :image-size="60" />
        </el-card>
        <el-alert type="info" :closable="false" show-icon class="market-warn"
          title="插件运行模型与安全提示"
          description="内置插件随服务端发行,是核心功能(不可停用/删除);第三方插件在 QuickJS 沙箱中运行——拿不到 Node 进程能力,网络仅经受控的 host.http(需声明 net 权限),单插件内存/超时受限。但插件访问的外部服务地址仍由你配置,请仅从你信赖的注册表安装。" />
      </el-tab-pane>

      <!-- ============ Media fetch (lyrics / covers) — 能力级全局设置,独立于任何单个插件 ============ -->
      <el-tab-pane label="媒体获取" name="media">
        <div class="page-header">
          <h2>媒体获取</h2>
          <span class="page-sub">歌词 / 封面按需获取与批量补全 —— 全局设置,不归属于任何单个插件,换插件不影响设置</span>
        </div>

        <el-card class="mf-card" shadow="never">
          <template #header>
            <div class="card-head">
              <span class="card-title">歌词获取</span>
              <el-tag v-if="lyricProviderPlugins.length === 0" size="small" type="warning" effect="plain">未安装歌词提供方插件</el-tag>
            </div>
          </template>
          <div v-if="lyricProviderPlugins.length === 0" class="mf-empty">
            <el-empty description="未安装任何歌词提供方(lyricProvider)插件" :image-size="60">
              <el-button size="small" type="primary" @click="activeTab = 'market'">前往插件市场安装</el-button>
            </el-empty>
          </div>
          <div v-else class="mf-media">
            <div class="mf-media-row">
              <span class="mf-media-label">来源插件</span>
              <el-select v-model="lyricsSettings.providerId" clearable placeholder="自动" style="width: 260px" @change="saveMediaSettings('lyrics')">
                <el-option v-for="p in lyricProviderPlugins" :key="p.id" :label="providerLabel(p)" :value="p.id" />
              </el-select>
              <span class="field-hint">选择歌词来源插件;清空 = 自动(全部启用的歌词提供方)</span>
            </div>
            <div class="mf-media-row">
              <span class="mf-media-label">按需获取</span>
              <el-switch v-model="lyricsSettings.onDemand" @change="saveMediaSettings('lyrics')" />
              <span class="field-hint">本地/WebDAV 歌曲缺歌词时,播放实时向所选插件获取</span>
            </div>
            <div class="mf-media-row">
              <span class="mf-media-label">落库</span>
              <el-switch v-model="lyricsSettings.persist" @change="saveMediaSettings('lyrics')" />
              <span class="field-hint">获取到的歌词保存为本地文件(online-lyrics/),离线也能显示</span>
            </div>
            <div class="mf-media-row">
              <el-button size="small" type="primary" plain :loading="lyricsBackfill.running" @click="startBackfill('lyrics')">批量补全</el-button>
              <span v-if="lyricsBackfill.total > 0" class="field-hint">{{ backfillText('lyrics') }}</span>
            </div>
          </div>
        </el-card>

        <el-card class="mf-card" shadow="never">
          <template #header>
            <div class="card-head">
              <span class="card-title">封面获取</span>
              <el-tag v-if="coverProviderPlugins.length === 0" size="small" type="warning" effect="plain">未安装封面提供方插件</el-tag>
            </div>
          </template>
          <div v-if="coverProviderPlugins.length === 0" class="mf-empty">
            <el-empty description="未安装任何封面提供方(coverProvider)插件" :image-size="60">
              <el-button size="small" type="primary" @click="activeTab = 'market'">前往插件市场安装</el-button>
            </el-empty>
          </div>
          <div v-else class="mf-media">
            <div class="mf-media-row">
              <span class="mf-media-label">来源插件</span>
              <el-select v-model="coversSettings.providerId" clearable placeholder="自动" style="width: 260px" @change="saveMediaSettings('covers')">
                <el-option v-for="p in coverProviderPlugins" :key="p.id" :label="providerLabel(p)" :value="p.id" />
              </el-select>
              <span class="field-hint">选择封面来源插件;清空 = 自动(全部启用的封面提供方)</span>
            </div>
            <div class="mf-media-row">
              <span class="mf-media-label">按需获取</span>
              <el-switch v-model="coversSettings.onDemand" @change="saveMediaSettings('covers')" />
              <span class="field-hint">歌曲缺封面时,请求封面时实时向所选插件获取</span>
            </div>
            <div class="mf-media-row">
              <span class="mf-media-label">落库</span>
              <el-switch v-model="coversSettings.persist" @change="saveMediaSettings('covers')" />
              <span class="field-hint">下载缓存封面到本地,一次获取永久命中</span>
            </div>
            <div class="mf-media-row">
              <el-button size="small" type="primary" plain :loading="coversBackfill.running" @click="startBackfill('covers')">批量补全</el-button>
              <span v-if="coversBackfill.total > 0" class="field-hint">{{ backfillText('covers') }}</span>
            </div>
          </div>
        </el-card>

        <div class="mf-actions">
          <el-button type="primary" :loading="savingMedia" @click="saveAllMedia">保存设置</el-button>
          <span class="field-hint">修改即时生效;此按钮可一次性确认并保存「歌词获取」与「封面获取」全部设置。</span>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- Add plugin dialog -->
    <el-dialog v-model="showAddDialog" title="添加插件" width="500px" :append-to-body="true">
      <el-form label-width="80px">
        <el-form-item label="插件名称"><el-input v-model="newPlugin.name" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="newPlugin.description" type="textarea" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="addPlugin">添加</el-button>
      </template>
    </el-dialog>

    <!-- Add registry dialog -->
    <el-dialog v-model="showRegDialog" title="添加插件注册表" width="500px" :append-to-body="true">
      <el-form label-width="80px">
        <el-form-item label="URL">
          <el-input v-model="newRegistryUrl" placeholder="https://example.com/registry.json" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showRegDialog = false">取消</el-button>
        <el-button type="primary" :loading="addingReg" @click="addRegistry">添加</el-button>
      </template>
    </el-dialog>

    <!-- Plugin detail dialog: 功能介绍 / 处理逻辑 / 能力 / 权限 / 配置 -->
    <el-dialog v-model="showConfigDialog" :title="`插件详情 · ${displayName(editing)}`" width="720px" top="6vh" :append-to-body="true">
      <div class="pd-head">
        <span class="pd-id">{{ editing?.id }}@{{ editing?.version }}</span>
        <el-tag size="small" :type="typeTagColor(editing)" effect="light">{{ typeLabel(editing) }}</el-tag>
        <el-tag v-if="editing?.builtin" size="small" type="warning" effect="light">内置</el-tag>
        <el-tag v-else-if="editing" size="small" type="info" effect="light">外置</el-tag>
      </div>

      <div class="pd-section">
        <h4>功能介绍</h4>
        <p class="pd-desc">{{ parseManifest(editing).description || "—" }}</p>
      </div>

      <div class="pd-section">
        <h4>处理逻辑</h4>
        <div v-if="docMarkdown" class="pd-md" v-html="docMarkdown"></div>
        <template v-else>
          <ul class="pd-capdocs">
            <li v-for="cap in capabilityList(editing)" :key="cap">{{ capLabel(cap) }}：{{ capDoc(cap) }}</li>
          </ul>
          <p v-if="capabilityList(editing).length" class="pd-hint">该插件未提供详细文档，以上为按能力自动生成的说明。</p>
          <p v-else class="pd-hint">该插件未提供详细文档。</p>
        </template>
      </div>

      <div v-if="capabilityList(editing).length > 0" class="pd-section">
        <h4>能力清单</h4>
        <div class="cap-row">
          <el-tag v-for="cap in capabilityList(editing)" :key="cap" size="small" effect="plain">{{ capLabel(cap) }}</el-tag>
        </div>
      </div>

      <div v-if="permissionList(editing).length > 0" class="pd-section">
        <h4>权限</h4>
        <div class="cap-row">
          <el-tag v-for="perm in permissionList(editing)" :key="perm" size="small" type="warning" effect="plain">{{ permLabel(perm) }}</el-tag>
        </div>
      </div>

      <div v-if="canSaveConfig && configFields.length > 0" class="pd-section">
        <h4>配置</h4>
        <el-form label-width="120px">
          <!-- Config form is driven entirely by the plugin manifest's configSchema.
               No field is hardcoded to go-music-dl. -->
          <el-form-item v-for="f in configFields" :key="f.key" :label="f.label">
            <el-input
              v-if="f.type === 'text' || f.type === 'url'"
              v-model="editConfig[f.key]"
              :placeholder="f.help"
              style="width: 100%"
            />
            <el-input
              v-else-if="f.type === 'password'"
              v-model="editConfig[f.key]"
              type="password"
              show-password
              :placeholder="f.help"
              style="width: 100%"
            />
            <el-input-number
              v-else-if="f.type === 'number'"
              v-model="editConfig[f.key]"
              :min="0"
              controls-position="right"
              style="width: 180px"
            />
            <el-radio-group v-else-if="f.type === 'radio'" v-model="editConfig[f.key]">
              <el-radio v-for="o in (f.options || [])" :key="o.value" :value="o.value">{{ o.label }}</el-radio>
            </el-radio-group>
            <el-select v-else-if="f.type === 'select'" v-model="editConfig[f.key]" style="width: 100%">
              <el-option v-for="o in (f.options || [])" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
            <el-select
              v-else-if="f.type === 'multiselect' || f.type === 'multi-select'"
              v-model="editConfig[f.key]"
              multiple
              collapse-tags
              style="width: 100%"
            >
              <el-option v-for="o in (f.options || [])" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
            <!-- playlist-multi:参考歌单多选(本地 + 平台导入歌单,可搜索),由 manifest configSchema 声明 -->
            <el-select
              v-else-if="f.type === 'playlist-multi'"
              v-model="editConfig[f.key]"
              multiple
              filterable
              collapse-tags
              clearable
              placeholder="搜索并选择歌单(可多选)"
              style="width: 100%"
            >
              <el-option v-for="o in playlistOptions" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
            <!-- candidate-list:推荐榜单(平台 + URL + 显示名)可增删替换,由 manifest configSchema 声明 -->
            <div v-else-if="f.type === 'candidate-list'" class="candidate-list">
              <div v-for="(item, idx) in (editConfig[f.key] || [])" :key="idx" class="candidate-row">
                <el-select v-model="item.platform" style="width: 104px; flex: none">
                  <el-option label="网易云" value="netease" />
                  <el-option label="QQ音乐" value="qq" />
                </el-select>
                <el-input v-model="item.url" placeholder="榜单 URL" style="flex: 1; min-width: 0" />
                <el-input v-model="item.name" placeholder="显示名(可选)" style="width: 150px; flex: none" />
                <el-button
                  circle
                  text
                  type="danger"
                  :disabled="(editConfig[f.key] || []).length <= 1"
                  title="删除该榜单"
                  @click="removeCandidate(f.key, idx)"
                >✕</el-button>
              </div>
              <el-button text type="primary" @click="addCandidate(f.key)">+ 添加榜单</el-button>
            </div>
            <el-switch v-else-if="f.type === 'switch'" v-model="editConfig[f.key]" />
            <!-- keywords 字段特殊处理：渲染为标签输入组件，内置搜索入库按钮 -->
            <div v-else-if="f.key === 'keywords'" class="tag-input-wrap">
              <el-input
                v-model="tagInputValue"
                :placeholder="'输入关键词后按回车添加'"
                @keyup.enter="addTag(f.key)"
              >
                <template #append>
                  <el-button @click="addTag(f.key)">添加</el-button>
                </template>
              </el-input>
              <div v-if="getTags(f.key).length > 0" class="tag-list">
                <el-tag
                  v-for="(tag, idx) in getTags(f.key)"
                  :key="idx"
                  closable
                  :disable-transitions="true"
                  @close="removeTag(f.key, idx)"
                >{{ tag }}</el-tag>
              </div>
              <div class="tag-actions">
                <el-button type="primary" plain :loading="refreshingPlugin" @click="refreshPlugin">
                  关键词搜索入库
                </el-button>
                <span v-if="pluginRefreshResult" class="test-result" :class="{ ok: pluginRefreshResult.success }">{{ pluginRefreshResult.message }}</span>
              </div>
              <span v-if="f.help" class="field-hint">{{ f.help }}</span>
            </div>
            <span v-if="f.help && f.key !== 'keywords'" class="field-hint">{{ f.help }}</span>
            <!-- 配置项下方的「获取链接」:点击快速进入对应申请 / 授权 / 说明页。
                 支持 ${fieldKey} 插值当前配置值(如把已填的 apiKey 拼进授权页 URL)。
                 纯 manifest 驱动,不写死任何插件。 -->
            <div v-if="(f.links || []).length" class="field-links">
              <a
                v-for="(lk, li) in resolvedLinks(f)"
                :key="li"
                :href="lk.url"
                target="_blank"
                rel="noopener noreferrer"
                class="field-link"
              ><span class="field-link-icon">↗</span>{{ lk.text }}</a>
            </div>
          </el-form-item>

          <!-- 歌词/封面按需获取设置已移至「媒体获取」标签页(全局设置,不归属于单个插件)。 -->

          <!-- Only source plugins expose a reachable endpoint to test / web songs to purge. -->
          <el-form-item v-if="isSourcePlugin(editing) || hasWebRotation">
            <el-button v-if="isSourcePlugin(editing)" type="success" plain :loading="testing" @click="testSource">测试连接</el-button>
            <el-button v-if="hasWebRotation" type="warning" plain :loading="purging" @click="purgeWebSongs">立即清理</el-button>
            <span v-if="testResult" class="test-result" :class="{ ok: testResult.success }">{{ testResult.message }}</span>
          </el-form-item>

          <!-- 推荐歌单类插件(每日推荐/本地推荐/今日漫游/第三方推荐歌单如 ListenBrainz):
               手动重新生成「该插件自身」的推荐歌单(force 绕过间隔闸门)。
               能力驱动,不写死插件名。 -->
          <el-form-item v-if="isRecommenderPlugin(editing)">
            <el-button type="warning" plain :loading="refreshingPlugin" @click="refreshPlugin">
              立即刷新
            </el-button>
            <span v-if="pluginRefreshResult" class="test-result" :class="{ ok: pluginRefreshResult.success }">{{ pluginRefreshResult.message }}</span>
            <span class="field-hint">强制重新生成该插件的推荐歌单(同一天也可刷新),只影响它自己的歌单</span>
          </el-form-item>

          <!-- 关键词搜索入库按钮已内嵌在 keywords 字段的 tag-input 组件中。 -->

          <el-alert
            type="info"
            :closable="false"
            show-icon
            :title="`${typeLabel(editing)}插件`"
            :description="pluginHint(editing)"
          />
        </el-form>
      </div>

      <template #footer>
        <el-button @click="showConfigDialog = false">关闭</el-button>
        <el-button v-if="canSaveConfig && configFields.length > 0" type="primary" :loading="saving" @click="() => saveConfig()">保存配置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import EmptyState from "@/components/EmptyState.vue";
import api, { formatApiError } from "@/api";
import { useIsMobile } from "@/composables/useIsMobile";
import { parseManifest, parseConfig } from "@/utils/plugin";

const activeTab = ref<"installed" | "market" | "media">("installed");

// 移动端(≤768)把 el-table 切换为卡片列表,避免横向滚动(见 frontend-responsive CI 守卫)。
const isMobile = useIsMobile();

// ---- installed plugins ----
const plugins = ref<any[]>([]);
const loading = ref(false);
const showAddDialog = ref(false);
const newPlugin = reactive({ name: "", description: "" });

// ---- marketplace ----
const registries = ref<any[]>([]);
const marketPlugins = ref<any[]>([]);
const marketLoading = ref(false);
const installing = ref<string>("");
const showRegDialog = ref(false);
const newRegistryUrl = ref("");
const addingReg = ref(false);

/** 市场按注册表分组:以「注册表来源」里每个启用的注册表为分组骨架,
 *  确保即便某个注册表加载失败(网络不可达),也会显示为一个分组并给出错误提示,
 *  而不是静默消失。官方内置核心插件已不在此列表(只在「已安装」tab 展示)。 */
const groupedMarket = computed<any[]>(() => {
  const groups: any[] = [];
  for (const r of registries.value) {
    if (!r.enabled) continue;
    const items = marketPlugins.value.filter((p) => p.registryUrl === r.url);
    groups.push({
      key: r.url,
      title: r.url,
      sourceLabel: sourceLabel(r.url),
      items,
      error: r.error || null,
    });
  }
  return groups;
});

// ---- config dialog ----
const showConfigDialog = ref(false);
const editing = ref<any>(null);
const editConfig = reactive<any>({});
const testing = ref(false);
const saving = ref(false);
const purging = ref(false);
const testResult = ref<any>(null);

// ---- 歌词/封面按需获取(全局设置 + 批量补全) ----
const lyricsSettings = reactive({ providerId: "", onDemand: true, persist: false });
const coversSettings = reactive({ providerId: "", onDemand: true, persist: true });
const lyricsBackfill = reactive({ running: false, total: 0, done: 0, ok: 0, fail: 0, skipped: 0 });
const coversBackfill = reactive({ running: false, total: 0, done: 0, ok: 0, fail: 0, skipped: 0 });
const savingMedia = ref(false);

// ---- health ----
const healthMap = ref<Record<string, any>>({});

/** Config fields rendered in the dialog — driven by the plugin manifest. */
const configFields = computed<any[]>(() => parseManifest(editing.value).configSchema || []);

// ---- playlist-multi(参考歌单多选):歌单选项(本地 + 平台导入),打开详情弹窗时懒加载 ----
const allPlaylists = ref<any[]>([]);
const playlistOptions = computed(() =>
  allPlaylists.value.map((p: any) => ({
    value: p.id,
    label: p.sourcePlatform ? `[${p.sourcePlatform}] ${p.name}` : p.name,
  })),
);
async function loadPlaylistOptions() {
  if (allPlaylists.value.length) return;
  try {
    const res = await api.get("/rest/api/v1/playlists", { params: { page: 1, pageSize: 200 } });
    allPlaylists.value = res.data.items || [];
  } catch {
    allPlaylists.value = [];
  }
}

/** Whether the plugin declares the web-rotation capability (shows the purge button). */
const hasWebRotation = computed<boolean>(() =>
  (parseManifest(editing.value).capabilities || []).includes("webRotation"),
);

/** 歌词/封面 provider 候选:所有已安装且声明对应能力的插件(媒体获取页下拉用),
 *  不写死插件名 —— 未来装新歌词/封面插件自动出现,零代码改动。 */
const lyricProviderPlugins = computed<any[]>(() =>
  plugins.value.filter((p) => (parseManifest(p).capabilities || []).includes("lyricProvider")),
);
const coverProviderPlugins = computed<any[]>(() =>
  plugins.value.filter((p) => (parseManifest(p).capabilities || []).includes("coverProvider")),
);
function providerLabel(p: any): string {
  return `${displayName(p)}${p.enabled ? "" : "（已停用）"}`;
}

function isSourcePlugin(plugin: any) {
  return parseManifest(plugin).type === "source";
}

/** 推荐歌单类插件(每日推荐 / 本地推荐 / 今日漫游 / 第三方推荐歌单如 ListenBrainz):支持手动刷新。 */
function isRecommenderPlugin(plugin: any): boolean {
  const caps = parseManifest(plugin).capabilities || [];
  return ["dailyPlaylist", "localPlaylist", "comboPlaylist", "recommendPlaylist"].some((c) => caps.includes(c));
}

/** 插件是否配置了 keywords 字段(关键词搜索导入)。 */
const hasKeywordsConfig = computed(() => {
  if (!editing.value) return false;
  const m = parseManifest(editing.value);
  return (m.configSchema || []).some((f: any) => f.key === "keywords");
});

// ---- tag-input 组件支持 ----
const tagInputValue = ref('');

/** 把 editConfig 中以换行分隔的关键词字符串转为数组。 */
function getTags(key: string): string[] {
  const v = editConfig[key];
  if (!v) return [];
  return String(v).split('\n').filter((s: string) => s.trim().length > 0);
}

/** 添加一个关键词标签。 */
function addTag(key: string) {
  const val = tagInputValue.value.trim();
  if (!val) return;
  const tags = getTags(key);
  if (tags.includes(val)) {
    tagInputValue.value = '';
    return;
  }
  tags.push(val);
  editConfig[key] = tags.join('\n');
  tagInputValue.value = '';
}

/** 删除指定索引的关键词标签。 */
function removeTag(key: string, idx: number) {
  const tags = getTags(key);
  tags.splice(idx, 1);
  editConfig[key] = tags.join('\n');
}

// 手动刷新:调 /v1/recommend/refresh 传 pluginId,只重新生成「该插件自身」的歌单。
// 后端为**异步任务通道**(立即返回 started),前端轮询 GET /v1/plugins/:id/job
// 直到任务完成——不再被沙箱 15s / axios 15s 卡死。
const refreshingPlugin = ref(false);
const pluginRefreshResult = ref<{ success: boolean; message: string } | null>(null);
let pluginJobPollTimer: ReturnType<typeof setInterval> | null = null;
function stopPluginJobPoll() {
  if (pluginJobPollTimer) { clearInterval(pluginJobPollTimer); pluginJobPollTimer = null; }
}
onUnmounted(stopPluginJobPoll);

async function refreshPlugin() {
  if (!editing.value || refreshingPlugin.value) return;
  const pluginId = editing.value.id;
  refreshingPlugin.value = true;
  pluginRefreshResult.value = null;
  let done = false;
  const finish = (r: { success: boolean; message: string }) => {
    if (done) return;
    done = true;
    stopPluginJobPoll();
    pluginRefreshResult.value = r;
    refreshingPlugin.value = false;
  };
  try {
    const res = await api.post("/rest/api/v1/recommend/refresh", { pluginId });
    const d = res.data || {};
    if (!d.success) { finish({ success: false, message: d.error || "刷新失败" }); return; }
    if (!d.started && !d.alreadyRunning) { finish({ success: true, message: "刷新完成" }); return; }
    finish({ success: true, message: d.alreadyRunning ? "任务已在后台运行,等待完成…" : "已开始后台刷新,等待完成…" });
    // 轮询任务状态(每 2s,上限 6 分钟;超过则提示仍在后台运行)
    let elapsed = 0;
    const POLL_MS = 2000;
    const MAX_POLL_MS = 360000;
    const poll = async () => {
      try {
        const st = await api.get(`/rest/api/v1/plugins/${pluginId}/job`, { timeout: 10000 });
        const job = st.data?.job;
        if (job?.status === "ok") {
          finish({ success: true, message: job.summary ? String(job.summary) : "刷新完成" });
        } else if (job?.status === "error") {
          const err = job.sandboxCode
            ? `[${job.sandboxCode}] ${String(job.error || "刷新失败")}${job.hint ? "。" + String(job.hint) : ""}`
            : String(job.error || "刷新失败");
          finish({ success: false, message: err });
        } else if (elapsed >= MAX_POLL_MS) {
          finish({ success: true, message: "任务仍在后台运行中,稍后可在插件页查看结果" });
        }
      } catch { /* 单次轮询失败忽略,下一轮再试 */ }
    };
    pluginJobPollTimer = setInterval(() => { elapsed += POLL_MS; poll().catch(() => {}); }, POLL_MS);
  } catch (e: any) {
    finish({ success: false, message: formatApiError(e, "刷新失败") });
  }
}

/** Manifest display name, falling back to the stored row name (= plugin id). */
function displayName(plugin: any): string {
  return parseManifest(plugin).name || plugin?.name || "";
}

function hasConfig(plugin: any): boolean {
  return (parseManifest(plugin).configSchema || []).length > 0;
}

// 详情弹窗:处理逻辑(markdown)与配置可保存性
const docMarkdown = computed(() => {
  const md = parseManifest(editing.value).documentation;
  return md ? renderMarkdown(md) : "";
});
const canSaveConfig = computed(() => !!editing.value && editing.value.installed !== false);

// Plugin taxonomy — labels only. The backend decides what each type can do via
// manifest capabilities; the UI just renders whatever it declares.
const TYPE_LABELS: Record<string, string> = {
  source: "在线源",
  importer: "歌单导入",
  recommender: "推荐",
  sync: "同步",
  lyrics: "歌词",
  cover: "封面",
  renderer: "设备投屏",
  scrobbler: "播放上报",
};
const TYPE_COLORS: Record<string, string> = {
  source: "primary",
  importer: "success",
  recommender: "warning",
  sync: "info",
  lyrics: "danger",
  cover: "danger",
  renderer: "info",
  scrobbler: "info",
};
const CAP_LABELS: Record<string, string> = {
  search: "在线搜索",
  recommend: "平台推荐歌单",
  playlistSongs: "远程歌单曲目",
  stream: "音频流",
  lyrics: "在线歌词",
  webRotation: "在线歌曲轮换清理",
  playlistImport: "分享链接导入",
  playlistFile: "歌单文件导入",
  dailyPlaylist: "每日歌单生成",
  localPlaylist: "本地推荐生成",
  comboPlaylist: "组合歌单生成",
  recommendPlaylist: "推荐歌单生成",
  playlistSync: "歌单定时同步",
  autoMatch: "条目自动匹配",
  lyricProvider: "歌词提供方",
  coverProvider: "封面提供方",
  renderer: "设备投屏",
  scrobbler: "播放上报",
};
const PERM_LABELS: Record<string, string> = {
  log: "日志",
  storage: "存储",
  net: "网络",
  command: "命令",
  fs: "文件系统",
  "fs:music": "音乐目录",
  "fs:external": "外部目录",
  "songs:read": "读取歌曲",
  "songs:write": "写入歌曲",
  "playlists:read": "读取歌单",
  "playlists:write": "写入歌单",
  "inter-plugin": "插件间通信",
};

// 能力 → 处理逻辑说明(详情页在插件未提供 documentation 时按能力自动生成)
const CAP_DOCS: Record<string, string> = {
  search: "向在线源发起歌曲搜索并返回结果",
  recommend: "生成平台每日推荐歌单并同步到本地",
  playlistSongs: "拉取单个远程歌单的曲目列表",
  stream: "构造歌曲的音频流地址供播放器拉流",
  lyrics: "提供在线歌词（逐字/逐行）",
  webRotation: "定期清理过期的在线歌曲（每日推荐轮换）",
  playlistImport: "认领分享链接并解析成可导入的歌单",
  playlistFile: "认领上传的歌单文件并解析",
  dailyPlaylist: "每天定时生成「每日推荐」歌单",
  localPlaylist: "基于播放历史与收藏口味生成本地推荐",
  comboPlaylist: "合并其他推荐歌单生成组合歌单(如 今日漫游)",
  recommendPlaylist: "定期生成/刷新插件自己的推荐歌单(可固定首页、手动刷新)",
  playlistSync: "定期重新拉取已导入的远程歌单",
  autoMatch: "把歌单条目自动匹配到曲库或在线源",
  lyricProvider: "提供在线歌词的源",
  coverProvider: "提供在线封面的源",
  renderer: "投屏到局域网播放设备（DLNA 等）",
  scrobbler: "把播放事件上报到 Last.fm / ListenBrainz 等",
};

// 极简 markdown 渲染（文档为受控内容,先转义再套标签,防 XSS）
function renderMarkdown(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = esc(md);
  html = html.replace(/^```\n?([\s\S]*?)```$/gm, (_m, c) => `<pre class="md-code">${c}</pre>`);
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  const out: string[] = [];
  let listOpen = false;
  for (const line of html.split("\n")) {
    if (line.startsWith("<li>")) {
      if (!listOpen) { out.push("<ul>"); listOpen = true; }
      out.push(line);
    } else {
      if (listOpen) { out.push("</ul>"); listOpen = false; }
      if (line.trim()) out.push(`<p>${line}</p>`);
    }
  }
  if (listOpen) out.push("</ul>");
  return out.join("\n");
}

function capDoc(cap: string): string {
  return CAP_DOCS[cap] || "参与对应能力的工作流";
}

function typeLabel(plugin: any): string {
  const t = parseManifest(plugin).type;
  return TYPE_LABELS[t] || t || "未知";
}

function typeTagColor(plugin: any): any {
  return TYPE_COLORS[parseManifest(plugin).type] || "info";
}

function capabilityList(plugin: any): string[] {
  return parseManifest(plugin).capabilities || [];
}

function permissionList(plugin: any): string[] {
  return parseManifest(plugin).permissions || [];
}

/** 平台标签:优先 manifest.platformLabels 的中文名,缺省回退 slug。 */
function platformList(plugin: any): { slug: string; label: string }[] {
  const m = parseManifest(plugin);
  const slugs: string[] = Array.isArray(m.platforms) ? m.platforms : [];
  const labels: Record<string, string> = m.platformLabels || {};
  return slugs.map((s) => ({ slug: s, label: labels[s] || s }));
}

function capLabel(cap: string): string {
  return CAP_LABELS[cap] || cap;
}

function permLabel(perm: string): string {
  return PERM_LABELS[perm] || perm;
}

// Health status -> tag color / label.
function healthType(id: string): any {
  const s = healthMap.value[id]?.status;
  if (s === "green") return "success";
  if (s === "yellow") return "warning";
  if (s === "red" || s === "down") return "danger";
  return "info";
}
function healthLabel(id: string): string {
  const s: string = healthMap.value[id]?.status || "none";
  return ({ green: "正常", yellow: "波动", red: "异常", down: "离线", unknown: "未知", none: "未监控" } as Record<string, string>)[s] || "未监控";
}

const TYPE_HINTS: Record<string, string> = {
  source: "填写在线源服务地址后,即可在「在线音乐搜索」中搜索并导入为在线歌曲。",
  importer: "停用后,对应平台的歌单分享链接 / 歌单文件将无法导入。",
  recommender: "停用后,不再自动生成对应的推荐歌单。",
  sync: "停用后,不再自动重新拉取已开启同步的歌单(手动同步仍可用)。",
  lyrics: "作为歌词提供方参与「能力优先」调度,首个可用方胜出。",
  cover: "作为封面提供方参与「能力优先」调度,首个可用方胜出。",
  renderer: "提供 DLNA / 设备投屏能力,可在播放器中选择设备投放。",
  scrobbler: "在播放 / 记录事件时上报到外部服务(如 Last.fm)。",
};

function pluginHint(plugin: any): string {
  const m = parseManifest(plugin);
  const extra = hasConfig(plugin) ? "" : "该插件无需额外配置,用开关启用/停用即可。";
  return [m.description, TYPE_HINTS[m.type], extra].filter(Boolean).join(" ");
}

function providerId(plugin: any): string {
  return parseManifest(plugin).id || "";
}

/** 配置项下方的「获取链接」:渲染为可点击外链,支持 ${fieldKey} 插值当前配置值。
 *  例:sessionKey 的 link.url = "https://last.fm/api/auth?api_key=${apiKey}"
 *  → 自动把用户已填的 apiKey 拼进去,点开即是带 Key 的授权页。 */
function resolvedLinks(f: any): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  for (const lk of f.links || []) {
    const raw = typeof lk.url === "string" ? lk.url : "";
    const url = raw.replace(/\$\{(\w+)\}/g, (_m: string, k: string) => {
      const v = editConfig[k];
      return v === undefined || v === null ? "" : encodeURIComponent(String(v));
    });
    out.push({ text: lk.text || url, url });
  }
  return out;
}

async function loadPlugins() {
  loading.value = true;
  try {
    const res = await api.get("/rest/api/v1/plugins");
    plugins.value = (res.data || []).map((p: any) => ({ ...p, manifest: p.manifest, config: p.config }));
  } catch {
    plugins.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadHealth() {
  try {
    const res = await api.get("/rest/api/v1/plugins/health");
    const map: Record<string, any> = {};
    for (const h of res.data?.health || []) map[h.pluginId] = h;
    healthMap.value = map;
  } catch {
    healthMap.value = {};
  }
}

async function togglePlugin(plugin: any) {
  await api.put(`/rest/api/v1/plugins/${plugin.id}/toggle`);
  ElMessage.success("已更新");
  loadHealth();
}

/** 简单 semver 比较:<0 表示 a<b,=0 相等,>0 表示 a>b。 */
function verCmp(a: string, b: string): number {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** 已安装且市场版本比本地更高 → 显示「更新」按钮(覆盖安装即升级)。 */
function isUpdatable(row: any): boolean {
  return !!row.installed && !!row.installedVersion && verCmp(row.version, row.installedVersion) > 0;
}

/** 来源 host(如 raw.githubusercontent.com),用于区分同一插件的不同源头。 */
function sourceHost(url: string): string {
  try { return new URL(url).host; } catch { return url || "—"; }
}

/** 来源标识:github / gitee / 其他 host。 */
function sourceLabel(url: string): string {
  if (!url) return "";
  if (url.includes("gitee.com")) return "gitee";
  if (url.includes("github.com") || url.includes("githubusercontent.com")) return "github";
  return sourceHost(url);
}

/** 安装按钮的加载键:同 id 不同来源也要能独立显示 loading。 */
function installKey(row: any): string {
  return `${row.id}@${row.sourceUrl || "builtin"}`;
}

/** 删除外置插件(确认后调 DELETE /v1/plugins/:id)。 */
async function confirmDelete(row: any) {
  try {
    await ElMessageBox.confirm(
      `删除「${displayName(row)}」后将移除其插件文件与记录,确定删除吗?`,
      "删除插件",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await api.delete(`/rest/api/v1/plugins/${row.id}`);
    ElMessage.success("已删除");
    loadPlugins();
    loadHealth();
    loadMarketplace();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "删除失败");
  }
}

function editPlugin(plugin: any) {
  editing.value = plugin;
  const cfg = parseConfig(plugin);
  const schema = parseManifest(plugin).configSchema || [];
  for (const key of Object.keys(editConfig)) delete editConfig[key];
  for (const f of schema) {
    let v = cfg[f.key];
    if (v === undefined) v = f.default;
    if (v === undefined) {
      if (f.type === "multiselect" || f.type === "select" || f.type === "playlist-multi") v = [];
      else if (f.type === "switch") v = false;
      else if (f.type === "number") v = 0;
      else v = "";
    }
    // 数组型默认值(如 candidate-list 的预填榜单)深拷贝,避免编辑行时污染 manifest 默认对象。
    if (Array.isArray(v)) v = JSON.parse(JSON.stringify(v));
    editConfig[f.key] = v;
  }
  // 有 playlist-multi 字段时懒加载歌单选项(本地 + 平台导入)
  if (schema.some((f: any) => f.type === "playlist-multi")) loadPlaylistOptions();
  testResult.value = null;
  showConfigDialog.value = true;
}

// candidate-list:新增一行空白榜单(默认网易云)
function addCandidate(key: string) {
  if (!Array.isArray(editConfig[key])) editConfig[key] = [];
  editConfig[key].push({ platform: "netease", url: "", name: "" });
}

// candidate-list:删除指定行(至少保留 1 个,由按钮 disabled 兜底)
function removeCandidate(key: string, idx: number) {
  const arr = editConfig[key];
  if (Array.isArray(arr) && arr.length > 1) arr.splice(idx, 1);
}

async function testSource() {
  if (!editing.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    await saveConfig({ silent: true });
    const res = await api.post(`/rest/api/v1/online/${providerId(editing.value)}/test`, {});
    testResult.value = { success: res.data.success, message: res.data.message || res.data.error || "未知结果" };
  } catch (e: any) {
    testResult.value = { success: false, message: e?.response?.data?.error || e.message || "连接失败" };
  } finally {
    testing.value = false;
  }
}

async function saveConfig(opts?: { silent?: boolean }) {
  if (!editing.value) return;
  saving.value = true;
  try {
    const cfg: any = {};
    for (const f of configFields.value) {
      let v = editConfig[f.key];
      // candidate-list:清洗空行 + 至少保留 1 个有效榜单,与后端 cleanCandidates 对齐。
      if (f.type === "candidate-list") {
        const arr = Array.isArray(v) ? v : [];
        const cleaned = arr
          .filter((c: any) => c && c.url && String(c.url).trim() && c.platform)
          .map((c: any) => ({
            platform: c.platform,
            url: String(c.url).trim(),
            name: (c.name || "").trim() || undefined,
          }));
        if (cleaned.length === 0) {
          ElMessage.error("推荐榜单至少需要保留 1 个有效榜单");
          saving.value = false;
          return;
        }
        v = cleaned;
      }
      cfg[f.key] = v;
    }
    await api.put(`/rest/api/v1/plugins/${editing.value.id}`, { config: cfg });
    if (!opts?.silent) {
      ElMessage.success("已保存");
      showConfigDialog.value = false;
      loadPlugins();
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "保存失败");
  } finally {
    saving.value = false;
  }
}

async function addPlugin() {
  if (!newPlugin.name) {
    ElMessage.warning("请输入插件名称");
    return;
  }
  await api.post("/rest/api/v1/plugins", newPlugin);
  showAddDialog.value = false;
  newPlugin.name = "";
  newPlugin.description = "";
  ElMessage.success("添加成功");
  loadPlugins();
}

async function purgeWebSongs() {
  if (!editing.value) return;
  purging.value = true;
  try {
    await saveConfig({ silent: true });
    const res = await api.post(`/rest/api/v1/online/${providerId(editing.value)}/purge-web-songs`, {});
    if (res.data.success) {
      if (res.data.mode === "rotate") {
        ElMessage.success(`已清理 ${res.data.purged} 首歌曲,${res.data.covers} 张封面`);
      } else {
        ElMessage.info("当前为「永不过期」模式,未清理任何歌曲");
      }
    } else {
      ElMessage.warning(res.data.error || "清理失败");
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || e.message || "清理失败");
  } finally {
    purging.value = false;
  }
}

// ---- 歌词/封面按需获取设置 + 批量补全 ----
async function loadMediaSettings() {
  try {
    const l = await api.get("/rest/api/v1/lyrics/settings");
    if (l.data) Object.assign(lyricsSettings, l.data);
    const c = await api.get("/rest/api/v1/covers/settings");
    if (c.data) Object.assign(coversSettings, c.data);
  } catch { /* 后端旧版本无此端点时保持默认 */ }
}

async function saveMediaSettings(kind: "lyrics" | "covers"): Promise<boolean> {
  const s = kind === "lyrics" ? lyricsSettings : coversSettings;
  try {
    await api.put(`/rest/api/v1/${kind}/settings`, { providerId: s.providerId, onDemand: s.onDemand, persist: s.persist });
    return true;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "设置保存失败");
    return false;
  }
}

/** 一次性保存「歌词获取」+「封面获取」两组全局设置(保留开关即时保存的同时,给显式确认入口)。 */
async function saveAllMedia() {
  savingMedia.value = true;
  const [a, b] = await Promise.all([saveMediaSettings("lyrics"), saveMediaSettings("covers")]);
  savingMedia.value = false;
  if (a && b) ElMessage.success("已保存媒体获取设置");
}

async function startBackfill(kind: "lyrics" | "covers") {
  const st = kind === "lyrics" ? lyricsBackfill : coversBackfill;
  if (st.running) return;
  try {
    const res = await api.post(`/rest/api/v1/${kind}/backfill`);
    if (res.data.running) {
      st.running = true;
      if (res.data.total !== undefined) st.total = res.data.total;
      ElMessage.success(`开始补全,共 ${st.total} 首缺${kind === "lyrics" ? "歌词" : "封面"}的歌曲`);
      pollBackfill(kind);
    } else if (res.data.accepted === false && res.data.error) {
      ElMessage.error(res.data.error);
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "启动补全失败");
  }
}

function pollBackfill(kind: "lyrics" | "covers") {
  const st = kind === "lyrics" ? lyricsBackfill : coversBackfill;
  const timer = window.setInterval(async () => {
    try {
      const res = await api.get(`/rest/api/v1/${kind}/backfill/status`);
      if (res.data) Object.assign(st, res.data);
      if (!res.data?.running) {
        window.clearInterval(timer);
        st.running = false;
        ElMessage.success(`补全完成:成功 ${st.ok},失败 ${st.fail}${st.skipped ? `,跳过 ${st.skipped}` : ""}`);
      }
    } catch {
      window.clearInterval(timer);
      st.running = false;
    }
  }, 2000);
}

function backfillText(kind: "lyrics" | "covers"): string {
  const st = kind === "lyrics" ? lyricsBackfill : coversBackfill;
  let t = `已处理 ${st.done}/${st.total},成功 ${st.ok},失败 ${st.fail}`;
  if (st.skipped) t += `,跳过 ${st.skipped}`;
  t += st.running ? ",进行中…" : ",已完成";
  return t;
}

// ---- marketplace ----
async function loadMarketplace() {
  marketLoading.value = true;
  try {
    const res = await api.get("/rest/api/v1/plugins/registry");
    registries.value = res.data?.registries || [];
    marketPlugins.value = res.data?.plugins || [];
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "拉取插件市场失败");
    registries.value = [];
    marketPlugins.value = [];
  } finally {
    marketLoading.value = false;
  }
}

async function addRegistry() {
  if (!/^https?:\/\//.test(newRegistryUrl.value)) {
    ElMessage.warning("注册表 URL 必须是 http(s) 链接");
    return;
  }
  addingReg.value = true;
  try {
    await api.post("/rest/api/v1/plugins/registry", { url: newRegistryUrl.value });
    newRegistryUrl.value = "";
    showRegDialog.value = false;
    ElMessage.success("已添加");
    loadMarketplace();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "添加失败");
  } finally {
    addingReg.value = false;
  }
}

async function removeRegistry(row: any) {
  try {
    await api.delete(`/rest/api/v1/plugins/registry/${row.id}`);
    ElMessage.success("已删除");
    loadMarketplace();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "删除失败");
  }
}

async function installPlugin(row: any) {
  const key = installKey(row);
  installing.value = key;
  try {
    await api.post("/rest/api/v1/plugins/registry/install", { downloadUrl: row.downloadUrl || row.url });
    ElMessage.success(`已安装 ${row.name}`);
    loadMarketplace();
    loadPlugins();
    loadHealth();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error || "安装失败");
  } finally {
    installing.value = "";
  }
}

/** 切到「插件市场」标签页时自动刷新一次市场;切到「媒体获取」时刷新一次全局设置。 */
function onTabChange(name: string | number) {
  if (name === "market") loadMarketplace();
  else if (name === "media") loadMediaSettings();
}

onMounted(() => {
  loadPlugins();
  loadHealth();
  loadMediaSettings();
});
</script>

<style lang="scss" scoped>
.admin-plugins { padding: 24px 32px 130px; max-width: 1200px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; h2 { font-size: 28px; font-weight: 700; margin: 0; } }
.page-sub { font-size: 13px; color: var(--el-text-color-secondary); }
.mf-card { margin-bottom: 20px; }
.mf-actions { display: flex; align-items: center; gap: 12px; margin-top: 4px; flex-wrap: wrap; }
.mf-card .card-title { font-size: 15px; font-weight: 600; color: var(--el-text-color-primary); }
.mf-empty { padding: 8px 0; }
.test-result { margin-left: 12px; font-size: 13px; color: var(--el-color-danger); &.ok { color: var(--el-color-success); } }
.plugin-name { font-weight: 600; line-height: 1.35; }
.plugin-id { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.35; }
.cap-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 12px; }
.cap-label { font-size: 12px; color: var(--el-text-color-secondary); margin-right: 2px; }
.field-hint { margin-left: 12px; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.5; display: inline-block; max-width: 360px; }
.tag-input-wrap { width: 100%; }
.tag-input-wrap .tag-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.tag-input-wrap .tag-actions { margin-top: 10px; }
.tag-input-wrap .tag-actions .test-result { margin-left: 12px; }
.field-links { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 6px 0 0 12px; }
.field-link { font-size: 12px; color: var(--el-color-primary); text-decoration: none; display: inline-flex; align-items: center; gap: 3px; line-height: 1.6; }
.field-link:hover { text-decoration: underline; }
.field-link-icon { font-size: 11px; transform: translateY(0.5px); }
.candidate-list { display: flex; flex-direction: column; gap: 8px; max-width: 640px; }
.candidate-row { display: flex; align-items: center; gap: 8px; }
.candidate-row .el-input { margin: 0; }
.mf-media { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.mf-media-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mf-media-label { flex: 0 0 64px; font-size: 13px; color: var(--el-text-color-primary); }
.mf-media .field-hint { margin-left: 0; max-width: 340px; }
.market-card { margin-bottom: 20px; }
.market-card .card-head { display: flex; justify-content: space-between; align-items: center; }
.market-warn { margin-top: 4px; }
.market-note { margin: 12px 4px 0; font-size: 12px; color: var(--el-text-color-secondary); }
.market-group { margin-bottom: 18px; }
.market-group .group-head { display: flex; align-items: center; gap: 8px; margin: 4px 0 8px; }
.market-group .group-title { font-size: 13px; font-weight: 600; color: var(--el-text-color-primary); word-break: break-all; }
.src-host { font-size: 13px; font-weight: 600; line-height: 1.4; }
.src-url { font-size: 11px; color: var(--el-text-color-secondary); line-height: 1.4; word-break: break-all; }
.src-builtin { font-size: 13px; color: var(--el-text-color-secondary); }
.pd-head { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.pd-id { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--el-text-color-secondary); }
.pd-section { margin-bottom: 18px; }
.pd-section h4 { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: var(--el-text-color-primary); }
.pd-desc { margin: 0; font-size: 13px; line-height: 1.7; color: var(--el-text-color-regular); }
.pd-md { font-size: 13px; line-height: 1.75; color: var(--el-text-color-regular); }
.pd-md h2 { font-size: 15px; margin: 14px 0 6px; }
.pd-md h3 { font-size: 14px; margin: 12px 0 6px; }
.pd-md p { margin: 6px 0; }
.pd-md ul { margin: 6px 0; padding-left: 20px; }
.pd-md li { margin: 3px 0; }
.pd-md strong { font-weight: 600; }
.pd-md code { font-family: var(--font-mono, monospace); font-size: 12px; background: var(--el-fill-color-light); padding: 1px 5px; border-radius: 4px; }
.pd-md pre.md-code { background: var(--el-fill-color-light); padding: 10px 12px; border-radius: 8px; overflow-x: auto; }
.pd-capdocs { margin: 0; padding-left: 20px; }
.pd-capdocs li { font-size: 13px; line-height: 1.8; color: var(--el-text-color-regular); }
.pd-hint { margin: 8px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
/* 移动端卡片列表(替代 el-table) */
.plugin-cards, .registry-cards { display: flex; flex-direction: column; gap: 12px; margin-top: 4px; }
.plugin-card, .registry-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--fnos-radius-lg);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pc-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.pc-id { min-width: 0; }
.pc-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pc-ver { font-size: 12px; color: var(--fnos-text-tertiary); }
.pc-desc { line-height: 1.5; word-break: break-word; }
.pc-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rc-url { font-size: 13px; color: var(--fnos-text-primary); word-break: break-all; line-height: 1.5; }
.rc-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

@media (max-width: 768px) {
  .admin-plugins { padding: 20px 16px; }
  .page-header h2 { font-size: 24px; }
  :deep(.el-table) { font-size: 13px; }
  /* 候选榜单行在窄屏换行,每个输入占满一行 */
  .candidate-row { flex-wrap: wrap; }
  .candidate-row .el-input,
  .candidate-row .el-select { flex: 1 1 100% !important; width: 100% !important; }
  .candidate-row .el-button { flex: 0 0 auto; }
  /* 媒体获取行的固定宽控件在窄屏占满 */
  .mf-media-row .el-select { width: 100% !important; }
}
</style>
