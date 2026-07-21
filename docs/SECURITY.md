# Yomu 安全说明

Yomu 面向个人和少量受信用户，但按公网服务处理安全边界。没有软件能承诺“绝对没有漏洞”；这里记录已经落地的防线、仍需管理员承担的运维责任，以及升级时不可破坏的约束。

## 已实现的边界

- **默认拒绝访问**：页面先检查同源会话，未登录时不加载书架、书源或用户数据。公开注册关闭，首位管理员通过容器内网一次性初始化，之后新账号只由管理员后台创建。
- **浏览器不持有 Reader 令牌**：安全网关把上游令牌装进 AES-256-GCM 加密的 `HttpOnly + Secure + SameSite=Strict` Cookie。所有外部请求中的 `accessToken`、`secureKey`、`userNS`、`Authorization` 和覆盖头都会被丢弃，再由网关注入当前会话身份。
- **写操作防伪造**：普通写请求同时要求同源 `Origin` 和双提交 CSRF 值。书源代理表单因浏览器无法添加自定义头，使用严格同源 Origin 校验；登录 Cookie 仍为 SameSite。
- **管理员再鉴权**：用户列表、创建、删除、权限修改和密码重置在网关与 Core 两层检查管理员身份。管理密钥只存在服务器环境，不进入 HTML、URL、Local Storage 或前端日志。
- **密码与会话**：新密码要求 12–128 位并使用 Argon2id。旧 Reader 快速摘要仅用于兼容验证，成功登录后立即重哈希。登录按来源和用户名限速；会话有固定过期时间，修改密码会撤销其他会话。
- **用户隔离**：Core 从已验证令牌推导用户命名空间；客户端无法指定其他 `userNS`。浏览器离线缓存键同时包含站点与用户名，退出会清除当前用户的本机缓存、认证和书源代理 Cookie。
- **文件安全**：资产与 WebDAV 文件名拒绝绝对路径、`..`、反斜杠、NUL 和异常组件；上传、代理响应、书源响应及封面均有限额。数据库访问沿用 SQLx 参数绑定。
- **出站请求**：普通书源、RSS、封面和登录代理只接受 HTTP(S)，拒绝嵌入凭据、回环、私网、链路本地、保留地址、`.local` 和解析到这些地址的域名。WebView 对每个页面子请求重复检查，并限制并发、脚本时间与页面大小。
- **网络与浏览器**：只有 Yomu App 绑定宿主机回环端口；Core 与可选 WebView 只在 Compose 内网可见。App 关闭宽泛 CORS 并设置 CSP、禁止框架嵌入、MIME 嗅探、跨域资源读取和无关设备权限。默认栈使用非 root、只读根文件系统（持久卷除外）、`no-new-privileges` 和 capability 清空。
- **隐私日志**：书源抓取不再打印请求正文，登录代理不记录响应正文预览。错误响应不向用户返回内部堆栈、数据库细节或密钥。

## 离线数据的安全边界

离线书籍保存在浏览器按同源隔离的 IndexedDB 中，Service Worker 不缓存任何 API、Cookie 或私有响应。它不会把服务端令牌写到磁盘，也不会让另一个 Yomu 域名或用户名通过产品接口读取当前命名空间。

离线正文目前不做应用层静态加密：已经解锁的浏览器配置、被攻破的设备或同一系统账号下的浏览器调试权限仍可能读取它。这与多数离线阅读 App 的本地文件边界相同，因此只应在可信个人设备使用，并启用系统锁屏、磁盘加密和独立系统账号；共享设备上应退出登录，退出会删除当前用户的 Yomu 离线缓存。服务器磁盘和备份仍应单独加密。

## 部署必须完成

1. 只通过 HTTPS 域名提供服务；`YOMU_PUBLIC_ORIGIN` 必须与浏览器地址完全一致，生产保持 `YOMU_COOKIE_SECURE=true`。
2. 为 `YOMU_SESSION_SECRET`、`READER_SECURE_KEY`、`READER_INVITE_CODE`、WebView 密钥分别生成不同的随机值。不要把 `deploy/.env` 提交到 Git；首次管理员创建后立即清除终端中的临时密码变量。
3. 防火墙只开放反向代理的 80/443（或既有入口），不要映射 Core、WebView、Chromium 或 SQLite 端口。
4. 定期备份 `reader-storage`，备份文件加密并限制读取权限；恢复演练在隔离机器进行。
5. 每月检查基础镜像和依赖安全更新。升级固定标签后必须重新执行 Rust 测试与构建、网关测试、PWA 构建和 Compose 配置验证。
6. 只导入可信来源的书源规则。书源本质上允许服务器代表用户访问第三方网站；即使有 SSRF 与 WebView 隔离，也不应把未知规则当作无害数据。

## 可重复验证

静态与单元检查运行 `npm run typecheck && npm run lint && npm test`、`npm --prefix services/security-gateway test` 和 `npm --prefix services/webview-bridge test`。启动隔离实例并初始化管理员后，可用下列命令验证完整外部安全边界：

```bash
YOMU_SMOKE_ORIGIN=https://reader.example.com \
YOMU_SMOKE_ADMIN_USERNAME=admin01 \
YOMU_SMOKE_ADMIN_PASSWORD='只在当前终端提供的密码' \
npm run test:security:smoke
```

脚本会创建并在结束时删除一个临时普通用户。不要在共享 CI 日志中写入真实管理员密码。

## 事件处理

怀疑令牌或密钥泄露时：先停止公网入口，轮换 `YOMU_SESSION_SECRET`（会让所有网页登录失效）、`READER_SECURE_KEY` 和 WebView 密钥，重置相关用户密码，检查 App/Core 日志中的异常来源与用户操作，再用已知安全备份核对持久数据。不要把含 Cookie、书源账号或请求正文的日志发到公开问题区。
