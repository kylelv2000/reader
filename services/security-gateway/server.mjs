import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { handleWebRequest } from "../web-runtime/server.mjs";

const port = Number(process.env.PORT || 18081);
const coreOrigin = new URL(process.env.READER_CORE_ORIGIN || "http://reader-core:18080");
const sessionSecret = process.env.YOMU_SESSION_SECRET || "";
const publicOrigin = (process.env.YOMU_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
const secureCookies = process.env.YOMU_COOKIE_SECURE !== "false";
const sessionTtlSeconds = Math.max(900, Number(process.env.YOMU_SESSION_TTL_SECONDS || 7 * 86_400));
const standardBodyLimit = Math.max(64 * 1024, Number(process.env.YOMU_MAX_BODY_BYTES || 2 * 1024 * 1024));
const uploadBodyLimit = Math.max(standardBodyLimit, Number(process.env.YOMU_MAX_UPLOAD_BYTES || 100 * 1024 * 1024));
const sessionCookieName = "yomu_session";
const csrfCookieName = "yomu_csrf";
const loginAttempts = new Map();

function applySecurityHeaders(response, appShell = false) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("x-frame-options", "DENY");
  if (secureCookies) response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  if (appShell) {
    response.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'");
  }
}

const adminPaths = new Set([
  "/reader3/getUserList",
  "/reader3/addUser",
  "/reader3/updateUser",
  "/reader3/deleteUsers",
  "/reader3/resetPassword",
]);

function keyFromSecret(secret) {
  return createHash("sha256").update(secret).digest();
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function sealSession(token, secret, now = Date.now()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const payload = Buffer.from(JSON.stringify({ token, exp: now + sessionTtlSeconds * 1000 }));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return `${base64url(iv)}.${base64url(cipher.getAuthTag())}.${base64url(ciphertext)}`;
}

export function openSession(value, secret, now = Date.now()) {
  try {
    const [ivValue, tagValue, dataValue] = String(value || "").split(".");
    if (!ivValue || !tagValue || !dataValue) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyFromSecret(secret), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataValue, "base64url")),
      decipher.final(),
    ]);
    const payload = JSON.parse(plaintext.toString("utf8"));
    return typeof payload.token === "string" && payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}

export function parseCookies(raw = "") {
  return Object.fromEntries(raw.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    try {
      return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
    } catch {
      return [];
    }
  }));
}

function cookie(name, value, { httpOnly = false, maxAge = sessionTtlSeconds } = {}) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Strict",
    secureCookies ? "Secure" : "",
    httpOnly ? "HttpOnly" : "",
  ].filter(Boolean).join("; ");
}

function clearCookies(rawCookie = "") {
  const sourceCookies = rawCookie.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim();
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || lower.startsWith("yomu_") || lower.startsWith("__host-") || lower.startsWith("__secure-")) return [];
    return [`${name}=; Path=/reader3/bookSourceProxy; Max-Age=0; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}`];
  });
  return [
    cookie(sessionCookieName, "", { httpOnly: true, maxAge: 0 }),
    cookie(csrfCookieName, "", { maxAge: 0 }),
    ...sourceCookies,
  ];
}

function json(response, status, data, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(data));
}

async function readBody(request, limit) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > limit) throw new Error("REQUEST_TOO_LARGE");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function streamingBody(request, limit) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > limit) throw new Error("REQUEST_TOO_LARGE");
  return Readable.from((async function* limited() {
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw new Error("REQUEST_TOO_LARGE");
      yield chunk;
    }
  })());
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function isAllowedOrigin(origin, configuredOrigin = publicOrigin, environment = process.env.NODE_ENV) {
  if (!origin) return false;
  if (configuredOrigin && origin === configuredOrigin) return true;
  if (environment !== "production") {
    try {
      const url = new URL(origin);
      return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

export function sanitizeProxyUrl(requestUrl) {
  const rawPath = String(requestUrl).split("?", 1)[0];
  for (const segment of rawPath.split("/")) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new Error("INVALID_PATH"); }
    if ([".", ".."].includes(decoded) || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      throw new Error("INVALID_PATH");
    }
  }
  const url = new URL(requestUrl, "http://gateway.invalid");
  for (const segment of url.pathname.split("/")) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new Error("INVALID_PATH"); }
    if ([".", ".."].includes(decoded) || decoded.includes("\\") || decoded.includes("\0")) {
      throw new Error("INVALID_PATH");
    }
  }
  for (const key of [...url.searchParams.keys()]) {
    if (["accesstoken", "securekey", "userns"].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}`;
}

function clientAddress(request) {
  return String(request.headers["x-real-ip"] || request.socket.remoteAddress || "unknown").slice(0, 128);
}

function loginLimited(key, maximum = 5, now = Date.now()) {
  for (const [entry, value] of loginAttempts) {
    if (value.resetAt <= now) loginAttempts.delete(entry);
  }
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) return false;
  return current.count >= maximum;
}

function recordLoginFailure(key, now = Date.now()) {
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
  else current.count += 1;
}

async function coreJson(path, { method = "GET", token, body } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, coreOrigin), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`CORE_${response.status}`);
  return response.json();
}

async function currentUser(token) {
  const envelope = await coreJson("/reader3/getUserInfo", { token });
  if (!envelope?.isSuccess || !envelope.data?.userInfo) return null;
  const safeUser = { ...envelope.data.userInfo };
  delete safeUser.accessToken;
  return { ...envelope.data, userInfo: safeUser };
}

function requireSession(request) {
  const cookies = parseCookies(request.headers.cookie);
  const session = openSession(cookies[sessionCookieName], sessionSecret);
  return { cookies, session };
}

function requireCsrf(request, cookies) {
  return isAllowedOrigin(request.headers.origin) && safeEqual(cookies[csrfCookieName], request.headers["x-yomu-csrf"]);
}

async function handleLogin(request, response) {
  if (!isAllowedOrigin(request.headers.origin)) return json(response, 403, { isSuccess: false, errorMsg: "请求来源无效" });
  let credentials;
  try {
    credentials = JSON.parse((await readBody(request, 32 * 1024)).toString("utf8"));
  } catch (error) {
    return json(response, error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400, { isSuccess: false, errorMsg: "登录请求无效" });
  }
  const username = String(credentials.username || "").trim().toLowerCase();
  const password = String(credentials.password || "");
  const address = clientAddress(request);
  const rateKey = `account\0${address}\0${username}`;
  const addressKey = `address\0${address}`;
  if (loginLimited(rateKey, 5) || loginLimited(addressKey, 20)) return json(response, 429, { isSuccess: false, errorMsg: "尝试次数过多，请稍后再试" });
  if (!/^[a-z0-9]{5,32}$/.test(username) || password.length < 8 || password.length > 128) {
    recordLoginFailure(rateKey);
    recordLoginFailure(addressKey);
    return json(response, 401, { isSuccess: false, errorMsg: "用户名或密码错误" });
  }
  try {
    const envelope = await coreJson("/reader3/login", {
      method: "POST",
      body: { username, password, isLogin: true },
    });
    const token = envelope?.isSuccess ? envelope.data?.accessToken : "";
    if (!token) {
      recordLoginFailure(rateKey);
      recordLoginFailure(addressKey);
      return json(response, 401, { isSuccess: false, errorMsg: "用户名或密码错误" });
    }
    loginAttempts.delete(rateKey);
    const csrf = randomBytes(32).toString("base64url");
    const safeData = await currentUser(token);
    return json(response, 200, { isSuccess: true, data: safeData }, {
      "set-cookie": [...clearCookies(request.headers.cookie), cookie(sessionCookieName, sealSession(token, sessionSecret), { httpOnly: true }), cookie(csrfCookieName, csrf)],
    });
  } catch {
    recordLoginFailure(rateKey);
    recordLoginFailure(addressKey);
    return json(response, 503, { isSuccess: false, errorMsg: "登录服务暂时不可用" });
  }
}

async function handleSession(request, response) {
  const { session } = requireSession(request);
  if (!session) return json(response, 401, { isSuccess: false, data: "NEED_LOGIN", errorMsg: "请登录" }, { "set-cookie": clearCookies(request.headers.cookie) });
  try {
    const data = await currentUser(session.token);
    if (!data) return json(response, 401, { isSuccess: false, data: "NEED_LOGIN", errorMsg: "登录已过期" }, { "set-cookie": clearCookies(request.headers.cookie) });
    return json(response, 200, { isSuccess: true, data });
  } catch {
    return json(response, 503, { isSuccess: false, errorMsg: "账户服务暂时不可用" });
  }
}

async function handleLogout(request, response) {
  const { cookies, session } = requireSession(request);
  if (!requireCsrf(request, cookies)) return json(response, 403, { isSuccess: false, errorMsg: "安全校验失败" });
  if (session) await coreJson("/reader3/logout", { method: "POST", token: session.token }).catch(() => undefined);
  return json(response, 200, { isSuccess: true, data: null }, { "set-cookie": clearCookies(request.headers.cookie) });
}

function sourceCookieHeader(raw = "") {
  return raw.split(";").map((part) => part.trim()).filter((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return false;
    const name = part.slice(0, separator).trim().toLowerCase();
    return !name.startsWith("yomu_") && !name.startsWith("__host-") && !name.startsWith("__secure-");
  }).join("; ");
}

function requestHeaders(request, token, forwardSourceCookies = false) {
  const headers = new Headers();
  for (const name of ["accept", "accept-language", "content-type", "range", "if-none-match", "if-modified-since", "last-event-id"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${token}`);
  headers.set("x-forwarded-for", clientAddress(request));
  if (forwardSourceCookies) {
    const cookies = sourceCookieHeader(request.headers.cookie);
    if (cookies) headers.set("cookie", cookies);
  }
  return headers;
}

function safeSourceCookies(upstream) {
  const raw = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
  return raw.flatMap((entry) => {
    const pair = entry.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 1) return [];
    const name = pair.slice(0, separator).trim();
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || lower.startsWith("yomu_") || lower.startsWith("__host-") || lower.startsWith("__secure-")) return [];
    return [`${pair}; Path=/reader3/bookSourceProxy; Max-Age=3600; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}`];
  });
}

function responseHeaders(upstream, forwardSourceCookies = false) {
  const headers = {};
  for (const name of ["content-type", "content-disposition", "content-length", "etag", "last-modified", "accept-ranges", "content-range"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  headers["cache-control"] = "private, no-store";
  headers["x-content-type-options"] = "nosniff";
  if (forwardSourceCookies) {
    const cookies = safeSourceCookies(upstream);
    if (cookies.length) headers["set-cookie"] = cookies;
  }
  return headers;
}

const sensitiveResponseKeys = new Set(["accesstoken", "token", "tokenmap", "password", "salt", "securekey"]);

export function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
    sensitiveResponseKeys.has(key.toLowerCase()) ? [] : [[key, redactSensitive(entry)]]));
}

async function proxyCore(request, response) {
  let path;
  try { path = sanitizeProxyUrl(request.url || "/"); } catch { return json(response, 400, { isSuccess: false, errorMsg: "请求路径无效" }); }
  const pathname = path.split("?")[0];
  if (pathname === "/reader3/login" || pathname.startsWith("/reader3/ai/")) return json(response, 404, { isSuccess: false, errorMsg: "未找到" });
  const { cookies, session } = requireSession(request);
  if (!session) return json(response, 401, { isSuccess: false, data: "NEED_LOGIN", errorMsg: "请登录" }, { "set-cookie": clearCookies(request.headers.cookie) });
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method || "GET")) {
    const proxyForm = ["/reader3/bookSourceProxy", "/reader3/bookSourceClientLog"].includes(pathname);
    const validMutation = proxyForm ? isAllowedOrigin(request.headers.origin) : requireCsrf(request, cookies);
    if (!validMutation) return json(response, 403, { isSuccess: false, errorMsg: "安全校验失败" });
  }
  if (adminPaths.has(pathname)) {
    try {
      const user = await currentUser(session.token);
      if (!user?.adminAuthorized) return json(response, 403, { isSuccess: false, errorMsg: "需要管理员权限" });
    } catch {
      return json(response, 503, { isSuccess: false, errorMsg: "权限校验暂时不可用" });
    }
  }

  const isUpload = /upload|import/i.test(pathname);
  let body;
  try {
    if (!["GET", "HEAD"].includes(request.method || "GET")) {
      body = isUpload ? streamingBody(request, uploadBodyLimit) : await readBody(request, standardBodyLimit);
    }
  } catch {
    return json(response, 413, { isSuccess: false, errorMsg: "请求内容过大" });
  }
  try {
    const streamBody = body instanceof Readable;
    const upstream = await fetch(new URL(path, coreOrigin), {
      method: request.method,
      headers: requestHeaders(request, session.token, pathname === "/reader3/bookSourceProxy"),
      body: streamBody || body?.length ? body : undefined,
      ...(streamBody ? { duplex: "half" } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(pathname.endsWith("SSE") ? 30 * 60_000 : 120_000),
    });
    if (pathname === "/reader3/getUserInfo" || adminPaths.has(pathname)) {
      const data = await upstream.json().catch(() => null);
      if (data === null) return json(response, 502, { isSuccess: false, errorMsg: "账户响应无效" });
      return json(response, upstream.status, redactSensitive(data));
    }
    response.writeHead(upstream.status, responseHeaders(upstream, pathname === "/reader3/bookSourceProxy"));
    if (!upstream.body || request.method === "HEAD") return response.end();
    for await (const chunk of upstream.body) response.write(chunk);
    response.end();
  } catch (error) {
    if (error instanceof Error && error.message === "REQUEST_TOO_LARGE" && !response.headersSent) {
      return json(response, 413, { isSuccess: false, errorMsg: "请求内容过大" });
    }
    if (!response.headersSent) return json(response, 502, { isSuccess: false, errorMsg: "阅读服务暂时不可用" });
    response.destroy();
  }
}

export const server = createServer(async (request, response) => {
  const isPrivatePath = /^\/(auth|reader3|epub|local-book|uploads|assets)(\/|$)/.test(request.url || "");
  applySecurityHeaders(response, !isPrivatePath);
  if (request.url === "/health" && request.method === "GET") return json(response, 200, { ok: true });
  if (request.url === "/auth/login" && request.method === "POST") return handleLogin(request, response);
  if (request.url === "/auth/session" && request.method === "GET") return handleSession(request, response);
  if (request.url === "/auth/logout" && request.method === "POST") return handleLogout(request, response);
  if (/^\/(reader3|epub|local-book|uploads|assets)(\/|$)/.test(request.url || "")) return proxyCore(request, response);
  return handleWebRequest(request, response);
});

if (process.env.NODE_ENV !== "test") {
  if (sessionSecret.length < 32) throw new Error("YOMU_SESSION_SECRET must contain at least 32 characters");
  server.listen(port, "0.0.0.0");
}
