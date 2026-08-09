# MusicFlow

自托管音乐库播放器(OpenSubsonic 兼容)。后端 Hono + SQLite(better-sqlite3),前端 Vue 3 + Element Plus。
单容器部署:后端直接托管前端构建产物,一个端口同时提供 Web UI 和 OpenSubsonic API。

## 镜像

GitHub push 自动构建到:

- `ghcr.io/ray5378/musicflow:latest`
- `docker.io/ray5378/musicflow:latest`

多架构:linux/amd64 + linux/arm64。版本标签 `v*` 同时打版本号。

## 部署(其他机器)

最简单的 `docker compose` 部署:

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

环境变量:

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `JWT_SECRET` | 否 | 自动生成 | JWT 签名密钥(≥32 字符)。不填则首次启动自动生成并保存到数据卷 `data/.jwt-secret`;手动填可自定义 |
| `CORS_ORIGINS` | 否 | `*` | 允许的跨域来源(逗号分隔)。Web UI 同源无需配置,仅影响直接跨域调用 API 的客户端 |
| `PLAY_HISTORY_RETENTION_DAYS` | 否 | `3` | 播放历史保留天数 |

> 注意:`JWT_SECRET` 会自动持久化在 `./data/.jwt-secret`,重启、更新镜像都不变。若**删掉 data 卷重新开始**,会自动生成新密钥,旧密码的加密凭据会重新加密,只需重新登录。

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

首次启动自动初始化数据库并创建默认管理员账号 `admin / admin`(登录后强制改密)。

## 数据

- `./data/` 挂载卷:SQLite 数据库 + 封面缓存 + 自动生成的密钥文件,备份/迁移只需复制该目录
- 封面缓存可随时删除,会自动按需重建
- `./musicdl-covers/` 挂载卷(**可选**):music-dl 插件对接的在线平台(QQ/网易/酷狗等)歌曲、
  歌单封面的存放目录,容器内固定为 `data/musicdl-covers`。
  - **可自行设置**:宿主机侧路径随意指定(如 `/mnt/disk2/musicdl-covers`),
    适合封面量大、想单独放到大容量磁盘、不占用主数据卷的场景;
  - **也可以不设置**:删掉这条挂载即走默认,封面仍写入 `data/musicdl-covers`,
    也就是随主数据卷 `./data/` 一起存放和备份;
  - 两种方式对功能没有影响,读取时会同时探测 `data/musicdl-covers` 与 `data/covers`,
    改配置前已下载的旧封面不会失效

## Home Assistant 接入

MusicFlow 提供两个配套仓库,构成完整的 Home Assistant 生态:

| 仓库 | 类型 | 作用 |
|---|---|---|
| [hass-musicflow](https://github.com/ray5378/hass-musicflow) | HACS 自定义集成 | 把 DLNA 设备与播放组变成 `media_player` 实体,并接入 HA 全局「媒体」标签页 |
| [hass-musicflow-card](https://github.com/ray5378/hass-musicflow-card) | HACS 前端卡片 | 完整播放控件:喜欢 / 添加到歌单 / 滚动歌词 / 切换输出设备(需集成 1.2.6+) |
| [hassio-addons](https://github.com/ray5378/hassio-addons) | HA 加载项 | 把 MusicFlow 服务端直接跑在 Supervisor 下(数据落在 `/share/musicflow`) |

### HACS 集成(推荐)

[hass-musicflow](https://github.com/ray5378/hass-musicflow) 是官方维护的 HACS 自定义集成
([中文说明](https://github.com/ray5378/hass-musicflow/blob/main/README.zh-CN.md)),安装后:

1. **HACS → 集成 → 右上角「⋮」→ 自定义仓库**,仓库地址填 `https://github.com/ray5378/hass-musicflow`,类别选 **集成**;
2. 在 HACS 里搜索并安装 **MusicFlow**,安装完重启 HA;
3. **设置 → 设备与服务 → 添加集成 → MusicFlow**,填服务器地址与 API Key(见下方「鉴权」),即可自动发现。

接入后,你能在 Home Assistant 里获得:

- **曲库浏览**:歌单 / 专辑 / 艺术家 / 流派,支持搜索;
- **完整传输控制**:播放 / 暂停 / 停止 / 上一首 / 下一首 / 拖动进度 / 播放模式(顺序·单曲·循环·随机);
- **双向实时同步**:在 HA 或设备侧调音量、切歌、播放/暂停,另一侧即时反映,无需手动刷新;
- **音量 · 静音 · 输出设备切换**(SELECT_SOURCE)· **软开关机**(TURN_ON/OFF);
- **群组(只读镜像)**:MusicFlow 服务器上用户配置的播放组在 HA 里就是一个普通播放器,
  控制整组播放;组的创建与成员编辑在服务器上进行,HA 侧不做分组/退组,不会改动服务器配置;
- **全局「媒体」标签页**:MusicFlow 曲库出现在 HA 的「媒体」里,任何播放器(Chromecast / Sonos / 其他 DLNA)都能直接播放,不止 MusicFlow 自己的实体;
- **TTS 播报**(MEDIA_ANNOUNCE):播报外部语音后自动回到原曲原进度;
- **封面代理**:即使 HA 与 MusicFlow 不在同一网段,也能正常显示专辑封面。

> 集成版本请保持与主服务配套:服务端升级后,在 HACS 里同步更新集成(当前集成最新 `v1.2.6`,对应服务端 `v1.1.8`)。

### HACS 前端卡片(可选)

集成自带的原生卡片只覆盖基础控制。要获得**喜欢(心形)、添加到歌单、实时滚动歌词、切换输出设备**的完整播放控件,可以再装一张 Lovelace 自定义卡片
[hass-musicflow-card](https://github.com/ray5378/hass-musicflow-card)([中文说明](https://github.com/ray5378/hass-musicflow-card/blob/main/README.zh-CN.md)):

1. HACS 右上角 **⋮ → 自定义存储库**,仓库地址填 `https://github.com/ray5378/hass-musicflow-card`,
   类别选 **Dashboard**(HACS UI 下拉里没有 "Lovelace",前端卡片统一选 Dashboard);
2. 进入 **HACS → 前端**,在 **MusicFlow Card** 上点**下载**,刷新仪表盘;
3. 仪表盘添加卡片,YAML:`type: custom:musicflow-player-card`,`entity: media_player.<你的播放器>`。

> 卡片依赖集成的 `like_track` / `add_to_playlist` 服务与 `musicflow/lyrics` / `musicflow/playlists` WebSocket 命令,请先把集成升级到 **1.2.6+**。

### 通信链路

集成通过下面三条链路与本服务通信,不需要额外端口:

- `GET/POST /rest/api/v1/...` —— peer 列表、播放状态、队列与播放控制
- `GET /rest/...` —— OpenSubsonic 曲库浏览与封面(`/rest/getCoverArt` 免鉴权)
- `WS /ws` —— 播放状态实时推送

服务端会通过 mDNS 广播 `_musicflow._tcp.local.`,HA 侧可自动发现,无需手填地址。

### 鉴权

集成使用 API Key 鉴权(登录 Token 24h 过期,不适合常驻客户端)。
在 **设置 → API Key** 生成后填入 HA 即可,可随时重新生成或撤销。

## 本地开发

```bash
cd backend && npm run dev      # API :46400
cd frontend && npm run dev     # UI :46399 (代理 /rest /api 到后端)
```
