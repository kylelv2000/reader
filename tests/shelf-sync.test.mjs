import assert from "node:assert/strict";
import test from "node:test";
import { createShelfSync } from "../app/shelf-sync.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("refresh response cannot erase a book added while it was in flight", async () => {
  const sync = createShelfSync();
  const pending = deferred();
  const modes = [];
  let shelf = ["A"];
  const result = sync.load((refresh) => {
    modes.push(refresh);
    return modes.length === 1 ? pending.promise : Promise.resolve(["A", "B"]);
  }, (books) => { shelf = books; }, true);
  sync.changed();
  shelf = ["A", "B"];
  pending.resolve(["A"]);
  await result;
  assert.deepEqual(shelf, ["A", "B"]);
  assert.deepEqual(modes, [true, false]);
});

test("stale responses cannot resurrect deleted books or overwrite a source switch", async () => {
  for (const latest of [["A"], ["A-new-source", "B"]]) {
    const sync = createShelfSync();
    const pending = deferred();
    let count = 0;
    let shelf = latest;
    const result = sync.load(() => ++count === 1 ? pending.promise : Promise.resolve(latest),
      (books) => { shelf = books; });
    sync.changed();
    pending.resolve(["A", "B"]);
    await result;
    assert.deepEqual(shelf, latest);
  }
});

test("only the newest request may apply, and logout cancels outstanding loads", async () => {
  const sync = createShelfSync();
  const pending = deferred();
  let shelf = [];
  const older = sync.load(() => pending.promise, (books) => { shelf = books; });
  await sync.load(() => Promise.resolve(["new"]), (books) => { shelf = books; });
  pending.resolve(["old"]);
  assert.equal(await older, null);
  assert.deepEqual(shelf, ["new"]);
  const logout = deferred();
  const loading = sync.load(() => logout.promise, (books) => { shelf = books; });
  sync.cancel();
  shelf = [];
  logout.resolve(["private books"]);
  assert.equal(await loading, null);
  assert.deepEqual(shelf, []);
});
