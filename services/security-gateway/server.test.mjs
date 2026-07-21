import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedOrigin, openSession, parseCookies, redactSensitive, sanitizeProxyUrl, sealSession } from "./server.mjs";

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

test("requires the configured same origin in production", () => {
  assert.equal(isAllowedOrigin("https://reader.example.com", "https://reader.example.com", "production"), true);
  assert.equal(isAllowedOrigin("https://evil.example", "https://reader.example.com", "production"), false);
  assert.equal(isAllowedOrigin("http://localhost:3000", "", "test"), true);
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
