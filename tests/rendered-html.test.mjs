import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const request = new Request("http://localhost/", { headers: { accept: "text/html" } });
  if (typeof worker === "function") return worker(request);
  return worker.fetch(request, undefined, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the private Yomu login gate", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Yomu 轻阅读(?: · Yomu)?<\/title>/i);
  assert.match(html, /<h1>正在连接<\/h1>/);
  assert.match(html, /无账号请联系管理员/);
  assert.match(html, /\/_app\/[^"']+\.js/);
  assert.doesNotMatch(html, /<label>\s*(邀请码|服务器地址|管理密钥)/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("ships installable PWA metadata", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /Yomu/);
});
