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

---

## 2. 一个插件 = 一个 ESM 模块

`index.js` 必须是 ES Module，导出两个顶层常量：

```js
export const manifest = { /* 自描述元数据，核心只读它 */ };
export const impl = { /* 能力对应的具体方法 */ };
```

- `manifest`：告诉核心「我是谁、我会什么、需要什么配置」。
- `impl`：真正干活的函数。核心只会调用你在 `manifest.capabilities` 里声明的能力对应的方法。

---

## 3. Manifest 字段（必填 + 选填）

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 全局唯一，正则 `^[a-zA-Z0-9][a-zA-Z0-9-]*$`。重名会被跳过（已注册的赢）。 |
| `name` | ✅ | 展示名（插件页显示）。 |
| `version` | ✅ | 插件版本，语义化版本串。 |
| `type` | ✅ | `"source" \| "importer" \| "recommender" \| "sync"` 之一。 |
| `capabilities` | ✅ | 非空数组，声明本插件提供的能力（见 §4）。 |
| `configSchema` | ✅ | 数组（可为空 `[]`）。描述插件配置项，自动渲染成插件页表单。 |
| `description` | ⬜ | 描述。 |
| `platforms` | ⬜ | 字符串数组，用于前端提示（如 `["qq"]`）。source/importer 常用。 |
| `recommendPrefix` | ⬜ | source 插件专用：每日推荐歌单 URL 前缀。 |
| `minAppVersion` | ⬜ | 要求的最低 App 版本；低于此版本会被跳过（`dev` 构建不受限）。 |
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

### 4.1 `source` 类型（在线音乐源，如 go-music-dl）
| capability | impl 方法 |
|------|------|
| `search` | `search(config, query)` |
| `recommend` | `recommend(config, channel)` |
| `playlistSongs` | `playlistSongs(config, id)` |
| `stream` | `streamUrl(config, song)` |
| `lyrics` | `lyricUrl(config, song)` |
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

### 4.4 `sync` 类型（歌单同步）
| capability | impl 方法 |
|------|------|
| `playlistSync` | `runSyncJob(): Promise<string \| null>` —— 返回一句话摘要或 null |
| `autoMatch` | （被 `playlistSync` 用作未匹配歌曲的在线匹配源；默认回退到 `search` 能力） |

> 一个插件可以声明多个能力（如一个 source 插件同时有 search/stream/lyrics）。

---

## 5. 安全边界（后端强制）

后端加载外置插件时做了四道防护，**任何一道不过都直接跳过该插件，绝不让启动失败**：

1. **路径白名单**：只能加载 `<data>/plugins/<id>/index.js`，路径穿越（`../`）一律拒绝。
2. **Manifest 校验**：`id` / `type` / `capabilities` / `configSchema` 必须合规，否则跳过。
3. **minAppVersion**：`manifest.minAppVersion` 高于当前 App 版本时跳过（dev 构建放行）。
4. **id 冲突**：与已注册插件（内置或先发现的）重名时，已有者胜出，新者跳过。

---

## 6. 安装与启用流程

```bash
# 1) 复制插件到数据目录（DATA_DIR 或默认的 backend/data）
mkdir -p backend/data/plugins
cp -r examples/plugins/hello-importer backend/data/plugins/

# 2) 重启后端（dev: npm run dev / 生产: node dist/index.js）
#    启动日志里应出现:
#    [PLUGIN] 已加载外置插件 hello-importer (importer, playlistImport)

# 3) 打开「插件」管理页 → 找到 hello-importer → 启用
#    启用后「导入歌单」即可识别该插件声明的链接格式
```

> 外置插件默认 `defaultEnabled: false`，必须手动启用。启用状态、配置都存于 `plugins` 表，重启保留。

---

## 7. 完整示例（摘自我仓库 `examples/plugins/hello-importer/index.js`）

```js
export const manifest = {
  id: "hello-importer",
  name: "示例：Hello 歌单导入",
  version: "1.0.0",
  type: "importer",
  capabilities: ["playlistImport"],
  platforms: ["example"],
  defaultEnabled: false,
  urlPatterns: ["example.com/**playlist**"],
  minAppVersion: "1.0.0",
  configSchema: [{ key: "token", label: "访问令牌", type: "text", required: false }],
};

export const impl = {
  canHandle(url) {
    return /example\.com\/playlist/i.test(url.trim());
  },
  async fetchPlaylist(url) {
    const id = (url.match(/[?&]id=(\w+)/) || [])[1] || "demo";
    return {
      name: `示例歌单 ${id}`,
      platform: "example",
      tracks: [
        { externalId: "1", title: "示例歌曲 A", artist: "示例艺人" },
        { externalId: "2", title: "示例歌曲 B", artist: "示例艺人" },
      ],
    };
  },
};
```

---

## 8. 内置插件清单（可作为参考实现）

| id | type | capabilities | 文件 |
|----|------|--------------|------|
| `go-music-dl` | source | search/recommend/playlistSongs/stream/lyrics/webRotation | `services/source/online/goMusicDl.ts` |
| `qq-playlist-importer` | importer | playlistImport | `services/plugin/importers/qq.ts` |
| `netease-playlist-importer` | importer | playlistImport | `services/plugin/importers/netease.ts` |
| `musicflow-file-importer` | importer | playlistFile | `services/plugin/importers/native.ts` |
| `daily-recommend` | recommender | dailyPlaylist | `services/plugin/dailyRecommend.ts` |
| `playlist-sync` | sync | playlistSync | `services/plugin/playlistSync.ts` |

想写新的导入源 / 推荐策略 / 同步策略，照着上面同类型插件的 `impl` 实现即可。

---

## 9. 常见问题

- **插件没出现？** 看启动日志里的 `[PLUGIN]` 行；被跳过会写明原因（缺 index.js / manifest 非法 / 版本不符 / id 冲突）。
- **改了插件要生效吗？** 需要重启后端（外置插件在启动时一次性加载，运行时不热重载）。
- **能覆盖内置插件吗？** 不能。同名 id 时内置/先注册者优先，外置的会被跳过。
- **插件能 import 后端内部模块吗？** 不建议。`data/plugins` 下的文件无法解析 `backend/src` 的内部路径；只依赖 Node 内置模块与自身依赖。
- **TypeScript 写的插件？** 先编译成 ESM 的 `.js` 再放进去；后端按 `.js` 动态 `import`。
