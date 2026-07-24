import assert from "node:assert/strict";
import test from "node:test";
import { applySecurityHeaders, isAllowedOrigin, openSession, parseCookies, redactSensitive, sanitizeProxyUrl, sealSession } from "./server.mjs";

const secret = "test-secret-that-is-longer-than-thirty-two-characters";

test("encrypts sessions and rejects tampering or expiry", () => {
  const sealed = sealSession("alice:opaque-token", secret, 1_000);
  assert.equal(openSession(sealed, secret, 2_000)?.token, "alice:opaque-token");
  assert.equal(openSession(`${sealed}x`, secret, 2_000), null);
  assert.equal(openSession(sealed, secret, 1_000 + 8 * 86_400_000), null);
});

test("parses cookie values without accepting malformed encoding", () => {
  assert.deepEqual(parseCookies("a=1; yomu_csrf=hello%20world; broken=%ZZ"), { a: "1", yomu_csrf: "hello world" });
});

test("origin must match the request host exactly", () => {
  assert.equal(isAllowedOrigin("https://reader.example.com", "reader.example.com"), true);
  assert.equal(isAllowedOrigin("https://evil.example", "reader.example.com"), false);
  assert.equal(isAllowedOrigin("http://localhost:8080", "localhost:8080"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:9101", "127.0.0.1:9101"), true);
  assert.equal(isAllowedOrigin("http://localhost:8080", "localhost:9999"), false);
  assert.equal(isAllowedOrigin("", "reader.example.com"), false);
  assert.equal(isAllowedOrigin("https://reader.example.com", ""), false);
  assert.equal(isAllowedOrigin("not-a-url", "reader.example.com"), false);
});

test("strips privilege override parameters and blocks traversal", () => {
  assert.equal(
    sanitizeProxyUrl("/reader3/getBookshelf?accessToken=stolen&secureKey=guess&userNS=bob&refresh=1"),
    "/reader3/getBookshelf?refresh=1",
  );
  assert.throws(() => sanitizeProxyUrl("/assets/%2e%2e/secrets"), /INVALID_PATH/);
  assert.throws(() => sanitizeProxyUrl("/assets/a%5cb"), /INVALID_PATH/);
});

test("removes credentials recursively from account responses", () => {
  assert.deepEqual(redactSensitive({
    accessToken: "secret",
    userInfo: { username: "alice", tokenMap: { secret: 1 }, salt: "legacy" },
    users: [{ username: "bob", password: "hash", enableWebdav: false }],
  }), {
    userInfo: { username: "alice" },
    users: [{ username: "bob", enableWebdav: false }],
  });
});

test("browser policy blocks direct source images and media", () => {
  const headers = new Map();
  applySecurityHeaders({ setHeader: (name, value) => headers.set(name, value) }, true);
  const policy = headers.get("content-security-policy");
  assert.match(policy, /img-src 'self' data:/);
  assert.match(policy, /media-src 'self' data: blob:/);
  assert.doesNotMatch(policy, /img-src[^;]*https:/);
  assert.match(policy, /connect-src 'self'/);
});
