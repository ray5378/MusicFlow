# MusicFlow-V2 外置插件开发指南（PLUGIN_DEV）

> 适用版本：MusicFlow-V2（插件化架构，核心只按「能力 capability」查找插件）
> 目标：教你自己写一个 drop-in 插件，丢进 `data/plugins/<id>/` 即可被后端加载，**无需改任何核心代码**。

---

## 1. 插件放在哪

后端启动时（`initDatabase()` 之后）会扫描：

```
<data>/plugins/<your-plugin-id>/index.js
```

`<data>` 的位置由环境变量决定：

- 默认：`backend/data/`（即项目 backend 目录下的 `data/`）
- 或 `DATA_DIR` 环境变量指定的任意目录：`$DATA_DIR/plugins/<id>/index.js`

> 仓库里 `examples/plugins/hello-importer/index.js` 是一个可复制的参考实现。**它不在 `data/plugins` 下，所以不会被自动加载**——请把它整体复制到 `data/plugins/` 再启用。

**热重载**：修改 / 新增 / 删除 `data/plugins/<id>/` 下的文件后，后端会自动重新发现并（重）注册该插件，无需重启（见 §10）。

---

## 2. 一个插件 = 一个 ESM 模块

`index.js` 必须是 ES Module，导出两个顶层常量：

```js
export const manifest = { /* 自描述元数据，核心只读它 */ };
export const impl = { /* 能力对应的具体方法 */ };
```

- `manifest`：告诉核心「我是谁、我会什么、需要什么配置、要什么权限」。
- `impl`：真正干活的函数。核心只会调用你在 `manifest.capabilities` 里声明的能力对应的方法。

插件**永远不要 `import` 后端内部模块**（如 `../../src/...`）。它只通过运行时注入的 `host` 上下文访问宿主能力（见 §5）。这是 in-process 架构下唯一的隔离手段——靠约定与 code review 保证，不是运行时沙箱。

---

## 3. Manifest 字段（必填 + 选填）

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 全局唯一，正则 `^[a-zA-Z0-9][a-zA-Z0-9-]*$`。重名会被跳过（已注册的赢）。 |
| `name` | ✅ | 展示名（插件页显示）。 |
| `version` | ✅ | 插件版本，语义化版本串。 |
| `type` | ✅ | `"source" \| "importer" \| "recommender" \| "sync" \| "lyrics" \| "cover" \| "renderer" \| "scrobbler"` 之一。 |
| `capabilities` | ✅ | 非空数组，声明本插件提供的能力（见 §4）。 |
| `configSchema` | ✅ | 数组（可为空 `[]`）。描述插件配置项，自动渲染成插件页表单。 |
| `description` | ⬜ | 描述。 |
| `permissions` | ⬜ | 字符串数组，声明本插件需要的权限（见 §5）。不声明则无受控能力可用。 |
| `platforms` | ⬜ | 字符串数组，用于前端提示（如 `["qq"]`）。source/importer 常用。 |
| `recommendPrefix` | ⬜ | source 插件专用：每日推荐歌单 URL 前缀。 |
| `minAppVersion` | ⬜ | 要求的最低 App 版本；低于此版本会被跳过（`dev` 构建不受限）。 |
| `author` / `homepage` / `license` / `icon` | ⬜ | 元数据，市场页展示。 |
| `downloadUrl` / `updateUrl` | ⬜ | 市场页展示下载 / 自更新源。 |
| `urlPatterns` | ⬜ | 字符串数组，仅作文档/UI 提示；真正的路由由 `impl.canHandle()` 决定。 |
| `defaultEnabled` | ⬜ | 外置插件默认 `false`（用户手动开启）；内置插件才用 `true`。 |

### 3.1 `configSchema` 字段结构

```js
{ key: "token", label: "访问令牌", type: "text", required: false, default: "", help: "可选" }
```

`type` 可选：`"text" | "url" | "number" | "select" | "multiselect" | "radio" | "switch"`。
`select/multiselect/radio` 需提供 `options: [{ label, value }]`。

---

## 4. 能力（capabilities）与 `impl` 方法对照

核心按 `manifest.capabilities` 找到启用插件后，调用 `impl` 上对应的方法。**只调用你声明的能力对应的方法**；没声明的方法即使写了也不会被核心调用。

Provider 类能力（`lyricProvider` / `coverProvider` / `renderer` / `scrobbler`）的方法**第一个参数是 `host`**（受控上下文，见 §5），其余是业务参数。

### 4.1 `source` 类型（在线音乐源，如 go-music-dl）
| capability | impl 方法 |
|------|------|
| `search` | `search(config, query)` |
| `recommend` | `recommend(config, channel)` |
| `playlistSongs` | `playlistSongs(config, id)` |
| `stream` | `streamUrl(config, song)` |
| `lyrics` | `lyricUrl(config, song)`（注：建议用独立的 `lyricProvider` 能力替代，见 §4.5） |
| `webRotation` | （由核心的 purge 逻辑触发，无需特定方法） |

### 4.2 `importer` 类型（歌单导入）
| capability | impl 方法 |
|------|------|
| `playlistImport` | `canHandle(url): boolean` + `fetchPlaylist(url): Promise<ImportedPlaylistShape>` |
| `playlistFile` | `canHandleFile(raw): boolean` + `parseFile(raw): Promise<ImportedPlaylistShape[]>` |

`ImportedPlaylistShape` = `{ name, platform, coverUrl?, tracks: ImportedTrackShape[] }`
`ImportedTrackShape` = `{ externalId, title, artist, album?, duration? }`

### 4.3 `recommender` 类型（每日推荐）
| capability | impl 方法 |
|------|------|
| `dailyPlaylist` | `runDailyJob(): Promise<string \| null>` —— 返回一句话摘要或 null |
| `localPlaylist` | `pickSongs(date?): Promise<{ songIds, sourceUsers, fallback }>` |

### 4.4 `sync` 类型（歌单同步）
| capability | impl 方法 |
|------|------|
| `playlistSync` | `runSyncJob(): Promise<string \| null>` —— 返回一句话摘要或 null |
| `autoMatch` | （被 `playlistSync` 用作未匹配歌曲的在线匹配源；默认回退到 `search` 能力） |

### 4.5 `lyrics` 类型 → `lyricProvider` 能力（歌词提供方）
| capability | impl 方法 |
|------|------|
| `lyricProvider` | `searchLyrics(host, song): Promise<{ lrc?, text? } \| null>` |

核心 `searchLyrics()` 遍历所有**启用的** `lyricProvider` 插件，**first-match-wins**（首个返回非空结果的胜出；抛错的被记入健康追踪后跳过）。可并存多个歌词源（如 go-music-dl 歌词 + 网易云歌词），用户在插件页独立开关。

### 4.6 `cover` 类型 → `coverProvider` 能力（封面提供方）
| capability | impl 方法 |
|------|------|
| `coverProvider` | `searchCover(host, song): Promise<{ url? } \| null>` |

与歌词同理，first-match-wins。让社区能补网易云 / QQ 封面源。

### 4.7 `renderer` 类型（设备投屏）
| capability | impl 方法 |
|------|------|
| `renderer` | `discover(): Promise<RendererDevice[]>` + `cast(deviceId, songId): Promise<{ mediaUri }>` + 可选 `control(deviceId, action, payload?)` |

内置 DLNA 适配器已注册为 `renderer` 插件。Chromecast / AirPlay / Kodi 可由社区新增插件接入，核心零改动。

`RendererDevice` = `{ id, name, type, available, meta? }`

### 4.8 `scrobbler` 类型（播放上报）
| capability | impl 方法 |
|------|------|
| `scrobbler` | 可选 `onPlay(host, event)` + 可选 `onScrobble(host, event)` |

核心在播放 / 记录事件时，把事件分发给所有启用的 `scrobbler` 插件（如 Last.fm / ListenBrainz）。
`ScrobbleEvent` = `{ songId, title, artist, album?, duration?, playedAt }`

---

## 5. 受控上下文 `host.*`（权限模型）

插件**不直接 import 后端**。核心在调用时注入一个 `host` 对象，这是插件唯一能触碰宿主的入口（仿 songloft `songloft.*`，但 in-process 下是契约级而非运行时隔离）。

```js
export const impl = {
  async searchLyrics(host, song) {
    host.log("looking up", song.title);
    const cached = await host.storage.get("last:" + song.title); // 受 storage 权限保护
    const res = await host.http("https://api.example.com/lyric?t=" + encodeURIComponent(song.title)); // 受 net 权限保护
    return { text: await res.text() };
  },
};
```

`host` 暴露：

| 成员 | 说明 | 所需权限 |
|------|------|----------|
| `host.pluginId` / `host.version` | 本插件 id / 运行中的 App 版本 | — |
| `host.config` | 本插件当前存储的配置（每次调用都是最新） | — |
| `host.log(...args)` | 带插件前缀的日志 | `log`（默认允许） |
| `host.storage` | 通用 JSON 键值存储（见下） | `storage` |
| `host.http(input, init)` | fetch 封装 | `net` |
| `host.comm` | 插件间通信（见 §6） | `inter-plugin` |

### 5.1 权限白名单 `KNOWN_PERMISSIONS`

manifest 的 `permissions` 只能是白名单中的值，否则 manifest 校验阶段被拒绝。支持两种通配：

- 命名空间通配：`songs.*` 同时授予 `songs:read` 与 `songs:write`。
- 全局授予：`*`（信任决策——in-process 下等于把所有能力交给插件）。

白名单：

```
log              # 命名空间日志
storage          # 插件级 KV 存储
net              # 发起 HTTP 请求（host.http）
command          # 执行命令（高风险，外置插件慎用）
fs               # 文件系统（高风险）
fs:music         # 仅音乐目录
fs:external       # 仅外部目录
songs:read       # 读取歌曲
songs:write      # 写入歌曲
playlists:read   # 读取歌单
playlists:write  # 写入歌单
inter-plugin     # 插件间通信
```

> 高风险权限（`command` / `fs` / `net`）在 in-process 架构下几乎等于「给插件本机执行权」。内置插件可信；**外部插件（data/plugins 拖入）只给 `host.*` 上下文、禁止 import 后端内部**，UI 市场页会明确「外部插件需自行承担风险」。

### 5.2 通用 KV 存储 `host.storage`

给插件一个与 `config` 区分的键值存储（JSON），按 `plugin_id` 隔离，插件 A 读不到插件 B 的键。适合歌词缓存、OAuth token、限流状态等。

```js
await host.storage.set("token", "abc");
const v = await host.storage.get("token");   // null if absent
await host.storage.delete("token");
const keys = await host.storage.keys();
```

---

## 6. 插件间通信 `host.comm`

带 `inter-plugin` 权限的插件可通过事件总线与其他插件对话，无需互相 import（仿 songloft `comm`）。

```js
// 在 impl 初始化时（或首次调用 host 时）注册监听
host.comm.on((msg) => { /* 处理 msg */ });

// 发送 / 广播
host.comm.send("other-plugin-id", { type: "hello", payload: 1 });
host.comm.broadcast({ type: "tick" });
```

- `on(handler)` / `off(handler)` 注册 / 注销监听。
- `send(targetId, msg)` 定向发给某插件；`broadcast(msg)` 发给除自己外的所有监听者。
- 无 `inter-plugin` 权限时调用会抛错。

---

## 7. 安全边界（后端强制）

后端加载外置插件时做了以下防护，**任何一道不过都直接跳过该插件，绝不让启动失败**：

1. **路径白名单**：只能加载 `<data>/plugins/<id>/index.js`，路径穿越（`../`）一律拒绝。
2. **Manifest 校验**：`id` / `type` / `capabilities` / `configSchema` 必须合规，否则跳过。
3. **权限校验**：`permissions` 含白名单外的值直接拒绝（含非法通配）。
4. **minAppVersion**：`manifest.minAppVersion` 高于当前 App 版本时跳过（dev 构建放行）。
5. **id 冲突**：与已注册插件（内置或先发现的）重名时，已有者胜出，新者跳过。

---

## 8. 安装与启用流程

**方式 A：拖入目录（开发 / 自托管）**

```bash
# 1) 复制插件到数据目录（DATA_DIR 或默认的 backend/data）
mkdir -p backend/data/plugins
cp -r my-plugin backend/data/plugins/

# 2) 后端会自动热重载（或重启）。启动日志应出现:
#    [PLUGIN] 已加载外置插件 my-plugin (lyrics, lyricProvider)
#    [PLUGIN] 已加载外置插件 my-plugin (cover, coverProvider)

# 3) 打开「插件」管理页 → 找到 my-plugin → 启用
```

**方式 B：插件市场（推荐给普通用户）**

管理员「插件」页 → 「插件市场」标签页：

1. 在「注册表来源」里「添加注册表」（粘贴一个 `registry.json` / 对象 `{ plugins, includes }` 的 URL）。
2. 「可安装插件」列表自动刷新；点「安装」即下载归档 → 解压到 `data/plugins/<id>/` → 重新发现并热注册，**无需重启**。
3. 安装后回到「已安装」标签页启用即可。

> 外置插件默认 `defaultEnabled: false`，必须手动启用。启用状态、配置都存于 `plugins` 表，重启保留。

---

## 9. 内置插件清单（可作为参考实现）

| id | type | capabilities | 文件 |
|----|------|--------------|------|
| `go-music-dl` | source | search/recommend/playlistSongs/stream/lyrics/webRotation | `services/source/online/goMusicDl.ts` |
| `go-music-dl-lyrics` | lyrics | lyricProvider | `services/plugin/lyrics/goMusicDlLyrics.ts` |
| `go-music-dl-cover` | cover | coverProvider | `services/plugin/covers/goMusicDlCover.ts` |
| `dlna-renderer` | renderer | renderer | `services/plugin/renderers/dlna.ts` |
| `qq-playlist-importer` | importer | playlistImport | `services/plugin/importers/qq.ts` |
| `netease-playlist-importer` | importer | playlistImport | `services/plugin/importers/netease.ts` |
| `musicflow-file-importer` | importer | playlistFile | `services/plugin/importers/native.ts` |
| `daily-recommend` | recommender | dailyPlaylist | `services/plugin/dailyRecommend.ts` |
| `local-recommend` | recommender | localPlaylist | `services/plugin/localRecommend.ts` |
| `playlist-sync` | sync | playlistSync | `services/plugin/playlistSync.ts` |

想写新的歌词源 / 封面源 / 投屏适配器 / 播放上报器，照着上面同类型插件的 `impl` 实现即可。

---

## 10. 完整示例

### 10.1 歌词提供方（lyricProvider）

```js
export const manifest = {
  id: "demo-lyrics",
  name: "示例歌词源",
  version: "1.0.0",
  type: "lyrics",
  capabilities: ["lyricProvider"],
  permissions: ["net", "storage"],          // 需要联网 + 缓存
  defaultEnabled: false,
  minAppVersion: "1.1.0",
  configSchema: [{ key: "apiKey", label: "API Key", type: "text", required: false }],
};

export const impl = {
  async searchLyrics(host, song) {
    const cacheKey = "lyric:" + (song.title || "") + ":" + (song.artist || "");
    const hit = await host.storage.get(cacheKey);
    if (hit) return { text: hit };
    const res = await host.http("https://api.example.com/lyric?t=" + encodeURIComponent(song.title || ""));
    const data = await res.json();
    if (!data?.text) return null;            // 返回 null → 下一个 provider 接手
    await host.storage.set(cacheKey, data.text);
    return { text: data.text };
  },
};
```

### 10.2 播放上报（scrobbler）

```js
export const manifest = {
  id: "demo-scrobbler",
  name: "示例播放上报",
  version: "1.0.0",
  type: "scrobbler",
  capabilities: ["scrobbler"],
  permissions: ["net"],
  defaultEnabled: false,
  configSchema: [{ key: "token", label: "Token", type: "text" }],
};

export const impl = {
  async onScrobble(host, event) {
    await host.http("https://api.example.com/scrobble", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  },
};
```

---

## 11. 健康追踪（运维可见性）

每个插件的核心调用（歌词 / 封面 / 渲染器 / 上报）都会记录成功 / 失败。连续失败次数决定状态：

- `0` → `green`（正常）
- `1–2` → `yellow`（波动）
- `≥3` → `red`（异常）

状态在「已安装」标签页的「健康」列实时显示；也可通过 `GET /rest/api/v1/plugins/health` 取全量。异常的插件仍会被尝试调用（用户可能已修复配置），但状态会提示管理员关注。

---

## 12. 常见问题

- **插件没出现？** 看启动日志里的 `[PLUGIN]` 行；被跳过会写明原因（缺 index.js / manifest 非法 / 版本不符 / id 冲突 / 权限非法）。
- **改了插件要生效吗？** 不需要重启——`data/plugins` 变更会被热重载（重新发现 + 重注册 + 重建 `plugins` 行）。若热重载未触发，重启后端同样有效。
- **能覆盖内置插件吗？** 不能。同名 id 时内置/先注册者优先，外置的会被跳过。
- **插件能 import 后端内部模块吗？** 不建议，且 in-process 下不构成隔离。只依赖 `host.*` 上下文与 Node 内置模块 / 自身依赖。
- **TypeScript 写的插件？** 先编译成 ESM 的 `.js` 再放进去；后端按 `.js` 动态 `import`。
- **外部插件安全吗？** in-process 无沙箱，「权限模型」只是契约级——仅从你信赖的注册表安装，UI 市场页有风险提示。
- **插件市场数据哪来？** 后端 `GET /v1/plugins/registry` 合并所有已启用注册表（递归 `includes`、按 id 去重、保留最高版本）；安装即下载归档落盘并热加载。
