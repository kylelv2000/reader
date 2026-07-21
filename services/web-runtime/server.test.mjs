import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { safeClientPath } from "./server.mjs";

const root = "/srv/yomu/client";

test("resolves only files beneath the immutable client root", () => {
  assert.equal(safeClientPath("/_app/app.js", root), path.join(root, "_app/app.js"));
  assert.throws(() => safeClientPath("/_app/%2e%2e/secrets", root), /INVALID_PATH/);
  assert.throws(() => safeClientPath("/_app/a%2fb", root), /INVALID_PATH/);
  assert.throws(() => safeClientPath("/_app/a%5cb", root), /INVALID_PATH/);
  assert.throws(() => safeClientPath("//evil.invalid/file", root), /INVALID_PATH/);
});
