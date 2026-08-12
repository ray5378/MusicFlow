# MusicFlow-V2 外置插件开发指南（PLUGIN_DEV）

> 适用版本：MusicFlow-V2 **v1.4.0+**（QuickJS 沙箱运行时，host.* 能力全量开放）
> 目标：教你自己写一个 drop-in 插件，丢进 `data/plugins/<id>/` 即可被后端加载，**无需改任何核心代码**。

---

## 1. 插件放在哪

后端启动时（`initDatabase()` 之后）会扫描：

```
<data>/plugins/<your-plugin-id>/index.js
（可选：<data>/plugins/<your-plugin-id>/plugin.json —— 市场/校验用的 manifest 副本）
```

`<data>` 的位置由环境变量决定：

- 默认：`backend/data/`（即项目 backend 目录下的 `data/`）
- 或 `DATA_DIR` 环境变量指定的任意目录：`$DATA_DIR/plugins/<id>/index.js`

> 仓库里 `examples/plugins/hello-importer/index.js` 是一个可复制的参考实现。**它不在 `data/plugins` 下，所以不会被自动加载**——请把它整体复制到 `data/plugins/` 再启用。

**热重载**：修改 `data/plugins/<id>/` 下的文件后，后端会自动重新发现该插件——旧的 QuickJS 沙箱被释放、新代码重新加载，无需重启（见 §10）。

---

## 2. 插件 = 运行在 QuickJS 沙箱里的纯 JS

外置插件**不再**是 ES Module。它在独立的 QuickJS 虚拟机（WASM）里运行，只能拿到标准 JS（外加沙箱注入的 `URL` / `URLSearchParams` / `btoa` / `atob` 兼容层）。插件文件必须定义全局对象：

```js
globalThis.__mfPlugin = {
  manifest: { /* 自描述元数据 */ },
  create(host) { /* 返回 impl 对象 */ },
};
```

- `manifest`：告诉核心「我是谁、我会什么、需要什么配置、要什么权限」。
- `create(host)`：核心注入受控上下文 `host`（见 §5），插件用它闭包构造 `impl`——真正干活的函数集合。

**插件拿不到 Node 的任何能力**：没有 `import`/`require`/`fetch`/`fs`/`process`。网络只能走 `host.http` / `host.net` / `host.ws`（均自带超时与权限点），存储走 `host.storage`，文件走 `host.fs`（限插件目录），日志走 `host.log`。`permissions` 在宿主函数调用点强制执行——不再只是契约，是真实的运行时边界。

---

## 3. Manifest 字段（必填 + 选填）

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 全局唯一，正则 `^[a-zA-Z0-9][a-zA-Z0-9-]*$`，且必须与目录名一致。 |
| `name` | ✅ | 展示名（插件页显示）。 |
| `version` | ✅ | 插件版本，语义化版本串。**必须与 plugin.json 的 version 一致**，否则拒绝加载。 |
| `type` | ✅ | `"source" \| "importer" \| "recommender" \| "sync" \| "lyrics" \| "cover" \| "renderer" \| "scrobbler"` 之一。 |
| `capabilities` | ✅ | 非空数组，声明本插件提供的能力（见 §4）。 |
| `configSchema` | ✅ | 数组（可为空 `[]`）。描述插件配置项，自动渲染成插件页表单。 |
| `description` | ⬜ | 描述。 |
| `permissions` | ⬜ | 字符串数组，声明本插件需要的权限（见 §5）。不声明则无受控能力可用。 |
| `platforms` | ⬜ | 字符串数组，用于前端提示（如 `["qq"]`）。 |
| `recommendPrefix` | ⬜ | source 插件专用：每日推荐歌单 URL 前缀。 |
| `minAppVersion` | ⬜ | 要求的最低 App 版本；低于此版本会被跳过（沙箱运行时自 **1.3.0** 起）。 |
| `documentation` | ⬜ | **Markdown 字符串**，插件详情页的「功能介绍 + 处理逻辑」说明（用户点「详情」看到的内容）。建议每个插件都写：功能一句话 + 处理逻辑（数据来源 / 触发时机 / 边界）。未提供时前端按能力自动生成通用说明。 |
| `author` / `homepage` / `icon` / `license` / `updateUrl` | ⬜ | 元数据，市场页展示。 |
| `defaultEnabled` | ⬜ | 外置插件默认 `false`（用户手动开启）。 |

> 发布到官方市场的插件，`plugin.json` 与 `index.js` 里的 manifest **必须逐字段一致**（`check.mjs` 会校验 id/version/capabilities）。

### 3.1 `configSchema` 字段结构

```js
{ key: "token", label: "访问令牌", type: "text", required: false, default: "", help: "可选" }
```

`type` 可选：`"text" | "url" | "number" | "select" | "multiselect" | "radio" | "switch"`。
`select/multiselect/radio` 需提供 `options: [{ label, value }]`。

---

## 4. 能力（capabilities）与 `impl` 方法对照

核心按 `manifest.capabilities` 找到启用插件后，调用 `impl` 上对应的方法。**只调用你声明的能力对应的方法**。

> 方法签名注意：`lyricProvider` / `coverProvider` / `scrobbler` 的方法，核心以 `(host, …)` 调用，但沙箱门面会**剥掉 host**——插件方法里直接用 `create(host)` 闭包捕获的 `host`（始终实时）。source 系方法则照常收到 `(config, …)`。

### 4.1 `source` 类型（在线音乐源）
| capability | impl 方法 |
|------|------|
| `search` | `search(config, params)` → `{ songs: OnlineSongResult[] }` |
| `recommend` | `recommend(config)` → `{ channels: [...] }` |
| `playlistSongs` | `playlistSongs(config, source, id)` → `{ songs, name }` |
| `stream` | `streamUrl(config, song, range?)` → string（**纯同步**，不发起网络） |
| `lyrics` | `lyricUrl(config, song)` → string \| null（**纯同步**，建议用 `lyricProvider` 替代） |
| `webRotation` | （由核心的 purge 逻辑触发，无需方法） |

`OnlineSongResult` = `{ id, source, name, artist, album, duration, cover, extra? }`（`name` 不是 `title`）。

### 4.2 `importer` 类型（歌单导入）
| capability | impl 方法 |
|------|------|
| `playlistImport` | `canHandle(url): boolean`（同步）+ `fetchPlaylist(url): Promise<ImportedPlaylistShape>` |
| `playlistFile` | `canHandleFile(raw): boolean`（同步）+ `parseFile(raw): Promise<ImportedPlaylistShape[]>` |

`ImportedPlaylistShape` = `{ name, platform, coverUrl?, tracks: ImportedTrackShape[] }`

### 4.3 `recommender` 类型（每日推荐）
| capability | impl 方法 |
|------|------|
| `dailyPlaylist` | `runDailyJob(): Promise<string \| null>` |
| `localPlaylist` | `runDailyJob(): Promise<string \| null>` |

### 4.4 `sync` 类型（歌单同步）
| capability | impl 方法 |
|------|------|
| `playlistSync` | `runSyncJob(): Promise<string \| null>` |
| `autoMatch` | （复用 `search` 方法作在线匹配源） |

### 4.5 `lyricProvider`（歌词提供方）
| capability | impl 方法 |
|------|------|
| `lyricProvider` | `searchLyrics(song): Promise<{ lrc?, text? } \| null>` |

first-match-wins（首个返回非空结果的胜出；抛错被记入健康追踪后跳过）。

### 4.6 `coverProvider`（封面提供方）
| capability | impl 方法 |
|------|------|
| `coverProvider` | `searchCover(song): Promise<{ url? } \| null>` |

### 4.7 `renderer`（设备投屏）
| capability | impl 方法 |
|------|------|
| `renderer` | `discover(): Promise<RendererDevice[]>` + `cast(deviceId, songId)` + 可选 `control(...)` |

### 4.8 `scrobbler`（播放上报）
| capability | impl 方法 |
|------|------|
| `scrobbler` | 可选 `onPlay(event)` + 可选 `onScrobble(event)` |

`ScrobbleEvent` = `{ songId, title, artist, album?, duration?, playedAt }`。回调抛错会记入健康面板。

---

## 5. 受控上下文 `host.*`（沙箱桥接）

插件运行在 QuickJS VM 里，`host` 是它触达宿主的**唯一**通道。权限在宿主函数的调用点检查——无权限时直接返回 `{ ok:false, error:"PERMISSION_DENIED: <perm>" }`，不会执行。

```js
globalThis.__mfPlugin = {
  manifest: { /* ... */ },
  create(host) {
    return {
      async searchLyrics(song) {
        host.log("looking up", song.title);
        const cached = await host.storage.get("lyric:" + song.title);   // storage 权限
        if (cached) return { text: cached };
        const res = await host.http("https://api.example.com/lyric?t=" + encodeURIComponent(song.title)); // net 权限
        if (!res.ok) return null;
        return { text: res.body };   // res.body 是文本
      },
    };
  },
};
```

| 成员 | 说明 | 所需权限 |
|------|------|----------|
| `host.config` | 本插件当前配置（**每次调用前刷新**，调用时实时读取） | — |
| `host.version` | 运行中的 App 版本 | — |
| `host.log(...args)` | 带插件前缀的日志 | `log`（默认允许） |
| `host.storage` | 插件级 JSON KV（`get/set/delete/keys`，异步） | `storage` |
| `host.http(input, init)` | fetch 封装：`init` 可带 `{ method, headers, body, timeout }`；返回 `{ ok, status, headers, body(text) }` | `net` |
| `host.comm` | 插件间通信（`send/broadcast/on`） | `inter-plugin` |
| `host.songs` | 宿主曲库**只读查询**（`list({limit,offset})` / `search(query,{limit})` / `getById(id)`），返回脱敏歌曲视图 `{ id, title, artist, album, duration, coverArt, playCount, genre, track, type }`（不含内部路径字段） | `songs:read` |
| `host.plugin` | 宿主身份/地址信息（`getHostUrl()` 返回 `DLNA_BASE_URL` 配置值、`getNetworkAddresses()` 返回本机 IPv4 列表） | —（只读低敏） |
| `host.fs` | 插件**专属目录** `<data>/plugins/<id>/files/` 内文件读写：`readFile/writeFile/appendFile/readdir/unlink/exists/mkdir/stat/rename`（**路径穿越拒绝**，任何越界路径直接抛错） | `fs` |
| `host.command` | 执行外部命令：`exec(program, args, {timeout})`（走 `execFile` 不经 shell，默认超时 30s）、`start(name, program, args)` / `stop(name)` / `isRunning(name)` 管理常驻进程 | `command` |
| `host.net` | 原始网络 socket：`udpBind({port,address,reuseAddr})` / `udpSend(id, data, {address,port})` / `udpClose` / `onData(id, handler)`；`tcpConnect(host, port, {timeout})` 返回 `{ send, onData, onClose, close }`。数据以 **base64** 传输（沙箱提供 `btoa/atob`），事件经回调推回 VM | `net` |
| `host.ws` | WebSocket 客户端：`connect(url, {headers, protocols, timeout})` 返回 `{ send, onMessage, onClose, close }`（文本直传、二进制 base64） | `websocket` |
| `host.jsenv` | 嵌套 QuickJS 子环境跑隔离脚本：`create(name, initCode)` / `execute(name, code)` / `destroy(name)`——子环境只有标准 JS，**没有 host.***，无法触达宿主 | `jsenv` |

### 5.1 权限白名单 `KNOWN_PERMISSIONS`

manifest 的 `permissions` 只能是白名单中的值，支持命名空间通配（`songs.*`）与全局 `*`。

```
log  storage  net  command  fs  fs:music  fs:external
websocket  jsenv
songs:read  songs:write  playlists:read  playlists:write  inter-plugin
```

> **已桥接的权限**：`log` / `storage` / `net`（`host.http` + `host.net` socket）/ `inter-plugin`（`host.comm`）/ `songs:read`（`host.songs`）/ `fs`（`host.fs` 插件目录内）/ `command`（`host.command`）/ `websocket`（`host.ws`）/ `jsenv`（`host.jsenv`）。
> **挂名未桥接**（白名单校验放行，但沙箱里没有对应宿主函数——刻意保留为未来扩展位）：`fs:music`、`fs:external`、`songs:write`、`playlists:*`。外置插件无法改宿主曲库、无法读写宿主音乐库文件；`host.fs` 被限定在插件自己的 `files/` 目录。

---

## 6. 插件间通信 `host.comm`

```js
host.comm.on((msg) => { /* 收到消息 */ });
host.comm.send("other-plugin-id", { type: "hello", payload: 1 });
host.comm.broadcast({ type: "tick" });
```

---

## 7. 安全边界（后端强制 + 沙箱隔离）

加载外置插件时：

1. **QuickJS 沙箱**：代码在独立 VM 里运行，拿不到 Node 能力；内存上限 256MB、栈上限 1MB、单次调用超时 15s、中断处理器可切断死循环。
2. **路径白名单**：只能加载 `<data>/plugins/<id>/index.js`，路径穿越拒绝。
3. **Manifest 校验**：id / type / capabilities / configSchema 必须合规；`index.js` 与 `plugin.json` 不一致拒绝加载。
4. **权限执行点**：`host.http` 无 `net` 权限直接拒绝，不发起请求。
5. **minAppVersion**：低于要求版本跳过。
6. **id 冲突**：内置插件不可被外置遮蔽。
7. **高风险能力的硬限制**（v1.4.0+，均经权限执行点 + 运行期限制）：
   - `host.fs` 只能读写插件自己的 `<data>/plugins/<id>/files/`，**路径穿越（`../`、绝对路径）在宿主侧直接抛错**；
   - `host.command.exec` 走 `execFile`（**不经 shell**，参数不可拼接注入），默认 30s 超时、16MB 输出上限；`start` 管理的常驻进程随 `stop`/退出回收；
   - `host.net` / `host.ws` 与 `host.http` 同级（需 `net` / `websocket` 权限），socket 有连接超时；
   - `host.jsenv` 子环境**只有标准 JS，没有 `host.*`**——嵌套脚本无法触达宿主。

---

## 8. 安装与启用流程

**方式 A：拖入目录（开发 / 自托管）**

```bash
mkdir -p backend/data/plugins
cp -r my-plugin backend/data/plugins/
```

启动日志应出现 `[PLUGIN] 已加载外置插件 my-plugin (…) [沙箱]`。打开「插件」管理页启用即可。
插件首次使用 `host.fs` 时，宿主会自动创建它的专属目录 `<data>/plugins/<id>/files/`。

**方式 B：插件市场（推荐给普通用户）**

管理员「插件」页 →「插件市场」→「安装」，归档自动解压到 `data/plugins/<id>/` 并热加载。

> 外置插件默认 `defaultEnabled: false`，必须手动启用。

---

## 9. 官方外置插件（参考实现）

| id | 版本 | type | capabilities | 说明 |
|----|------|------|--------------|------|
| `go-music-dl` | 1.2.0 | source | search/recommend/playlistSongs/stream/webRotation/lyricProvider/coverProvider | 全网聚合（源+歌词+封面三合一） |
| `listenbrainz` | 1.1.0 | scrobbler | scrobbler | ListenBrainz 播放上报 |

源码在 [ray5378/MusicFlow-plugins](https://github.com/ray5378/MusicFlow-plugins)，发布前跑 `node scripts/check.mjs <id>`。

---

## 10. 完整示例

### 10.1 歌词提供方（lyricProvider）

```js
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-lyrics",
    name: "示例歌词源",
    version: "1.0.0",
    type: "lyrics",
    capabilities: ["lyricProvider"],
    permissions: ["net", "storage"],
    defaultEnabled: false,
    minAppVersion: "1.3.0",
    configSchema: [{ key: "apiKey", label: "API Key", type: "text" }],
  },
  create(host) {
    return {
      async searchLyrics(song) {
        const cacheKey = "lyric:" + (song.title || "") + ":" + (song.artist || "");
        const hit = await host.storage.get(cacheKey);
        if (hit) return { text: hit };
        const res = await host.http(
          "https://api.example.com/lyric?t=" + encodeURIComponent(song.title || ""),
          { timeout: 8000 },
        );
        if (!res.ok) return null;
        try {
          const data = JSON.parse(res.body);
          if (!data || !data.text) return null;
          await host.storage.set(cacheKey, data.text);
          return { text: data.text };
        } catch { return null; }
      },
    };
  },
};
```

### 10.2 播放上报（scrobbler）

```js
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-scrobbler",
    name: "示例播放上报",
    version: "1.0.0",
    type: "scrobbler",
    capabilities: ["scrobbler"],
    permissions: ["net"],
    defaultEnabled: false,
    configSchema: [{ key: "token", label: "Token", type: "text" }],
  },
  create(host) {
    const token = () => (host.config && host.config.token) || "";
    return {
      async onScrobble(event) {
        if (!token()) throw new Error("未配置 token");
        const r = await host.http("https://api.example.com/scrobble", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
          timeout: 10000,
        });
        if (!r.ok) throw new Error("上报失败: HTTP " + r.status);
      },
    };
  },
};
```

### 10.3 读宿主曲库（host.songs，需 `songs:read`）

```js
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-library",
    name: "示例曲库统计",
    version: "1.0.0",
    type: "lyrics",
    capabilities: ["lyricProvider"],
    permissions: ["songs:read"],
    defaultEnabled: false,
    minAppVersion: "1.3.0",
    configSchema: [],
  },
  create(host) {
    return {
      // 示例：给歌曲补充「同名曲目数」作为歌词缓存键的一部分
      async searchLyrics(song) {
        const hit = await host.songs.getById(song.songId || "");
        if (!hit) return null;
        const sameTitle = await host.songs.search(hit.title, { limit: 20 });
        return { text: `[${hit.title}] 曲库共 ${sameTitle.length} 首同名/相关曲目` };
      },
    };
  },
};
```

> `host.songs.search("周杰伦")` 会模糊匹配 `title / artist / album`；`list({ limit, offset })` 支持分页（limit 上限 500）。返回的歌曲是**脱敏视图**——拿不到 `path` / `streamHeaders` / `sourceData` 等内部字段。

### 10.4 高风险能力（host.fs + host.command，需 `fs` + `command` 权限）

```js
globalThis.__mfPlugin = {
  manifest: {
    id: "demo-fs-cmd",
    name: "示例文件+命令",
    version: "1.0.0",
    type: "lyrics",
    capabilities: ["lyricProvider"],
    permissions: ["fs", "command"],
    defaultEnabled: false,
    minAppVersion: "1.4.0",
    configSchema: [],
  },
  create(host) {
    return {
      async searchLyrics(song) {
        // fs: 只能读写 <data>/plugins/demo-fs-cmd/files/ 内的文件(穿越直接抛错)
        const report = "files/report.txt";
        await host.fs.mkdir("files", { recursive: true });
        await host.fs.writeFile(report, `title=${song.title}\ntime=${Date.now()}`);
        // command: execFile 执行,不经 shell,默认 30s 超时
        const r = await host.command.exec("node", ["-e", "console.log('ok')"], { timeout: 5000 });
        return { text: `wrote=${r.code === 0} stdout=${r.stdout.trim()}` };
      },
    };
  },
};
```

> ⚠️ `command` / `fs` / `net` / `websocket` / `jsenv` 是**高风险权限**：只给可信插件声明。`host.command` 等于把该插件的代码当作可执行程序信任——虽然沙箱隔离了代码本身，但**通过 `command` 跑出的进程是宿主级的**。安装第三方插件前请确认其来源与 `plugin.json` 声明的权限。

---

## 11. 健康追踪

每个插件的核心调用都会记录成功/失败：0 失败 → green，1–2 → yellow，≥3 → red。状态在「插件」页「健康」列实时显示。

---

## 12. 常见问题

- **插件没出现？** 看启动日志里的 `[PLUGIN]` 行；被跳过会写明原因。
- **改了插件要生效吗？** 不需要重启——`data/plugins` 变更触发热重载（释放旧沙箱、加载新代码）。
- **能覆盖内置插件吗？** 不能。内置/先注册者优先。
- **插件能 import 或使用 Node API 吗？** 不能。沙箱里只有标准 JS + `host.*`；Node 的 `fetch`、`require`、`fs`、`process` 等一律不存在。文件操作走 `host.fs`（限插件 `files/` 目录），网络走 `host.http` / `host.net` / `host.ws`。
- **网络超时怎么办？** `host.http(url, { timeout: 8000 })` —— 不需要 AbortController。
- **URL / URLSearchParams 有吗？** 沙箱注入了兼容层，与浏览器行为一致；另有 `btoa/atob`（`host.net` 数据通道用）。
- **TypeScript 写的插件？** 先编译成纯 JS（无 ESM export）再放进去。
- **外部插件安全吗？** 代码运行在 QuickJS 沙箱（内存/栈/超时受限、权限执行点强制、无 Node 能力）；但 `fs` / `command` / `net` / `websocket` / `jsenv` 是**高风险权限**——尤其 `command` 跑出的进程是宿主级的，只对可信插件开放。安装前请确认插件来源与其 `plugin.json` 声明的权限。
