# MusicFlow-V2 API 参考（API）

> 适用 v1.4.0+。三套接口面：
> - **原生 API**：`/rest/api/v1/*`（内部 REST 别名，前端与 HA 集成使用；`/api/v1/*` 经 Navidrome 兼容层同样可达）
> - **OpenSubsonic**：`/rest/*`（46+ 端点，第三方 Subsonic 客户端）
> - **WebSocket**：`/ws?token=`
>
> 基址：`http://<host>:46400`（addon 为 HA 地址 46400 端口）。

## 1. 鉴权

`middleware/auth.ts` 统一支持四种，任选其一：

| 方式 | 头/参数 | 适用 |
|---|---|---|
| Bearer JWT | `Authorization: Bearer <token>` | 登录后 24h 有效，前端/脚本 |
| Bearer API Key | `Authorization: Bearer <apiKey>` | 常驻客户端（HA 集成），`/v1/users/me/api-key` 生成，可吊销 |
| OpenSubsonic u/t/s | `?u=&t=&s=`（`t=md5(密码+盐)`） | Subsonic 客户端 |
| OpenSubsonic u/p | `?u=&p=enc:<base64>` | Subsonic 客户端 |
| token 参数 | `?token=<jwt或apiKey>` | WS 与代理兜底 |

登录：`POST /rest/api/v1/auth/login`（body `{ username, password }`）→ `{ token }`。
首次启动自动创建 `admin / admin`（登录后强制改密）。

> 管理端点额外要求 `adminMiddleware`（isAdmin）。普通用户端点走 `authMiddleware`。

## 2. 原生 API（`/rest/api/v1/*`）

> 下方路径省略 `/rest/api` 前缀；`/api/v1/*` 同义可达。响应默认 JSON。

### 2.1 用户与登录
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | 登录（见上；实际挂载 `/rest/api/v1/auth/login`） |
| GET | `/users/me` | 当前用户信息（卡片直连用） |
| GET/POST | `/users`、`/users/:id`、`PUT /users/:id/password`、`PUT /users/:id/username` | 用户管理（admin） |
| GET/POST/DELETE | `/users/me/api-key`、`/users/:id/api-key` | API Key 生成/吊销 |

### 2.2 曲库浏览（内容）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/albums`、`/artists`、`/genres`、`/songs` | 曲库浏览（支持分页/搜索参数） |
| GET | `/stats` | 曲库统计 |
| GET | `/artists/missing-info-count`、`/artists/scrape-status` | 歌手信息缺失/抓取状态 |
| POST | `/artists/scrape`、`/artists/scrape-missing` | 触发歌手信息抓取 |
| GET | `/playlists`、`/playlists/:id/tracks` | 歌单列表/曲目 |
| POST | `/playlists/import`、`/playlists/:id/sync`、`/playlists/:id/convert-to-local`、`/playlists/:id/favorite` | 导入/同步/转本地/收藏 |
| GET | `/playlists/:id/export`、`/playlists/export-all` | 歌单导出 |
| GET/POST/DELETE | `/wish`、`/wish/export` | 心愿单（未匹配在线曲目） |

### 2.3 播放与队列
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/play` | 通用播放（组/设备） |
| GET | `/peers`、`/peers/:peerId`、`/peers/:peerId/status`、`/peers/:peerId/queue` | 播放器/状态/队列（**peers 返回 `{"peers":[]}` 包裹**） |
| POST | `/peers/:peerId/play`、`/pause`、`/stop`、`/next`、`/prev`、`/seek`、`/volume`、`/mute`、`/play-mode` | 播放控制 |
| POST | `/peers/:peerId/queue/enqueue`、`/queue/play`、`/queue/index`、`/queue/jump`、`/queue/reorder` | 队列操作（jump=保留原队列点播） |
| DELETE | `/peers/:peerId/queue`、`/queue/:index` | 清队列/删条目 |
| POST | `/peers/register`、`/peers/:peerId/announce`、`/peers/:peerId/heartbeat` | 对等实例发现 |
| GET/POST/DELETE | `/player-webhook/tokens` | 播放 webhook 令牌 |

> **产品语义**：`stop`=只停当前曲、队列保留；`关闭`=停止+清空队列。

### 2.4 DLNA 设备
| 方法 | 路径 |
|---|---|
| GET | `/dlna/devices`、`/dlna/devices/:deviceId/status`、`/dlna/devices/:deviceId/queue`、`/dlna/active` |
| POST | `/dlna/scan`、`/dlna/cast`、`/dlna/enqueue`、`/dlna/devices/:deviceId/{play,pause,stop,next,prev,seek,volume,mute,play-mode,deactivate,queue/enqueue,queue/play}` |
| PUT/DELETE | `/dlna/devices/:deviceId`、`/dlna/devices/:deviceId/queue/:index` |

### 2.5 播放组（Groups）
| 方法 | 路径 |
|---|---|
| GET/POST | `/groups`（列表/创建，**返回 `{"groups":[]}` 包裹**） |
| PUT/DELETE | `/groups/:id` |
| GET | `/flows`、`/flows/:id`；POST `/flows`、`/flows/:id/run`；PUT/DELETE `/flows/:id` |

### 2.6 在线源与每日推荐
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/online/:providerId/search` | 搜索（body `{ q, sources? }`） |
| POST | `/online/:providerId/test` | 连线探测 |
| POST | `/online/:providerId/import` | 搜索结果入库 |
| GET | `/online/:providerId/recommend`、`/recommend/local` | 推荐歌单（插件能力遍历） |
| POST | `/online/:providerId/recommend/import`、`/recommend/sync-all` | 推荐同步 |
| GET/POST | `/online/:providerId/unmatched`、`/match-playlist`、`/match-track` | 在线匹配 |
| POST | `/online/:providerId/purge-web-songs` | 清理轮换歌单 |
| GET/PUT/POST | `/daily-recommend`、`/daily-recommend/config`、`/daily-recommend/candidates`、`/daily-recommend/trigger` | 每日推荐 |

### 2.7 插件管理（admin）
| 方法 | 路径 |
|---|---|
| GET | `/plugins`（已安装，含 manifest/健康）、`/plugins/health`、`/plugins/renderers`、`/plugins/renderers/devices`、`/plugins/scrobblers` |
| POST | `/plugins`（注册）、`/plugins/registry`（加注册表）、`/plugins/registry/install`（市场安装） |
| PUT | `/plugins/:id`（配置/启停）、`/plugins/:id/toggle` |
| DELETE | `/plugins/registry/:id` |

### 2.8 设置/统计/媒体源
| 方法 | 路径 |
|---|---|
| GET | `/settings`、`/stats` |
| GET/POST/PUT/DELETE | `/sources`、`/sources/:id`、`/sources/:id/scan`、`/scan-stop`、`/scan-status`、`/test` | 音乐库目录管理 |
| GET/POST/DELETE | `/recommend-pool`、`/recommend-pool/favorites`、`/recommend-pool/playlist/:playlistId` | 推荐池 |

## 3. OpenSubsonic（`/rest/*`）

兼容 Subsonic **v1.16.1** + OpenSubsonic 扩展，46+ 端点（浏览/搜索/播放/歌单/收藏/评分/歌词/上报/播放队列/头像）。
第三方客户端（Symfonik / DSub / MA / libopensonic）直接连接本服务即可。

要点：
- 失败响应：`{ "subsonic-response": { status:"failed", error:{ code, message } } }`（40=鉴权、50=权限、70=资源、10=参数）；
- 全部端点支持 `.view` 后缀与 POST 表单变体；
- 端点清单与字段符合官方规范，另支持 `getOpenSubsonicExtensions` 声明扩展（transcodeOffset / formPost / songLyrics / indexBasedQueue / playbackReport / topSongsByArtistId）；
- 常见：`/rest/ping`、`/rest/search2?query=`、`/rest/getMusicFolders`、`/rest/stream?id=`、`/rest/getCoverArt`、`/rest/getPlaylists`、`/rest/scrobble`。

> 完整端点枚举见源码 `routes/rest/index.ts` 与 OpenSubsonic 规范。测试：`backend/tests/rest/opensubsonic.test.ts`。

## 4. WebSocket（`/ws?token=`）

- 连接：`ws://<host>:46400/ws?token=<jwt或apiKey>`；
- 服务端推送播放状态事件（播放中曲目、进度、队列、设备/组变化），前端与 HA 集成订阅；
- 认证同 REST（Bearer/API Key 均可放 token 参数）。

## 5. 其他端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ping` | 存活（`{ status:"ok", version, commit }`） |
| GET | `/rest/ping` | OpenSubsonic 存活 |
| POST | `/webhooks/flows/:token` | 场景流 webhook |
| POST | `/webhook/player` | 播放 webhook |

## 6. 调用示例

```bash
# 登录
TOKEN=$(curl -s -X POST http://host:46400/rest/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' | python -c "import json,sys;print(json.load(sys.stdin)['token'])")

# 曲库浏览
curl -s http://host:46400/rest/api/v1/albums -H "Authorization: Bearer $TOKEN"

# 播放器状态(注意 {peers:[]} 包裹)
curl -s http://host:46400/rest/api/v1/peers -H "Authorization: Bearer $TOKEN"

# OpenSubsonic 搜索(u/t/s)
T=$(python -c "import hashlib;print(hashlib.md5(b'admin' + b'mysalt').hexdigest())")
curl -s "http://host:46400/rest/search2?u=admin&t=$T&s=mysalt&query=周杰伦"
```
