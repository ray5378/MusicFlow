# MusicFlow-V2

自托管音乐库播放器（OpenSubsonic 兼容），**插件化重构版**。后端 Hono + SQLite（better-sqlite3），前端 Vue 3 + Element Plus。在线音乐源、歌单导入、每日推荐、歌单同步、歌词/封面、DLNA 渲染、播放上报等均以插件形式接入，核心只按能力遍历，不再耦合具体实现。

> **北向目标**：V2 完整实现 MusicFlow 的功能与逻辑，只是解耦成插件版——是 HA 主链路（加载项 + 集成 + 卡片）的新内核。

## 镜像

打 `v*` tag 时 CI 自动构建到（仅 **linux/amd64**）：

- `ghcr.io/ray5378/musicflow-v2:<版本>`（如 `:1.7.7`）
- `ghcr.io/ray5378/musicflow-v2:latest`

> **架构说明**：当前镜像仅提供 **linux/amd64**（x86_64）。arm64 / ARM 设备（如部分 ARM 架构 NAS）暂时无法运行，后续视 GitHub ARM runner 可用性再补多架构（账号暂无 ARM runner，与 V1 一致）。

## 插件化架构

- **统一插件框架**：source / importer / recommender / sync / lyricProvider / coverProvider / renderer（DLNA）/ scrobbler / artist 九类插件，能力由 `manifest.capabilities` 声明，核心按能力遍历分发（`docs/PLUGIN_ARCHITECTURE.md`）。
- **外置插件沙箱（v1.3.0+，host.\* 全量 v1.4.0+）**：外置插件运行在 **QuickJS 虚拟机**（WASM）里——拿不到 Node 能力，网络只能走 `host.http` / `host.net` / `host.ws`（权限执行点强制、自带超时）、存储走 `host.storage`（按插件隔离）、文件走 `host.fs`（限插件 `files/` 目录、防穿越）、命令走 `host.command`（execFile 不经 shell）、可嵌套 `host.jsenv` 子环境（无 host）；单插件内存 256MB / 栈 1MB / 调用超时 15s，卡死可杀、崩溃不拖垮主进程。`docs/PLUGIN_DEV.md` 有完整开发指南。
- **插件市场**：官方注册表 `https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/registry.json` 在首次启动**自动添加**（可用 `MUSICFLOW_OFFICIAL_REGISTRY` 环境变量覆盖/置空禁用）；Web UI「插件」页的市场 = **项目能力清单**——官方内置插件（标注「内置 · 已安装」，可直接启停/配置）与注册表插件（一键安装）同屏展示。每个插件点「详情」都有**功能介绍 + 处理逻辑**说明页（manifest 的 `documentation` 字段，Markdown；未提供时按能力自动生成说明）。
- **官方插件仓库**：[ray5378/MusicFlow-plugins](https://github.com/ray5378/MusicFlow-plugins)（go-music-dl 在线源、ListenBrainz scrobbler 等，tar 经 GitHub Release 资产分发）。写插件看 `docs/PLUGIN_DEV.md`；发布流程（打包/Release/登记）见该仓库 README。
- **功能全插件化（v1.5.0+）**：核心对「平台 / 内置插件实现」**零耦合**（`check-core` CI 强制，新增越界零容忍）；内置插件 **8 个**（新增 `artist-info` 歌手资料：新类型 `artist` + 能力 `artistInfo`）；每日推荐榜单种子 / 歌单同步 / 歌手抓取等全部经插件门面（`services/pluginAccess.ts`）访问，平台展示名 / 流兜底偏好由插件 manifest 声明。

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

完整 `docker-compose.yml` 示例（中文注释，也可直接 `curl` 上方命令拉取仓库原文件）：

```yaml
services:
  musicflow:
    image: ghcr.io/ray5378/musicflow-v2:1.7.4
    container_name: musicflow
    restart: unless-stopped
    # 注意:DLNA 发现依赖 SSDP 多播,必须使用 host 网络模式。
    # host 网络仅 Linux 支持;Docker Desktop(macOS/Windows)上多播不可用,DLNA 需原生运行。
    network_mode: host
    environment:
      # 数据目录:SQLite 主库 + 歌词/封面落库 + 外置插件 + 密钥都在这里。
      # 必须与下方 ./data:/data 卷映射对应,否则数据不会持久化。
      - DATA_DIR=/data
      # 可选:JWT 签名密钥。留空则首次启动自动生成并保存到 <DATA_DIR>/.jwt-secret(重启稳定)。
      - JWT_SECRET=${JWT_SECRET:-}
      - CORS_ORIGINS=${CORS_ORIGINS:-*}
      - PLAY_HISTORY_RETENTION_DAYS=${PLAY_HISTORY_RETENTION_DAYS:-3}
      - TZ=Asia/Shanghai
      - UV_USE_IO_URING=0
      # 可选:覆盖 DLNA 渲染器回拉流地址的基地址(反代/多网卡场景)。
      # - DLNA_BASE_URL=http://192.168.1.100:46400
    volumes:
      # 数据与缓存目录(宿主 ./data 挂到容器 /data),结构见下方「数据与缓存目录」:
      - ./data:/data
      # 可选:把平台/在线封面缓存(online-covers)独立挂到宿主机大磁盘。
      # 默认它在 ./data 卷内,无需配置;想单独存放/单独清缓存时取消注释:
      # - ./online-covers:/data/online-covers
      # 可选:歌词文件(online-lyrics)同理可独立挂载/单独清空:
      # - ./online-lyrics:/data/online-lyrics
```

> **平台音乐封面本地落盘默认开启**：QQ / 网易云等平台的歌曲与歌单封面，下载后会默认保存到 `data/online-covers/`（容器内 `/data/online-covers`），无需任何配置；想把它独立放到其他磁盘（如大容量数据盘），取消 compose 里对应那行卷映射即可。

### 直接 docker run

```bash
docker run -d --name musicflow --restart unless-stopped \
  -p 46400:46400 \
  -e DATA_DIR=/data \
  -v $(pwd)/data:/data \
  ghcr.io/ray5378/musicflow-v2:1.7.4
```

> DLNA 发现依赖 SSDP 多播，`docker compose` 默认 `network_mode: host`；Docker Desktop（macOS/Windows）上多播不可用，DLNA 需在 Linux 宿主机运行。

## 数据与缓存目录

所有持久化数据都在 `DATA_DIR`（默认 `./data`，容器内 `/data`）下，升级 / 迁移只需备份整个目录：

| 路径 | 内容 | 说明 |
|---|---|---|
| `musicflow.db` | SQLite 主库 | 歌曲 / 歌单 / 设置 / 播放历史等全部元数据 |
| `musicflow.db-wal` / `-shm` | SQLite WAL 日志 | 正常随主库一起备份即可 |
| `covers/` | 本地刮削封面 | 本地音乐扫描出的内嵌封面、歌手头像抓取缓存 |
| `online-covers/` | **平台 / 在线封面缓存** | web 歌曲、歌单导入、以及「媒体获取」按需获取(A/B)下载的远程封面；**可单独挂到大磁盘或单独清空**（清空后缺失封面会重新按需获取） |
| `online-lyrics/` | **插件获取并落库的歌词文件** | 「媒体获取」按需获取(A/B)与批量补全(C)写入的歌词（`<歌曲id>.lrc`，列内存文件引用）；**可单独挂载/单独清空**（清空后缺词歌曲会重新获取，不影响 `songs.lyrics` 列旧文本兼容） |
| `plugins/` | 外置插件 | 从插件市场安装的第三方插件（QuickJS 沙箱运行） |
| `.jwt-secret` | JWT 密钥 | 未配置 `JWT_SECRET` 时自动生成，重启保持稳定 |
| `.server-uuid` | mDNS 服务标识 | DLNA 发现用，保证实例身份稳定 |

**歌词/封面落库**：「媒体获取」页的 **B 落库**与 **C 批量补全**，歌词写入 `online-lyrics/<歌曲id>.lrc` 文件、`songs.lyrics` 列存文件引用（与封面 `cover_art` 存引用、图片在 `online-covers/` 完全同构，都不再直接落数据库文本）；旧版本已落库的歌词文本仍可直接读取（兼容）。本地音乐自带的 `.lrc` 歌词文件仍放在**音乐文件同目录**（sidecar），不在此处。

想清空媒体缓存（如换歌词/封面源后重新拉取），删除 `online-lyrics/`、`online-covers/` 目录内容后重启即可，本地 `covers/` 与库内元数据不受影响。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `JWT_SECRET` | 否 | 自动生成 | JWT 签名密钥。留空则首次启动自动生成并保存到数据目录 `.jwt-secret` |
| `CORS_ORIGINS` | 否 | `*` | 允许的跨域来源（逗号分隔）。HA 卡片直连模式需要把 HA 前端来源加入此处（或保持 `*`） |
| `PLAY_HISTORY_RETENTION_DAYS` | 否 | `3` | 播放历史保留天数 |
| `DLNA_BASE_URL` | 否 | 自动探测 | DLNA 渲染器回拉音频流的基地址，多网卡/反代场景需手填 |
| `DATA_DIR` | 否 | `./data` | 数据与缓存目录（SQLite + 封面缓存 + 外置插件 + 密钥），结构见上方「数据与缓存目录」 |
| `MUSICFLOW_OFFICIAL_REGISTRY` | 否 | 官方 URL | 插件注册表地址；置空串禁用自动种子（内网/离线） |

## Home Assistant 接入

MusicFlow 提供三个配套仓库，构成完整的 Home Assistant 生态（各仓库发版说明与镜像构建见各自仓库）：

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

后端测试：`cd backend && npx vitest run`（全量 218 用例，含 OpenSubsonic 路由级测试与插件沙箱专项）。

## 文档导航

| 文档 | 内容 | 谁需要 |
|---|---|---|
| `CONTRIBUTING.md` | 贡献指南：环境、跑起来、测试/检查、提交与 PR 规范 | 想给本项目提代码的开发者 |
| `docs/DEVELOPER.md` | 架构与开发指南：目录结构、数据流、DB schema、鉴权、常见任务速查 | 想理解/扩展本项目的开发者 |
| `docs/API.md` | API 参考：鉴权、原生 `/v1` 端点、OpenSubsonic、WS | 想对接本服务的开发者（含集成/卡片） |
| `docs/PLUGIN_ARCHITECTURE.md` | 插件化架构：能力模型、耦合点、里程碑、北向目标 | 想深入插件框架的人 |
| `docs/PLUGIN_DEV.md` | 插件开发：沙箱契约、host.* 全量、示例 | 想写插件的开发者 |
| `docs/RESEARCH-songloft-plugin-inspiration.md` | songloft 插件体系调研（方案 B 已落地） | 想了解沙箱设计来源的人 |
| [MusicFlow-plugins README](https://github.com/ray5378/MusicFlow-plugins/blob/master/README.md) | 官方插件：目录、打包、Release 发布流程 | 想发布插件的人 |
