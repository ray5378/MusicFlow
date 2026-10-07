# MusicFlow

自托管音乐库播放器，**插件化架构**。后端 Hono + SQLite，前端 Vue 3 + Element Plus。在线音乐源、歌单导入、每日推荐、歌词封面、DLNA 投屏等均以插件形式接入，核心按能力遍历，不耦合具体实现。

> **定位**：Home Assistant 主链路（集成 + 卡片）的音乐服务内核，也支持独立部署运行。

## 快速开始

```bash
mkdir musicflow && cd musicflow
curl -o docker-compose.yaml https://raw.githubusercontent.com/ray5378/MusicFlow/main/docker-compose.yml
docker compose up -d
```

访问 `http://<机器IP>:46400`，首次启动自动创建管理员 `admin / admin`（登录后强制改密）。

> DLNA 投屏依赖 SSDP 多播，需使用 `network_mode: host`（仅 Linux 支持）。

完整的 `docker-compose.yml`（可变量根据实际路径替换）：

```yaml
services:
  musicflow:
    image: ray5378/musicflow:latest
    container_name: musicflow
    restart: always
    # 注意:DLNA 发现依赖 SSDP 多播,必须使用 host 网络模式。
    # host 网络仅 Linux 支持;Docker Desktop(macOS/Windows)上多播不可用,DLNA 需原生运行。
    network_mode: host
    environment:
      # 可选:JWT 签名密钥。留空则首次启动自动生成并保存到数据目录 .jwt-secret(重启稳定)。
      - JWT_SECRET=${JWT_SECRET:-}
      - CORS_ORIGINS=${CORS_ORIGINS:-*}
      - PLAY_HISTORY_RETENTION_DAYS=${PLAY_HISTORY_RETENTION_DAYS:-3}
      - TZ=Asia/Shanghai
      - UV_USE_IO_URING=0
      # 可选:V8 堆上限(MB)。默认不设;内存紧张的机器可设 256 及时压堆。
      # - NODE_OPTIONS=--max-old-space-size=256
      # 可选:覆盖 DLNA 渲染器回拉流地址的基地址。默认从请求 Host 头自动探测;
      # 反代/多网卡导致探测错误时设置此项。
      # - DLNA_BASE_URL=http://192.168.1.100:46400
    volumes:
      # 数据与缓存目录(宿主 ./data 挂到容器 /app/backend/data,与镜像 entrypoint 一致):
      #   musicflow.db      —— SQLite 主库(歌曲/歌单/设置)
      #   covers/           —— 本地刮削封面(扫描内嵌封面、艺术家头像)
      #   online-covers/    —— 平台/在线封面缓存(web 歌曲、歌单导入、按需获取 A/B)
      #   online-lyrics/    —— 插件获取并落库的歌词文件(按需获取 A/B、批量补全 C)
      #   plugins/          —— 外置插件
      #   .jwt-secret       —— 自动生成的 JWT 密钥
      - ./data:/app/backend/data
      # 容器时区:镜像无 tzdata,需挂载宿主机时区文件(TZ 环境变量仅对应用层生效)
      - /etc/localtime:/etc/localtime:ro
      - /usr/share/zoneinfo:/usr/share/zoneinfo:ro
      # 本地音乐目录(默认开启):宿主 ./local/music 挂到容器 /local/music。
      # 把你的音乐文件放到宿主机的 ./local/music 目录,容器内即 /local/music。
      # 在「媒体源管理 → 添加媒体源 → 类型选本地目录」时,
      # 本地路径填 /local/music(容器内路径),必须与本挂载保持一致,否则读取不到。
      - ./local/music:/local/music
      # 可选:平台/在线封面缓存(online-covers)独立挂到宿主机大磁盘。
      # 默认它在上面的 ./data 卷内,无需配置;想单独存放/单独清缓存时,
      # 取消注释并把宿主机路径换成你的目录(优先级高于 ./data 内的同名子目录):
      # - ./online-covers:/app/backend/data/online-covers
      # 可选:歌词文件(online-lyrics)同理可独立挂载/单独清空:
      # - ./online-lyrics:/app/backend/data/online-lyrics

networks: {}
```

## 功能概览

| 能力 | 说明 |
|------|------|
| 音乐库管理 | 本地音乐扫描、在线音乐源（QQ / 网易云等）、多音质切换、流回退、来源徽标、同曲多源归组与本地曲库优先 |
| 歌单 | 创建管理、每日推荐、本地推荐、歌单导入/同步、歌单同步至在线平台 |
| 播放 | DLNA 投屏、群组播放、AirPlay、Sendspin（ESPHome 等设备直连推流）、歌词与封面展示、播放历史 |
| 兼容性 | **OpenSubsonic 兼容**，支持 箭头音乐(强烈推荐) / Symfonik / DSub / 音流等第三方客户端连接 |
| 插件 | 九类插件能力；外置插件跑 QuickJS 沙箱（主线程 VM / longRunning 走 worker 线程 / 批量任务走一次性子进程） |
| 首页展示 | 插件驱动首页卡片，每日推荐、本地推荐、今日漫游等 |

## 客户端

[MusicFlow-client](https://github.com/ray5378/MusicFlow-client) 提供 Android 和 Windows 桌面客户端，通过 OpenSubsonic 协议连接服务端：

| 平台 | 说明 |
|------|------|
| Android | 原生移动客户端，本项目功能全面对接,支持后台播放、通知栏控制 |
| Windows | 桌面客户端，本项目功能全面对接,支持托盘运行、全局快捷键 |

## Home Assistant 接入

| 仓库 | 类型 | 作用 |
|------|------|------|
| [hass-musicflow](https://github.com/ray5378/hass-musicflow) | HACS 集成 | 将 DLNA 设备与播放组变为 `media_player` 实体 |
| [hass-musicflow-card](https://github.com/ray5378/hass-musicflow-card) | HACS 前端卡片 | 原生 HA 卡片 媒体功能全面接入,需搭配上面的HACS集成使用  卡片样式 |

服务端通过 mDNS 广播 `_musicflow._tcp.local.`，HA 侧可自动发现。

## 同曲多源组

同一首歌可能同时存在于本地 / WebDAV 曲库与插件平台（QQ 音乐 / 网易云等），服务端按「规范化标题 + 歌手 + 专辑一致 + 时长差 ≤ 1 秒」归为同曲多源组（`songs.group_id` / `group_key`），组内优先级 local > webdav > web。

各端对该组的一致行为：

- **Web 前端 / 客户端 / HA 卡片**：列表合并展示（主行 = 组内核心曲库源，带「本地 +N」来源徽标），组内成员行折叠隐藏；
- **播放优选**：所有播放入口自动落到组内 local / WebDAV 源——
  - `/v1/play`（HA 集成媒体播放）按组内优先级选主源；
  - `/rest/stream`（客户端 / 媒体面板流播）在设置 `playback.preferLocal`（默认开）下自动切换本地源；
  - 客户端 / 卡片在入队前还按 `sources[0]` 再选一次，双保险；
- **封面回退链**：歌曲自带封面（`so-<id>`）→ 专辑封面（`al-<albumId>`），专辑无封面时 `getCoverArt` 取同专辑首个带封面曲目，成员行与主行同规则。

分组规则调整后需对存量数据重算一次分组（一次性本地脚本，用完即删，故不随仓库分发），见对应发布记录。

## 文档导航

| 文档 | 适合谁 |
|------|--------|
| [插件架构](docs/PLUGIN_ARCHITECTURE.md) | 想了解插件化设计的人 |
| [插件开发](docs/PLUGIN_DEV.md) | 想写插件的开发者 |
| [API 参考](docs/API.md) | 对接集成的开发者 |
| [服务端预探测](docs/PRE_PROBE.md) | 想了解「三条链路共用一套判活/跳源」的人 |
| [播放换源](docs/SOURCE_SWAP.md) | 想了解多源自动替换匹配规则的人 |
| [进程模型与隔离规划](docs/PROCESS_MODEL_AND_ISOLATION_PLAN.md) | 想了解主/子进程边界与「该不该进程化」判定标准的人 |
| [插件沙箱限制](docs/sandbox-limits-and-plan.md) | 想了解沙箱能力边界与已知限制的人 |
| [开发指南](docs/DEVELOPER.md) | 扩展/修改本项目的开发者 |
| [贡献指南](CONTRIBUTING.md) | 想提交代码的开发者 |
| [插件市场仓库](https://github.com/ray5378/MusicFlow-plugins) | 想发布插件的人 |

## 镜像

打 `v*` tag 时 CI 自动构建推送（仅 **linux/amd64**）并创建 GitHub Release：

| Registry | 地址 |
|------|------|
| Docker Hub | `ray5378/musicflow:<版本>`、`ray5378/musicflow:latest` |
| GHCR | `ghcr.io/ray5378/musicflow:<版本>`、`ghcr.io/ray5378/musicflow:latest` |
