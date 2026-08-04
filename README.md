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
    ports:
      - "46400:46400"
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
docker run -d --name musicflow --restart unless-stopped \
  -p 46400:46400 \
  -v $(pwd)/data:/app/backend/data \
  docker.io/ray5378/musicflow:latest
```

首次启动自动初始化数据库并创建默认管理员账号 `admin / admin`(登录后强制改密)。

## 数据

- `./data/` 挂载卷:SQLite 数据库 + 封面缓存 + 自动生成的密钥文件,备份/迁移只需复制该目录
- 封面缓存可随时删除,会自动按需重建

## 本地开发

```bash
cd backend && npm run dev      # API :46400
cd frontend && npm run dev     # UI :46399 (代理 /rest /api 到后端)
```
