# MusicFlow

自托管音乐库播放器，**插件化架构**。后端 Hono + SQLite，前端 Vue 3 + Element Plus。在线音乐源、歌单导入、每日推荐、歌词封面、DLNA 投屏等均以插件形式接入，核心按能力遍历，不耦合具体实现。

> **定位**：Home Assistant 主链路（加载项 + 集成 + 卡片）的音乐服务内核，也支持独立部署运行。

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
    volumes:
      # 数据目录(SQLite 主库 + 歌词/封面/插件/密钥)
      - ./local/data:/app/backend/data
      # 本地音乐目录:把音乐文件放进宿主机路径,容器内即 /local/music
      - ./local/music:/local/music
      # 可选:平台歌曲/歌单封面缓存,独立挂到大磁盘
      - ./local/online-covers:/app/backend/data/online-covers
      # 可选:平台歌词缓存,独立挂到大磁盘
      - ./local/online-lyrics:/app/backend/data/online-lyrics

networks: {}
```

## 功能概览

| 能力 | 说明 |
|------|------|
| 音乐库管理 | 本地音乐扫描、在线音乐源（QQ / 网易云等）、多音质切换、流回退 |
| 歌单 | 创建管理、每日推荐、本地推荐、歌单导入/同步、歌单同步至在线平台 |
| 播放 | DLNA 投屏、群组播放、AirPlay、歌词与封面展示、播放历史 |
| 兼容性 | **OpenSubsonic 兼容**，支持 Symfonik / DSub / 音流等第三方客户端连接 |
| 插件 | 九类插件能力，外置插件运行在 QuickJS 沙箱中，安全隔离 |
| 首页展示 | 插件驱动首页卡片，每日推荐、本地推荐、今日漫游等 |

## 客户端

[MusicFlow-client](https://github.com/ray5378/MusicFlow-client) 提供 Android 和 Windows 桌面客户端，通过 OpenSubsonic 协议连接服务端：

| 平台 | 说明 |
|------|------|
| Android | 原生移动客户端，支持后台播放、通知栏控制、锁屏封面 |
| Windows | 桌面客户端，支持托盘运行、全局快捷键、系统媒体集成 |

## Home Assistant 接入

| 仓库 | 类型 | 作用 |
|------|------|------|
| [hassio-addons](https://github.com/ray5378/hassio-addons) | HA 加载项 | 把服务端跑在 Supervisor 下 |
| [hass-musicflow](https://github.com/ray5378/hass-musicflow) | HACS 集成 | 将 DLNA 设备与播放组变为 `media_player` 实体 |
| [hass-musicflow-card](https://github.com/ray5378/hass-musicflow-card) | HACS 前端卡片 | 复刻 HA 官方 `media-control` 卡片样式 |

服务端通过 mDNS 广播 `_musicflow._tcp.local.`，HA 侧可自动发现。

## 文档导航

| 文档 | 适合谁 |
|------|--------|
| [插件架构](docs/PLUGIN_ARCHITECTURE.md) | 想了解插件化设计的人 |
| [插件开发](docs/PLUGIN_DEV.md) | 想写插件的开发者 |
| [API 参考](docs/API.md) | 对接集成的开发者 |
| [开发指南](docs/DEVELOPER.md) | 扩展/修改本项目的开发者 |
| [贡献指南](CONTRIBUTING.md) | 想提交代码的开发者 |
| [插件市场仓库](https://github.com/ray5378/MusicFlow-plugins) | 想发布插件的人 |

## 镜像

打 `v*` tag 时 CI 自动构建到（仅 **linux/amd64**）：

- `ghcr.io/ray5378/musicflow:<版本>`
- `ghcr.io/ray5378/musicflow:latest`
