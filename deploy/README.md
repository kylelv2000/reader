# 部署指南

只需要 `compose.yml` 一个文件，全部配置都有默认值，**不需要写任何配置就能启动**。镜像从 Docker Hub（`komqaq/yomu-reader`）拉取，服务器不需要编译。常驻服务只有两个：

- **yomu-app** — 网页界面 + 安全网关，唯一绑定宿主机端口的服务
- **reader-core** — 书源抓取与数据存储（SQLite + 文件），不对外开放

## 一键部署

```bash
mkdir yomu-reader && cd yomu-reader
curl -LO https://raw.githubusercontent.com/kylelv2000/reader/main/deploy/compose.yml
docker compose up -d
```

首次启动会**自动创建管理员账号**（用户名 `admin`），初始密码这样看：

```bash
docker compose logs reader-core | grep admin
```

浏览器打开 `http://localhost:8080`，登录后记得在「用户」页修改密码。

会话密钥、内部管理密钥都会自动生成并保存在数据卷中，重启不失效；数据库固定放在存储卷内，无需配置。

**局域网访问**（家里其他设备直接连）：

```bash
YOMU_BIND=0.0.0.0 docker compose up -d
```

然后用 `http://<主机IP>:8080` 访问。

## 公网部署（有域名）

1. 用反向代理（Caddy / Nginx）把域名的 HTTPS 流量转发到 `127.0.0.1:8080`；
2. 启动时告诉服务对外地址（启用严格来源校验与 HTTPS Cookie）：

```bash
echo 'YOMU_PUBLIC_ORIGIN=https://reader.example.com' > .env
docker compose up -d
```

Caddy 示例（自动 HTTPS）：

```
reader.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## 自定义配置（可选）

所有参数都有默认值。想调整时，把 [`.env.example`](.env.example) 复制为同目录 `.env`，取消需要的注释即可，每一项都有说明。常用的几项：

| 参数 | 默认 | 说明 |
|------|------|------|
| `YOMU_PUBLIC_ORIGIN` | 空（本地模式） | 公网部署填 `https://` 域名 |
| `YOMU_PORT` / `YOMU_BIND` | `8080` / `127.0.0.1` | 监听端口与网卡 |
| `YOMU_ADMIN_USERNAME` / `YOMU_ADMIN_PASSWORD` | `admin` / 自动生成 | 初始管理员（仅首次启动生效） |
| `READER_STORAGE` | Docker 卷 | 填绝对路径可直接落盘、便于备份 |
| `YOMU_IMAGE_VERSION` | `latest` | 固定版本号（如 `1.4.0`）便于回滚 |
| `READER_USER_LIMIT` | `10` | 用户数上限 |
| `READER_USER_SOURCE_LIMIT` | `50` | 每个普通用户自有书源上限；管理员书源全员共享、不占额度 |
| `READER_MAX_OUTBOUND_CONCURRENT` | `32` | 对外抓取全局并发池，小机器 16、大机器 64 |
| `READER_CORE_MEM_LIMIT` | `1g` | 内存上限，小内存机器可改 `512m` |

配额与性能的完整清单见 `.env.example` 内的逐项注释。

## 可选：WebView 书源

个别书源需要真实浏览器执行 JS，默认不启动。确认需要后在 `.env` 里设置：

```
WEBVIEW_BRIDGE_URL=http://webview-bridge:19090
WEBVIEW_BRIDGE_KEY=<随机长字符串>
```

启动时追加 profile：

```bash
docker compose --profile webview up -d
```

WebView 容器常驻约 800MB 内存，空闲自动休眠；只有规则明确要求 WebView 的抓取才会经过它。去掉 `--profile webview` 重新 `up -d` 即可停用。

## 升级与备份

```bash
docker compose pull && docker compose up -d
```

数据全部在 `READER_STORAGE`（默认 Docker 卷 `reader-storage`）里，升级前备份它即可：

```bash
docker run --rm -v yomu-reader_reader-storage:/data -v "$PWD":/backup alpine tar czf /backup/yomu-backup.tar.gz -C /data .
```

旧版 Reader Pro 迁移：把 `READER_STORAGE` 指向旧数据目录，首次启动自动迁移；旧 `bookSource.json` 可用 `scripts/migrate-reader-pro.py` 导入。

忘记管理员密码：`docker compose exec reader-core cat /app/storage/data/initial-admin-password.txt`（仅自动生成时存在）；或删除全部用户数据后重启重新初始化。

安全设计与端到端检查见 [`../docs/SECURITY.md`](../docs/SECURITY.md)。

## 开发 / 自编译版

要跑自己改过的代码时，叠加 `compose.dev.yml` 从源码构建（Rust Core 首次编译约 5 分钟）：

```bash
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml build
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up -d
```

其余用法（WebView profile、参数）与正式版完全一致。
