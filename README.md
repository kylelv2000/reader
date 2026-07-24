# Yomu 轻阅读

Yomu 是一个现代、轻量、可自托管的 Reader 3 兼容阅读器。目标不是删掉旧 Reader 的复杂能力，而是把复杂度放到更合适的位置：服务器负责规则解析、账户、书架、进度、缓存和兼容层；网页/PWA 负责安静、快速、低耗电的阅读体验。

Web 端采用同源私有部署：访问自己的 Yomu 域名后只需登录，不需要再填写服务器地址。公开注册默认关闭，新用户由管理员后台创建；浏览器不会保存 Reader 令牌或管理密钥。安装为 PWA 后可整本下载，并能在完全断网、重新打开应用的情况下继续阅读。

## 本地运行

```bash
npm install
npm run dev
```

仅开发界面时可打开 `http://localhost:3000`；完整登录和数据功能需要按下方 Compose 方案同时运行 Yomu App 与 Reader Core。生产环境必须使用 HTTPS。

## 目标架构

- PWA：React + TypeScript，使用动态单视口布局，负责界面、排版、手势与设备离线缓存；根页面不滚动，内容区和阅读区各自滚动。
- Yomu App：同一非 root Node 进程提供 PWA、压缩静态资源、安全响应头、同源登录、HttpOnly 加密会话、CSRF/Origin 校验、登录限速、管理员路由复核与请求限制。
- Reader Core：Rust 源码直接属于本项目并由发布流水线编译；生产服务器只拉取镜像。公开注册和 AI 路由关闭，密码使用 Argon2id。
- WebView Sidecar：可选、按需启动，只服务于必须执行浏览器脚本或登录的书源。
- 存储：面向个人和少量用户，默认 SQLite WAL + 文件目录，不引入不必要的分布式组件。

完整边界见 [架构说明](./docs/ARCHITECTURE.md)，功能完成度见 [功能清单](./docs/FEATURES.md)，安全假设与运维要求见 [安全说明](./docs/SECURITY.md)。

## 自托管

一键部署——下载一个 Compose 文件即可，无需任何配置（密钥自动生成、首次启动自动创建管理员）：

```bash
mkdir yomu-reader && cd yomu-reader
curl -LO https://raw.githubusercontent.com/kylelv2000/reader/main/deploy/compose.yml
docker compose up -d
docker compose logs reader-core | grep admin   # 查看初始管理员密码
```

打开 `http://localhost:8080` 登录。公网域名、参数调优等见 [部署指南](./deploy/README.md)。正式镜像发布在 Docker Hub 的 `komqaq/yomu-reader`，升级只需 `docker compose pull && docker compose up -d`。

Yomu 不内置或分发任何书籍内容。用户应只添加有合法访问权的书源和本地文件。
