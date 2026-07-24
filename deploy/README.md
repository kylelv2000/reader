# 部署指南

只需要 `compose.yml` 一个文件，**没有任何必填配置**。镜像从 Docker Hub（`komqaq/yomu-reader`）拉取。常驻服务两个：

- **yomu-app** — 网页界面 + 安全网关，唯一对外的服务
- **reader-core** — 书源抓取与数据存储（SQLite + 文件卷）

## 一键部署

```bash
mkdir yomu-reader && cd yomu-reader
curl -LO https://raw.githubusercontent.com/kylelv2000/reader/main/deploy/compose.yml
docker compose up -d
docker compose logs reader-core | grep admin   # 查看初始管理员密码
```

打开 `http://localhost:8080`，用 `admin` + 日志里的密码登录，然后在「用户」页改密码。

所有密钥自动生成并保存在数据卷里，重启不失效。

## 常见调整（直接编辑 compose.yml，都有注释）

| 想做什么 | 改哪里 |
|----------|--------|
| 公网部署 | `YOMU_PUBLIC_ORIGIN` 改成你的 https 域名，反向代理转发到 `127.0.0.1:8080` |
| 局域网访问 | `ports` 改成 `"8080:8080"` |
| 数据直接落盘 | 存储卷改成绝对路径，如 `/srv/yomu-data:/app/storage` |
| WebView 书源 | 启动命令加 `--profile webview`（密钥自动共享，无需配置） |
| 小内存机器 | `reader-core` 的 `mem_limit` 改成 `512m` |

Caddy 反向代理示例（自动 HTTPS）：

```
reader.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## 高级调参（可选）

极少需要。在 compose.yml 同目录新建 `compose.override.yml` 覆盖环境变量，`docker compose up -d` 会自动叠加：

```yaml
services:
  reader-core:
    environment:
      MAX_OUTBOUND_CONCURRENT: "64"    # 对外抓取全局并发池（默认 32）
      SCAN_SEARCH_CONCURRENT: "16"     # 换源扫描搜索路数（默认 12）
      SCAN_VALIDATE_CONCURRENT: "8"    # 换源扫描校验路数（默认 6）
      COVER_CONCURRENT: "8"            # 封面抓取并发（默认 8）
      SEARCH_SOURCE_LIMIT: "200"       # 单次搜索最多用的书源数（默认 200）
      USER_LIMIT: "50"                 # 用户数上限（默认 50）
      USER_BOOK_LIMIT: "2000"          # 每用户书籍上限（默认 2000）
      USER_SOURCE_LIMIT: "50"          # 每用户自有书源上限（默认 50，0 不限）
      REQUEST_TIMEOUT_SECS: "20"       # 抓取超时秒数（默认 20）
      LOG_LEVEL: "info"                # error / warn / info / debug
```

## 升级与备份

```bash
docker compose pull && docker compose up -d
```

数据全部在 `reader-storage` 卷里，备份它即可：

```bash
docker run --rm -v yomu-reader_reader-storage:/data -v "$PWD":/backup alpine tar czf /backup/yomu-backup.tar.gz -C /data .
```

忘记初始密码：`docker compose exec reader-core cat /app/storage/data/initial-admin-password.txt`。

旧版 Reader Pro 迁移：把存储卷指向旧数据目录，首次启动自动迁移。安全设计见 [`../docs/SECURITY.md`](../docs/SECURITY.md)。

## 开发 / 自编译

```bash
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml build
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up -d
```
