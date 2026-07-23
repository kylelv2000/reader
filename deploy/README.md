# 部署指南

正式部署只需要 `deploy/compose.yml` 一个文件，镜像从 Docker Hub（`komqaq/yomu-reader`）拉取，服务器不需要编译任何东西。常驻服务只有两个：

- **yomu-app** — 网页界面 + 安全网关，只有它绑定宿主机端口（仅 127.0.0.1）
- **reader-core** — 书源抓取与数据存储（SQLite + 文件），不对外开放

## 快速开始（三步）

```bash
# 1. 准备配置：复制模板并按注释填写 3 个必填项
cp deploy/.env.example deploy/.env
vim deploy/.env   # 详细说明见 .env.example 内的注释，或下方参数表

# 2. 首次部署：创建管理员账号（一次性，不常驻）
docker compose --env-file deploy/.env -f deploy/compose.yml up -d reader-core
read -r "YOMU_ADMIN_USERNAME?管理员用户名（5–32 位小写字母或数字）: "
read -rs "YOMU_ADMIN_PASSWORD?管理员密码（至少 12 位）: "; echo
export YOMU_ADMIN_USERNAME YOMU_ADMIN_PASSWORD
docker compose --env-file deploy/.env -f deploy/compose.yml --profile setup run --rm admin-init
unset YOMU_ADMIN_PASSWORD

# 3. 启动全部服务
docker compose --env-file deploy/.env -f deploy/compose.yml up -d
```

然后用浏览器打开 `YOMU_PUBLIC_ORIGIN` 填写的地址登录即可。外层反向代理（Caddy/Nginx 等）只需把 HTTPS 流量转发到 `127.0.0.1:8080`。

也可以用脚本一次性生成权限为 `0600` 的配置文件（密钥自动生成、不打印）：

```bash
python3 scripts/prepare-deploy-env.py \
  --output deploy/.env \
  --origin https://reader.example.com \
  --port 8080
```

## 参数说明

**必填 3 项：**

| 参数 | 填什么 |
|------|--------|
| `YOMU_PUBLIC_ORIGIN` | 浏览器访问地址，如 `https://reader.example.com`；本机测试填 `http://localhost:8080` 并把 `YOMU_COOKIE_SECURE` 改为 `false` |
| `YOMU_SESSION_SECRET` | 32 位以上随机字符串（`openssl rand -hex 32`），加密登录会话 |
| `READER_SECURE_KEY` | 长随机字符串，服务器管理密钥，等同超级管理员密码 |

**首次部署需要：**

| 参数 | 填什么 |
|------|--------|
| `READER_INVITE_CODE` | 随机字符串，仅创建首位管理员时用到 |

**常用可选（有合理默认值）：**

| 参数 | 默认 | 说明 |
|------|------|------|
| `YOMU_IMAGE_VERSION` | `latest` | 镜像版本，可固定如 `1.2.1` 便于回滚 |
| `YOMU_PORT` | `8080` | 绑定到 127.0.0.1 的端口，反向代理转发到它 |
| `READER_STORAGE` | `reader-storage` | 数据位置：默认 Docker 卷；填绝对路径可直接落盘、便于备份或迁移旧 Reader Pro 数据 |
| `YOMU_COOKIE_SECURE` | `true` | 有 HTTPS 保持 `true`；localhost 测试改 `false` |
| `READER_USER_LIMIT` | `10` | 用户数上限 |
| `READER_USER_BOOK_LIMIT` | `2000` | 每用户书籍上限 |
| `READER_REQUEST_TIMEOUT_SECS` | `20` | 抓取书源的请求超时（秒） |
| `READER_MAX_OUTBOUND_CONCURRENT` | `16` | 对外抓取并发上限，小带宽可调低 |
| `READER_LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |

其余进阶参数（会话时长、上传上限、WebView 细节等）见 `.env.example` 内的逐项注释。

## 可选：WebView 书源

个别书源需要真实浏览器执行 JS。默认不启动；确认需要后：

1. 在 `deploy/.env` 取消注释 `WEBVIEW_BRIDGE_URL` 和 `WEBVIEW_BRIDGE_KEY`（KEY 填随机字符串）
2. 启动时追加 profile：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml --profile webview up -d
```

WebView 容器常驻约 800MB 内存，空闲自动休眠；只有规则明确要求 WebView 的抓取才会经过它，普通书源始终走轻量 HTTP 引擎。去掉 `--profile webview` 重新 `up -d` 即可停用。

## 升级与备份

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml pull
docker compose --env-file deploy/.env -f deploy/compose.yml up -d
```

数据全部在 `READER_STORAGE`（默认 Docker 卷 `reader-storage`）里，升级前备份它即可。旧版 Reader Pro 迁移：把 `READER_STORAGE` 指向旧数据目录，首次启动自动迁移；旧 `bookSource.json` 可用 `scripts/migrate-reader-pro.py` 导入。

安全加固、密钥轮换与端到端检查见 [`../docs/SECURITY.md`](../docs/SECURITY.md)。

## 开发 / 自编译版

不想用预编译镜像、或者要在服务器上跑自己改过的代码时，叠加 `compose.dev.yml` 从源码构建（前端需要 Node 构建环境，Rust Core 编译一次约 5 分钟）：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml -f deploy/compose.dev.yml build
docker compose --env-file deploy/.env -f deploy/compose.yml -f deploy/compose.dev.yml up -d
```

其余用法（初始化、WebView profile、参数）与正式版完全一致。
