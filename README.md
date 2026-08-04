# MusicFlow

自托管音乐库播放器(OpenSubsonic 兼容)。后端 Hono + SQLite(better-sqlite3),前端 Vue 3 + Element Plus。
单容器部署:后端直接托管前端构建产物,一个端口同时提供 Web UI 和 OpenSubsonic API。

## 镜像

GitHub push 自动构建到:

- `ghcr.io/ray5378/musicflow:latest`
- `docker.io/ray5378/musicflow:latest`

多架构:linux/amd64 + linux/arm64。版本标签 `v*` 同时打版本号。

## 部署(其他机器)

```bash
mkdir musicflow && cd musicflow
cp <repo>/.env.example .env          # 填入 JWT_SECRET
docker compose up -d                  # 自动拉取镜像
```

或直接:

```bash
docker run -d --name musicflow --restart unless-stopped \
  -p 46400:46400 \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -v $(pwd)/data:/app/backend/data \
  docker.io/ray5378/musicflow:latest
```

访问 `http://<机器IP>:46400`。

首次启动自动初始化数据库并创建默认管理员账号 `admin / admin`(登录后强制改密)。

## 数据

- `./data/` 挂载卷:SQLite 数据库 + 封面缓存,备份/迁移只需复制该目录
- `JWT_SECRET` 必须跨重启保持一致,否则需要重新登录(密码加密会自动按新密钥重新加密)

## 本地开发

```bash
cd backend && npm run dev      # API :46400
cd frontend && npm run dev     # UI :46399 (代理 /rest /api 到后端)
```
