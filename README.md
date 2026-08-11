# MusicFlow

自托管音乐库播放器（OpenSubsonic 兼容）。后端 Hono + SQLite（better-sqlite3），前端 Vue 3 + Element Plus。
单容器部署：后端直接托管前端构建产物，一个端口同时提供 Web UI 和 OpenSubsonic API。

## 当前稳定版本配套（推荐组合）

> 下面三个组件需**配套使用**，版本号对齐才能正常工作。服务端升级后，请在 HACS 同步更新集成与卡片到对应版本。

| 组件 | 版本 | 仓库 |
|---|---|---|
| 服务端（本仓库） | **v1.1.19** | [ray5378/MusicFlow](https://github.com/ray5378/MusicFlow) |
| HA 集成 [hass-musicflow](https://github.com/ray5378/hass-musicflow) | **v1.3.6** | [ray5378/hass-musicflow](https://github.com/ray5378/hass-musicflow) |
| HA 卡片 [hass-musicflow-card](https://github.com/ray5378/hass-musicflow-card) | **v1.6.11** | [ray5378/hass-musicflow-card](https://github.com/ray5378/hass-musicflow-card) |

各仓库的发版（GitHub Release）说明与镜像构建见各自仓库。

## 镜像

GitHub push 自动构建到：

- `ghcr.io/ray5378/musicflow:latest`
- `docker.io/ray5378/musicflow:latest`

> **架构说明**：当前镜像仅提供 **linux/amd64**（x86_64）。arm64 / ARM 设备（如部分 ARM 架构 NAS）暂时无法运行，后续视 GitHub ARM runner 可用性再补多架构。版本标签 `v*` 同样打版本号（如 `:v1.1.19`）。

## 部署（其他机器）

最简单的 `docker compose` 部署：

```bash
mkdir musicflow && cd musicflow
curl -o docker-compose.yaml https://raw.githubusercontent.com/ray5378/MusicFlow/main/docker-compose.yml
docker compose up -d    # 自动拉取镜像
```

访问 `http://<机器IP>:46400`。

### docker-compose.yaml 配置

```yaml
services:
  musicflow:
    image: docker.io/ray5378/musicflow:latest
    container_name: musicflow
    restart: unless-stopped
    network_mode: host
    environment:
      # 可选:留空则首次启动自动生成,并持久化在 ./data/.jwt-secret(重启不变)
      # 如需手动指定:openssl rand -hex 32
      - JWT_SECRET=${JWT_SECRET:-}
      - CORS_ORIGINS=${CORS_ORIGINS:-*}
      - PLAY_HISTORY_RETENTION_DAYS=${PLAY_HISTORY_RETENTION_DAYS:-3}
      - TZ=Asia/Shanghai
      - UV_USE_IO_URING=0
    volumes:
      - ./data:/app/backend/data
      # 可选:music-dl 插件从在线平台(QQ/网易/酷狗等)拉取的歌曲、歌单封面的存放目录。
      # 可自行指定为任意路径(如挂到大容量磁盘);不写这行就走默认,
      # 封面直接落在上面的 ./data 卷内的 musicdl-covers 子目录里。
      - ./musicdl-covers:/app/backend/data/musicdl-covers
```

环境变量：

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `JWT_SECRET` | 否 | 自动生成 | JWT 签名密钥（≥32 字符）。不填则首次启动自动生成并保存到数据卷 `data/.jwt-secret`；手动填可自定义 |
| `CORS_ORIGINS` | 否 | `*` | 允许的跨域来源（逗号分隔）。Web UI 同源无需配置，仅影响直接跨域调用 API 的客户端。**HA 卡片直连模式需要把 HA 前端来源加入此处（或保持 `*`）** |
| `PLAY_HISTORY_RETENTION_DAYS` | 否 | `3` | 播放历史保留天数 |

> 注意：`JWT_SECRET` 会自动持久化在 `./data/.jwt-secret`，重启、更新镜像都不变。若**删掉 data 卷重新开始**，会自动生成新密钥，旧密码的加密凭据会重新加密，只需重新登录。

### 直接 docker run

```bash
# 第二个 -v 是可选的:music-dl 插件从在线平台拉取的封面单独存放目录,
# 路径可自行指定;整行删掉即走默认,封面存进 data 卷内的 musicdl-covers 子目录。
docker run -d --name musicflow --restart unless-stopped \
  -p 46400:46400 \
  -v $(pwd)/data:/app/backend/data \
  -v $(pwd)/musicdl-covers:/app/backend/data/musicdl-covers \
  docker.io/ray5378/musicflow:latest
```

首次启动自动初始化数据库并创建默认管理员账号 `admin / admin`（登录后强制改密）。

## 数据

- `./data/` 挂载卷：SQLite 数据库 + 封面缓存 + 自动生成的密钥文件，备份/迁移只需复制该目录
- 封面缓存可随时删除，会自动按需重建
- `./musicdl-covers/` 挂载卷（**可选**）：music-dl 插件对接的在线平台（QQ/网易/酷狗等）歌曲、
  歌单封面的存放目录，容器内固定为 `data/musicdl-covers`。
  - **可自行设置**：宿主机侧路径随意指定（如 `/mnt/disk2/musicdl-covers`），
    适合封面量大、想单独放到大容量磁盘、不占用主数据卷的场景；
  - **也可以不设置**：删掉这条挂载即走默认，封面仍写入 `data/musicdl-covers`，
    也就是随主数据卷 `./data/` 一起存放和备份；
  - 两种方式对功能没有影响，读取时会同时探测 `data/musicdl-covers` 与 `data/covers`，
    改配置前已下载的旧封面不会失效

## 媒体库性能（v1.1.19 起）

服务端针对外网 / 大曲库场景做了以下优化，配合最新版集成与卡片生效：

- **封面按需缩放 + webp**：`/rest/getCoverArt` 按请求尺寸（列表缩略图约 160px）用 sharp 缩放，
  并依据请求头 `Accept: image/webp` 返回 webp，体积约为原 jpeg 的 1/3–1/5。
- **封面 HTTP 缓存**：响应带 `Cache-Control` + `ETag`，浏览器 / 中间代理可跨刷新复用（304），
  外网翻页、刷新不再重复下载封面。
- **服务端分页**：专辑、歌单、「我喜欢的音乐」改为按 `offset/size` 分页返回，
  大曲库（几千首）首屏无需全量拉取，翻页由卡片请求下一页。

## Home Assistant 接入

MusicFlow 提供两个配套仓库，构成完整的 Home Assistant 生态（**版本需与上方「稳定版本配套」对齐**）：

| 仓库 | 类型 | 作用 |
|---|---|---|
| [hass-musicflow](https://github.com/ray5378/hass-musicflow) | HACS 自定义集成 | 把 DLNA 设备与播放组变成 `media_player` 实体，并接入 HA 全局「媒体」标签页 |
| [hass-musicflow-card](https://github.com/ray5378/hass-musicflow-card) | HACS 前端卡片 | 复刻 HA 官方 `media-control` 卡片样式，叠加 MusicFlow 能力（切换播放器 / 喜欢 / 媒体库入口） |
| [hassio-addons](https://github.com/ray5378/hassio-addons) | HA 加载项 | 把 MusicFlow 服务端直接跑在 Supervisor 下（数据落在 `/share/musicflow`） |

### 各项目实现目标

这 4 个仓库共同构成一套「自托管音乐服务 + Home Assistant 原生体验」：

| 项目 | 实现目标 |
|---|---|
| **MusicFlow（本仓库）** | 自托管音乐服务端：接入 WebDAV/本地音乐来源，DLNA 发现与播放、多房间同步组、歌单/收藏/歌词、OpenSubsonic 兼容 API（`/rest/*`）、对 HA 生态（集成/卡片/加载项）提供 REST + WebSocket 通信基础。**HA 侧的每个播放器（设备/组）都是服务器上的一个 peer，状态与队列以服务器为准。** |
| **hass-musicflow（集成）** | 把 MusicFlow 的 DLNA 设备与播放组镜像成 HA `media_player` 实体；WebSocket 实时状态同步（local_push）；媒体浏览/搜索接入 HA 全局「媒体」；提供 `like_track` / `add_to_playlist` 等服务与 `musicflow/lyrics` / `musicflow/playlists` WebSocket 命令；**「切换播放器」遵循服务器 `switchPeer` 语义——纯 UI 切换控制目标，旧播放器播放队列与状态完全不变**；服务器上的播放群组在 HA 里是只读镜像，集成不提供分组编辑。同时作为卡片的**代理中转**：外网时把卡片的 REST 与实时事件转发到后端。 |
| **hass-musicflow-card（前端卡片）** | **以 HA 官方 `media-control` 卡片（`type: media-control`，文档见 https://www.home-assistant.io/dashboards/media-control/ ）为基线完整复刻，再在其基础上做 MusicFlow 增强**——保持官方外观与交互，叠加 MusicFlow 特有的能力（如点击 DLNA 图标切换播放器、喜欢、加歌单、滚动歌词）。直连后端或经集成代理，封面在代理模式下走 HA 鉴权拉取（外网可见），直连模式走可缓存直链。 |
| **hassio-addons（加载项）** | 让 MusicFlow 服务端以 Supervisor 加载项形式一键运行在 HAOS 上，数据与配置落在 `/share/musicflow`，与 HA 集成/卡片开箱即用。 |

### HACS 集成（推荐）

[hass-musicflow](https://github.com/ray5378/hass-musicflow) 是官方维护的 HACS 自定义集成
（[中文说明](https://github.com/ray5378/hass-musicflow/blob/main/README.zh-CN.md)），安装后：

1. **HACS → 集成 → 右上角「⋮」→ 自定义仓库**，仓库地址填 `https://github.com/ray5378/hass-musicflow`，类别选 **集成**；
2. 在 HACS 里搜索并安装 **MusicFlow**，安装完重启 HA；
3. **设置 → 设备与服务 → 添加集成 → MusicFlow**，填服务器地址与 API Key（见下方「鉴权」），即可自动发现。

接入后，你能在 Home Assistant 里获得：

- **曲库浏览**：歌单 / 专辑 / 艺术家 / 流派，支持搜索；
- **完整传输控制**：播放 / 暂停 / 停止 / 上一首 / 下一首 / 拖动进度 / 播放模式（顺序·单曲·循环·随机）；
- **双向实时同步**：在 HA 或设备侧调音量、切歌、播放/暂停，另一侧即时反映，无需手动刷新；
- **音量 · 静音 · 输出设备切换**（SELECT_SOURCE）· **软开关机**（TURN_ON/OFF）；
- **群组（只读镜像）**：MusicFlow 服务器上用户配置的播放组在 HA 里就是一个普通播放器，
  控制整组播放；组的创建与成员编辑在服务器上进行，HA 侧不做分组/退组，不会改动服务器配置；
- **全局「媒体」标签页**：MusicFlow 曲库出现在 HA 的「媒体」里，任何播放器（Chromecast / Sonos / 其他 DLNA）都能直接播放，不止 MusicFlow 自己的实体；
- **TTS 播报**（MEDIA_ANNOUNCE）：播报外部语音后自动回到原曲原进度；
- **封面代理**：即使 HA 与 MusicFlow 不在同一网段，也能正常显示专辑封面。

> 集成版本请与服务端保持配套：服务端升级后，在 HACS 里同步更新集成与卡片到上方「稳定版本配套」对应版本。

### HACS 前端卡片（可选）

集成自带的原生卡片只覆盖基础控制。要获得**喜欢（心形）、添加到歌单、实时滚动歌词、切换输出设备**的完整播放控件，可以再装一张 Lovelace 自定义卡片
[hass-musicflow-card](https://github.com/ray5378/hass-musicflow-card)（[中文说明](https://github.com/ray5378/hass-musicflow-card/blob/main/README.zh-CN.md)）：

1. HACS 右上角 **⋮ → 自定义存储库**，仓库地址填 `https://github.com/ray5378/hass-musicflow-card`，
   类别选 **Dashboard**（HACS UI 下拉里没有 "Lovelace"，前端卡片统一选 Dashboard）；
2. 进入 **HACS → 前端**，在 **MusicFlow Card** 上点**下载**，刷新仪表盘；
3. 仪表盘添加卡片，YAML：`type: custom:hass-musicflow-card`，`entity: media_player.<你的播放器>`。

> 卡片依赖集成的 `like_track` / `add_to_playlist` 服务与 `musicflow/*` WebSocket 命令，请先把集成升级到 **1.3.6+**（对应服务端 **1.1.19**）。

### 通信链路

集成通过下面三条链路与本服务通信，不需要额外端口：

- `GET/POST /rest/api/v1/...` —— peer 列表、播放状态、队列与播放控制
- `GET /rest/...` —— OpenSubsonic 曲库浏览与封面（`/rest/getCoverArt` 免鉴权）
- `WS /ws` —— 播放状态实时推送

服务端会通过 mDNS 广播 `_musicflow._tcp.local.`，HA 侧可自动发现，无需手填地址。

### 鉴权

集成使用 API Key 鉴权（登录 Token 24h 过期，不适合常驻客户端）。
在 **设置 → API Key** 生成后填入 HA 即可，可随时重新生成或撤销。

## 本地开发

```bash
cd backend && npm run dev      # API :46400
cd frontend && npm run dev     # UI :46399 (代理 /rest /api 到后端)
```
