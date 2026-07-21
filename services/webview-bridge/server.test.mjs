import test from "node:test";
import assert from "node:assert/strict";
import { isSafePublicUrl } from "./server.mjs";

test("allows public HTTP(S) source URLs", () => {
  assert.equal(isSafePublicUrl("https://example.com/books?q=1"), true);
  assert.equal(isSafePublicUrl("http://93.184.216.34/"), true);
});

test("blocks local and private targets", () => {
  for (const url of [
    "file:///etc/passwd",
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://10.0.0.4",
    "http://172.16.0.2",
    "http://192.168.1.2",
    "http://169.254.169.254/latest/meta-data",
    "http://user:password@93.184.216.34/",
    "http://service.localhost/",
    "http://224.0.0.1/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fec0::1]/",
  ]) assert.equal(isSafePublicUrl(url), false, url);
});
