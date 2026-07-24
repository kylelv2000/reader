# 部署指南

只需要 `compose.yml` 一个文件，**零配置**。镜像来自 Docker Hub（`komqaq/yomu-reader`）。

## 一键部署

```bash
mkdir yomu-reader && cd yomu-reader
curl -LO https://raw.githubusercontent.com/kylelv2000/reader/main/deploy/compose.yml
docker compose up -d
docker compose logs reader-core | grep admin   # 查看初始管理员密码
```

打开 `http://localhost:8080`，用 `admin` + 日志里的密码登录，然后在「用户」页改密码。

所有密钥自动生成并保存在数据卷里；忘记初始密码可随时执行
`docker compose exec reader-core cat /app/storage/data/initial-admin-password.txt`。

## 公网访问

用你习惯的方式（frp、Caddy、Nginx…）把流量转发到 `127.0.0.1:8080` 就行，**无需任何配置**。
唯一要求：反向代理需转发原始 `Host` 头（Caddy 默认如此；Nginx 加 `proxy_set_header Host $host;`）。
走 HTTPS 时（代理设置 `X-Forwarded-Proto: https`）Cookie 自动升级为 Secure 并启用 HSTS。

Caddy 示例（自动 HTTPS）：

```
reader.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## 常见调整（直接编辑 compose.yml，都有注释）

| 想做什么 | 改哪里 |
|----------|--------|
| 换端口 | `ports` 的 `8080` 改成别的 |
| 局域网直接访问 | `ports` 改成 `"8080:8080"` |
| 数据直接落盘 | 三处 `reader-storage` 卷改成绝对路径，如 `/srv/yomu-data` |
| WebView 书源 | 启动命令加 `--profile webview`（密钥自动共享） |

## 高级调参（可选，极少需要）

同目录新建 `compose.override.yml`（`docker compose up -d` 自动叠加）：

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
      REQUEST_TIMEOUT_SECS: "30"       # 抓取超时秒数（默认 30）
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

旧版 Reader Pro 迁移：把存储卷指向旧数据目录，首次启动自动迁移。安全设计见 [`../docs/SECURITY.md`](../docs/SECURITY.md)。

## 开发 / 自编译

```bash
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml build
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up -d
```
