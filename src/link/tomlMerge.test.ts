import { test } from "node:test";
import assert from "node:assert/strict";

import { formatKeyPath, mergeOwnedToml } from "./tomlMerge.js";

test("mergeOwnedToml, when the destination is empty, writes the owned keys", () => {
  const merge = mergeOwnedToml({ current: "", owned: "foo = 1\n", previouslyOwned: [] });
  assert.equal(merge.text, "foo = 1\n");
});

test("mergeOwnedToml keeps keys only the destination sets", () => {
  const merge = mergeOwnedToml({ current: "bar = 2\n", owned: "foo = 1\n", previouslyOwned: [] });
  assert.equal(merge.text, "bar = 2\nfoo = 1\n");
});

test("mergeOwnedToml, when both set a key, keeps the owned value and reports it", () => {
  const merge = mergeOwnedToml({ current: "foo = 2\n", owned: "foo = 1\n", previouslyOwned: [] });
  assert.equal(merge.text, "foo = 1\n");
  assert.deepEqual(merge.overwritten, [["foo"]]);
});

test("mergeOwnedToml, when both set a key to the same value, reports nothing", () => {
  const merge = mergeOwnedToml({ current: "foo = 1\n", owned: "foo = 1\n", previouslyOwned: [] });
  assert.deepEqual(merge.overwritten, []);
});

test("mergeOwnedToml merges tables leaf by leaf", () => {
  const merge = mergeOwnedToml({
    current: "[foo]\nbar = 2\n",
    owned: "[foo]\nbaz = 1\n",
    previouslyOwned: [],
  });
  assert.equal(merge.text, "[foo]\nbar = 2\nbaz = 1\n");
});

test("mergeOwnedToml, when the destination has a leaf where a table is owned, replaces it", () => {
  const merge = mergeOwnedToml({
    current: "foo = 2\n",
    owned: "[foo]\nbar = 1\n",
    previouslyOwned: [],
  });
  assert.equal(merge.text, "[foo]\nbar = 1\n");
});

test("mergeOwnedToml replaces arrays whole", () => {
  const merge = mergeOwnedToml({
    current: "foo = [1, 2]\n",
    owned: "foo = [3]\n",
    previouslyOwned: [],
  });
  assert.equal(merge.text, "foo = [ 3 ]\n");
});

test("mergeOwnedToml removes a key it owned before and no longer owns", () => {
  const merge = mergeOwnedToml({
    current: "foo = 1\nbar = 2\n",
    owned: "foo = 1\n",
    previouslyOwned: [["foo"], ["bar"]],
  });
  assert.equal(merge.text, "foo = 1\n");
});

test("mergeOwnedToml drops a table emptied by a released key", () => {
  const merge = mergeOwnedToml({
    current: "foo = 1\n[bar]\nbaz = 2\n",
    owned: "foo = 1\n",
    previouslyOwned: [["bar", "baz"]],
  });
  assert.equal(merge.text, "foo = 1\n");
});

test("mergeOwnedToml returns the owned key paths", () => {
  const merge = mergeOwnedToml({
    current: "",
    owned: 'foo = 1\n[bar."/baz"]\nqux = 2\n',
    previouslyOwned: [],
  });
  assert.deepEqual(merge.owned, [["foo"], ["bar", "/baz", "qux"]]);
});

test("formatKeyPath quotes segments that are not bare keys", () => {
  assert.equal(formatKeyPath(["foo", "/bar", "baz"]), 'foo."/bar".baz');
});
