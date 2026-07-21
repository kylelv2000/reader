# 小规模自托管

默认部署面向个人和少量用户，常驻服务只有两个：`yomu-app` 同时提供 PWA、同源安全网关与安全响应头，`reader-core` 负责书源和持久数据。只有 App 绑定宿主机回环端口，Core 不对外开放。首次管理员初始化是一次性任务，不是常驻容器。

```bash
cp deploy/.env.example deploy/.env
# 修改公开 HTTPS 地址，并用 `openssl rand -hex 32` 分别生成会话密钥、管理密钥和邀请码
docker compose --env-file deploy/.env -f deploy/compose.yml pull
docker compose --env-file deploy/.env -f deploy/compose.yml up -d reader-core

# 首次部署只运行一次：在容器内网创建首位管理员，不开放网页注册
read -r "YOMU_ADMIN_USERNAME?管理员用户名（5–32 位小写字母或数字）: "
read -rs "YOMU_ADMIN_PASSWORD?管理员密码（至少 12 位）: "; echo
export YOMU_ADMIN_USERNAME YOMU_ADMIN_PASSWORD
docker compose --env-file deploy/.env -f deploy/compose.yml --profile setup run --rm admin-init
unset YOMU_ADMIN_PASSWORD

docker compose --env-file deploy/.env -f deploy/compose.yml up -d
```

也可以让仓库内脚本一次性生成权限为 `0600` 的生产配置，密钥只写入文件且不会打印：

```bash
python3 scripts/prepare-deploy-env.py \
  --output deploy/.env \
  --origin https://reader.example.com \
  --port 8080 \
  --storage /absolute/path/to/reader-storage
```

生产环境通过 `YOMU_PUBLIC_ORIGIN` 填写的 HTTPS 域名访问。若外层已有反向代理，只把它连接到 Yomu 的 `8080` 端口；防火墙不要暴露 Core 或 WebView。只有本机临时测试时才可把 `YOMU_PUBLIC_ORIGIN` 改成 `http://localhost:8080` 并设置 `YOMU_COOKIE_SECURE=false`。

持久数据默认位于 Docker volume `reader-storage`。升级前应备份该 volume；对个人实例，SQLite + 文件目录比引入独立数据库和缓存服务更省内存也更容易恢复。若要原位迁移旧 Reader Pro，可先完整备份旧目录，再在 `deploy/.env` 中把 `READER_STORAGE` 设置为旧数据目录的绝对路径；新版会自动迁移旧用户和继续读取原书架。旧版 `bookSource.json` 可在核心首次启动后用 `scripts/migrate-reader-pro.py` 事务导入。

生产 Compose 只从 Docker Hub 的 `komqaq/yomu-reader` 拉取预编译 amd64 镜像，服务器不会现场下载源码、安装依赖或编译。Rust Core 的固定源码已纳入本仓库。公开注册和 AI API 在外部入口关闭；管理员直接凭管理员账户管理用户，不把 `SECURE_KEY` 交给浏览器。需要真实 WebView 的书源才启用附加配置，避免普通阅读时常驻浏览器进程。

App 生产容器只携带构建结果和运行期代码，不包含构建工具目录；默认两个服务均以非 root 身份运行。部署后可按 [`../docs/SECURITY.md`](../docs/SECURITY.md) 的命令执行端到端安全检查。

## 需要 WebView 的书源

默认部署不启动浏览器。确认书源规则使用 `webView` / `webJs` 后，为 `WEBVIEW_BRIDGE_KEY` 生成随机长密钥，再用附加配置启动一个内含 Chromium 的 WebView 容器：

```bash
docker compose --env-file deploy/.env \
  -f deploy/compose.yml \
  -f deploy/compose.webview.yml \
  pull
docker compose --env-file deploy/.env \
  -f deploy/compose.yml \
  -f deploy/compose.webview.yml \
  up -d
```

只有规则明确要求 WebView 时，Core 才把这一次抓取转给浏览器旁车。旁车默认只开一个页面，限制脚本时间和响应大小，屏蔽图片/媒体/字体，拒绝 localhost、内网和云元数据地址；Chromium 不开放调试端口，空闲后自动退出。

升级、备份、密钥轮换与安全检查见 [`../docs/SECURITY.md`](../docs/SECURITY.md)。

普通 HTTP 书源始终走 Rust/Reqwest，不会唤醒浏览器。停止 WebView 组件并回到低内存模式：

```bash
docker compose --env-file deploy/.env \
  -f deploy/compose.yml \
  -f deploy/compose.webview.yml \
  down
docker compose --env-file deploy/.env -f deploy/compose.yml up -d
```
