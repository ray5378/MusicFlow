# MusicFlow-V2

自托管音乐库播放器（OpenSubsonic 兼容），**插件化重构版**。后端 Hono + SQLite（better-sqlite3），前端 Vue 3 + Element Plus。在线音乐源、歌单导入、每日推荐、歌单同步、歌词/封面、DLNA 渲染、播放上报等均以插件形式接入，核心只按能力遍历，不再耦合具体实现。

> **北向目标**：V2 完整实现 MusicFlow 的功能与逻辑，只是解耦成插件版——是 HA 主链路（加载项 + 集成 + 卡片）的新内核。

## 当前稳定版本配套（推荐组合）

> 以下组件需**配套使用**，版本号对齐才能正常工作。服务端升级后，请在 HACS 同步更新集成与卡片到对应版本。

| 组件 | 版本 | 仓库 |
|---|---|---|
| 服务端（本仓库） | **v1.2.0** | [ray5378/MusicFlow-V2](https://github.com/ray5378/MusicFlow-V2) |
| HA 加载项 [hassio-addons](https://github.com/ray5378/hassio-addons) | **1.2.0**（镜像 musicflow-v2:1.2.0） | [ray5378/hassio-addons](https://github.com/ray5378/hassio-addons) |
| HA 集成 [hass-musicflow](https://github.com/ray5378/hass-musicflow) | **v1.3.7** | [ray5378/hass-musicflow](https://github.com/ray5378/hass-musicflow) |
| HA 卡片 [hass-musicflow-card](https://github.com/ray5378/hass-musicflow-card) | **v1.6.51** | [ray5378/hass-musicflow-card](https://github.com/ray5378/hass-musicflow-card) |

各仓库的发版（GitHub Release）说明与镜像构建见各自仓库。

## 镜像

打 `v*` tag 时 CI 自动构建到（仅 **linux/amd64**）：

- `ghcr.io/ray5378/musicflow-v2:<版本>`（如 `:1.2.0`）
- `ghcr.io/ray5378/musicflow-v2:latest`

> **架构说明**：当前镜像仅提供 **linux/amd64**（x86_64）。arm64 / ARM 设备（如部分 ARM 架构 NAS）暂时无法运行，后续视 GitHub ARM runner 可用性再补多架构（账号暂无 ARM runner，与 V1 一致）。

## 插件化架构

- **统一插件框架**：source / importer / recommender / sync / lyricProvider / coverProvider / renderer（DLNA）/ scrobbler 八类插件，能力由 `manifest.capabilities` 声明，核心按能力遍历分发（`docs/PLUGIN_ARCHITECTURE.md`）。
- **外置插件**：`data/plugins/<id>/` 热加载、`host.*` 受控上下文 + 权限白名单、健康追踪、热重载。
- **插件市场**：官方注册表 `https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/registry.json` 在首次启动**自动添加**（可用 `MUSICFLOW_OFFICIAL_REGISTRY` 环境变量覆盖/置空禁用）；Web UI「插件」页的市场 = **项目能力清单**——官方内置插件（标注「内置 · 已安装」，可直接启停/配置）与注册表插件（一键安装）同屏展示。每个插件点「详情」都有**功能介绍 + 处理逻辑**说明页（manifest 的 `documentation` 字段，Markdown；未提供时按能力自动生成说明）。
- **官方插件仓库**：[ray5378/MusicFlow-plugins](https://github.com/ray5378/MusicFlow-plugins)（go-music-dl 在线源、ListenBrainz scrobbler 等，tar 经 GitHub Release 资产分发）。

## OpenSubsonic 服务端

兼容 Subsonic API **v1.16.1** + OpenSubsonic 扩展，第三方客户端（Symfonik / DSub / MA / libopensonic）可直接连接：

- 46+ 端点：浏览（getMusicFolders/getIndexes/getArtists/getAlbumList2）、搜索（search2/search3）、播放（stream/download）、歌单（getPlaylists/getPlaylist/createPlaylist/updatePlaylist/deletePlaylist）、收藏（star/unstar/getStarred2）、评分（setRating + userRating 回填）、歌词（getLyrics/getLyricsBySongId）、上报（scrobble/playbackReport）、播放队列（getPlayQueue/savePlayQueue）、头像（getAvatar）等；
- 认证支持 OpenSubsonic `u/t/s` 令牌、`u/p` 明文、Bearer（JWT/API Key）、`?token=`；
- 失败响应为标准 `status:"failed"` + 错误码，`serverVersion` 反映真实版本；
- 全部端点带 `.view` 后缀与 POST 变体（兼容 MA/libopensonic 表单提交）。

## 部署（docker compose）

```bash
mkdir musicflow-v2 && cd musicflow-v2
curl -o docker-compose.yaml https://raw.githubusercontent.com/ray5378/MusicFlow-V2/master/docker-compose.yml
docker compose up -d    # 自动拉取 ghcr.io/ray5378/musicflow-v2
```

访问 `http://<机器IP>:46400`。首次启动自动创建管理员 `admin / admin`（登录后强制改密）。

### 直接 docker run

```bash
docker run -d --name musicflow --restart unless-stopped \
  -p 46400:46400 \
  -v $(pwd)/data:/app/backend/data \
  ghcr.io/ray5378/musicflow-v2:1.2.0
```

> DLNA 发现依赖 SSDP 多播，`docker compose` 默认 `network_mode: host`；Docker Desktop（macOS/Windows）上多播不可用，DLNA 需在 Linux 宿主机运行。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `JWT_SECRET` | 否 | 自动生成 | JWT 签名密钥。留空则首次启动自动生成并保存到数据目录 `.jwt-secret` |
| `CORS_ORIGINS` | 否 | `*` | 允许的跨域来源（逗号分隔）。HA 卡片直连模式需要把 HA 前端来源加入此处（或保持 `*`） |
| `PLAY_HISTORY_RETENTION_DAYS` | 否 | `3` | 播放历史保留天数 |
| `DLNA_BASE_URL` | 否 | 自动探测 | DLNA 渲染器回拉音频流的基地址，多网卡/反代场景需手填 |
| `DATA_DIR` | 否 | `./data` | 数据目录（SQLite + 封面缓存 + 密钥 + 外置插件） |
| `MUSICFLOW_OFFICIAL_REGISTRY` | 否 | 官方 URL | 插件注册表地址；置空串禁用自动种子（内网/离线） |

## Home Assistant 接入

MusicFlow 提供三个配套仓库，构成完整的 Home Assistant 生态（**版本需与上方「稳定版本配套」对齐**）：

| 仓库 | 类型 | 作用 |
|---|---|---|
| [hassio-addons](https://github.com/ray5378/hassio-addons) | HA 加载项 | 把 V2 服务端直接跑在 Supervisor 下（数据落在 `/share/musicflow`，升级不丢） |
| [hass-musicflow](https://github.com/ray5378/hass-musicflow) | HACS 自定义集成 | 把 DLNA 设备与播放组变成 `media_player` 实体，接入 HA 全局「媒体」标签页，并作为卡片的代理中转 |
| [hass-musicflow-card](https://github.com/ray5378/hass-musicflow-card) | HACS 前端卡片 | 复刻 HA 官方 `media-control` 卡片样式，叠加 MusicFlow 能力（切换播放器 / 喜欢 / 加歌单 / 滚动歌词 / 媒体库） |

### 通信链路

集成通过下面三条链路与本服务通信，不需要额外端口：

- `GET/POST /rest/api/v1/...` —— peer 列表、播放状态、队列与播放控制（内部 REST 别名）
- `GET /rest/...` —— OpenSubsonic 曲库浏览、封面与流（`/rest/getCoverArt`、`/rest/stream`）
- `WS /ws` —— 播放状态实时推送（`?token=` 认证）

服务端通过 mDNS 广播 `_musicflow._tcp.local.`，HA 侧可自动发现，无需手填地址。

### 鉴权

集成使用 API Key 鉴权（登录 Token 24h 过期，不适合常驻客户端）。
在 **设置 → API Key** 生成后填入 HA 即可，可随时重新生成或撤销。

## 发版流程

1. V2 打 `v*` tag → CI 构建推 `ghcr.io/ray5378/musicflow-v2:<版本>` + `:latest`（仅 amd64）；
2. addon 仓库同步 `musicflow/build.yaml` 的 build_from 与 `config.yaml` 的 version；
3. 集成 / 卡片按需发版（HACS 要求建 GitHub Release）。

## 本地开发

```bash
cd backend && npm run dev      # API :46400
cd frontend && npm run dev     # UI :46399 (代理 /rest /api 到后端)
```

后端测试：`cd backend && npx vitest run`（全量 185 用例，含 OpenSubsonic 路由级测试）。
