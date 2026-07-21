import assert from "node:assert/strict";

const origin = String(process.env.YOMU_SMOKE_ORIGIN || "http://127.0.0.1:8080").replace(/\/+$/, "");
const adminUsername = String(process.env.YOMU_SMOKE_ADMIN_USERNAME || "");
const adminPassword = String(process.env.YOMU_SMOKE_ADMIN_PASSWORD || "");

if (!/^https?:\/\//.test(origin)) throw new Error("YOMU_SMOKE_ORIGIN must be an HTTP(S) origin");
if (!adminUsername || !adminPassword) throw new Error("Set YOMU_SMOKE_ADMIN_USERNAME and YOMU_SMOKE_ADMIN_PASSWORD");

class CookieJar {
  values = new Map();

  absorb(headers) {
    const entries = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    for (const entry of entries) {
      const [pair, ...attributes] = entry.split(";").map((part) => part.trim());
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (attributes.some((attribute) => attribute.toLowerCase() === "max-age=0")) this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  header() {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  value(name) {
    const value = this.values.get(name);
    return value === undefined ? "" : decodeURIComponent(value);
  }
}

async function request(path, { jar, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (jar?.header()) headers.set("cookie", jar.header());
  const response = await fetch(`${origin}${path}`, { redirect: "manual", ...options, headers });
  jar?.absorb(response.headers);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body, text };
}

function passed(name) {
  process.stdout.write(`✓ ${name}\n`);
}

function assertNoCredential(value) {
  const forbidden = new Set(["accesstoken", "token", "tokenmap", "securekey", "password", "salt"]);
  const visit = (entry) => {
    if (Array.isArray(entry)) return entry.forEach(visit);
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(forbidden.has(key.toLowerCase()), false, `credential field leaked: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

const shell = await request("/");
assert.equal(shell.response.status, 200);
assert.match(shell.response.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
assert.equal(shell.response.headers.get("x-frame-options"), "DENY");
passed("应用入口与浏览器安全头可用");

const clientAssetPath = shell.text.match(/["'](\/_app\/[^"']+\.js)["']/)?.[1];
assert.ok(clientAssetPath, "rendered shell should reference a namespaced client asset");
const clientAsset = await request(clientAssetPath);
assert.equal(clientAsset.response.status, 200);
assert.match(clientAsset.response.headers.get("content-type") || "", /javascript/);
assert.match(clientAsset.response.headers.get("cache-control") || "", /immutable/);
passed("前端资源通过独立命名空间和长期缓存提供");

const anonymous = await request("/auth/session");
assert.equal(anonymous.response.status, 401);
passed("未登录访问被拒绝");

const registration = await request("/reader3/login", {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ username: "attacker", password: "Attacker-password-2026", isLogin: false }),
});
assert.equal(registration.response.status, 404);
passed("公开注册与核心登录端点不可达");

const crossOriginLogin = await request("/auth/login", {
  method: "POST",
  headers: { origin: "https://evil.invalid", "content-type": "application/json" },
  body: JSON.stringify({ username: adminUsername, password: adminPassword }),
});
assert.equal(crossOriginLogin.response.status, 403);
passed("跨站登录请求被拒绝");

const adminJar = new CookieJar();
const login = await request("/auth/login", {
  jar: adminJar,
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ username: adminUsername, password: adminPassword }),
});
assert.equal(login.response.status, 200, login.text);
assert.equal(login.body?.data?.userInfo?.username, adminUsername);
assert.ok(adminJar.value("yomu_session"));
assert.ok(adminJar.value("yomu_csrf"));
assertNoCredential(login.body);
passed("管理员通过加密 Cookie 会话登录且令牌不下发浏览器");

const session = await request("/auth/session", { jar: adminJar });
assert.equal(session.response.status, 200, session.text);
assertNoCredential(session.body);
passed("刷新会话不会泄露核心凭据");

const directUserInfo = await request("/reader3/getUserInfo?accessToken=stolen&userNS=someone", { jar: adminJar });
assert.equal(directUserInfo.response.status, 200, directUserInfo.text);
assert.equal(directUserInfo.body?.data?.userInfo?.username, adminUsername);
assertNoCredential(directUserInfo.body);
passed("权限覆盖参数被剥离且账户响应被脱敏");

const noCsrf = await request("/reader3/changePassword", {
  jar: adminJar,
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ oldPassword: "wrong", newPassword: "Another-password-2026" }),
});
assert.equal(noCsrf.response.status, 403);

const wrongOrigin = await request("/reader3/changePassword", {
  jar: adminJar,
  method: "POST",
  headers: { origin: "https://evil.invalid", "x-yomu-csrf": adminJar.value("yomu_csrf"), "content-type": "application/json" },
  body: JSON.stringify({ oldPassword: "wrong", newPassword: "Another-password-2026" }),
});
assert.equal(wrongOrigin.response.status, 403);
passed("写操作同时校验 CSRF 令牌与精确来源");

const ai = await request("/reader3/ai/model/config", { jar: adminJar });
assert.equal(ai.response.status, 404);
passed("不需要的 AI 接口未暴露");

const traversal = await request("/assets/a%5cb", { jar: adminJar });
assert.equal(traversal.response.status, 400);
passed("编码路径穿越请求被拒绝");

const adminList = await request("/reader3/getUserList", { jar: adminJar });
assert.equal(adminList.response.status, 200, adminList.text);
assertNoCredential(adminList.body);
passed("管理员列表可用且不包含任何用户凭据");

const ssrf = await request("/reader3/readRemoteSourceFile", {
  jar: adminJar,
  method: "POST",
  headers: { origin, "x-yomu-csrf": adminJar.value("yomu_csrf"), "content-type": "application/json" },
  body: JSON.stringify({ url: "http://reader-core:18080/health" }),
});
assert.equal(ssrf.response.status, 400, ssrf.text);
passed("远程书源导入不能访问容器内网");

const readerUsername = `smoke${Date.now().toString(36)}`;
const readerPassword = "Reader-password-2026";
const addUser = await request("/reader3/addUser", {
  jar: adminJar,
  method: "POST",
  headers: { origin, "x-yomu-csrf": adminJar.value("yomu_csrf"), "content-type": "application/json" },
  body: JSON.stringify({ username: readerUsername, password: readerPassword }),
});
assert.equal(addUser.response.status, 200, addUser.text);
assert.equal(addUser.body?.isSuccess, true, addUser.text);
assertNoCredential(addUser.body);

const readerJar = new CookieJar();
const readerLogin = await request("/auth/login", {
  jar: readerJar,
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ username: readerUsername, password: readerPassword }),
});
assert.equal(readerLogin.response.status, 200, readerLogin.text);
const forbiddenAdmin = await request("/reader3/getUserList", { jar: readerJar });
assert.equal(forbiddenAdmin.response.status, 403, forbiddenAdmin.text);
passed("管理员可创建用户且普通用户不能越权访问管理接口");

const logout = await request("/auth/logout", {
  jar: readerJar,
  method: "POST",
  headers: { origin, "x-yomu-csrf": readerJar.value("yomu_csrf"), "content-type": "application/json" },
  body: "{}",
});
assert.equal(logout.response.status, 200, logout.text);
const afterLogout = await request("/auth/session", { jar: readerJar });
assert.equal(afterLogout.response.status, 401);
passed("退出登录立即撤销会话");

const cleanupUser = await request("/reader3/deleteUsers", {
  jar: adminJar,
  method: "POST",
  headers: { origin, "x-yomu-csrf": adminJar.value("yomu_csrf"), "content-type": "application/json" },
  body: JSON.stringify([readerUsername]),
});
assert.equal(cleanupUser.response.status, 200, cleanupUser.text);
assert.equal(cleanupUser.body?.isSuccess, true, cleanupUser.text);
passed("安全测试临时用户已清理");

process.stdout.write("Security smoke test passed.\n");
