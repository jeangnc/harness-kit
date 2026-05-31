import { test } from "node:test";
import { strict as assert } from "node:assert";

import { detectBypasses, type BypassHaystacks } from "./bypass.js";

const haystacks: BypassHaystacks = {
  skill: new Set(["dev-tools:typescript"]),
  command: new Set(["dev-tools:open-pr"]),
  agent: new Set(["pr-review:reviewer"]),
};

test("a slash reference to a known command outside a placeholder is flagged as a bypass", () => {
  const found = detectBypasses("run /dev-tools:open-pr to ship\n", haystacks);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, "dev-tools:open-pr");
  assert.equal(found[0]!.prefix, "command");
  assert.equal(found[0]!.offset, "run ".length);
});

test("a bare fully-qualified id matching a known skill is flagged as a bypass", () => {
  const found = detectBypasses("see dev-tools:typescript for types\n", haystacks);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, "dev-tools:typescript");
  assert.equal(found[0]!.prefix, "skill");
});

test("an @ mention of a known agent outside a placeholder is flagged as a bypass", () => {
  const found = detectBypasses("ask @pr-review:reviewer to look\n", haystacks);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, "pr-review:reviewer");
  assert.equal(found[0]!.prefix, "agent");
});

test("a sanctioned placeholder reference is not flagged as a bypass", () => {
  const found = detectBypasses("see {{skill:dev-tools:typescript}}\n", haystacks);
  assert.deepEqual(found, []);
});

test("a bare id that matches no known artifact is left alone as ordinary prose", () => {
  const found = detectBypasses("the ratio was 16:9 and time 10:30\n", haystacks);
  assert.deepEqual(found, []);
});

test("the slash sigil resolves to a command even when the id also names a skill", () => {
  const both: BypassHaystacks = {
    skill: new Set(["dev-tools:open-pr"]),
    command: new Set(["dev-tools:open-pr"]),
    agent: new Set(),
  };
  const found = detectBypasses("/dev-tools:open-pr\n", both);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.prefix, "command");
});

test("a bare id matching both a skill and a command is reported once per resolved kind", () => {
  const both: BypassHaystacks = {
    skill: new Set(["dev-tools:open-pr"]),
    command: new Set(["dev-tools:open-pr"]),
    agent: new Set(),
  };
  const found = detectBypasses("see dev-tools:open-pr\n", both);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((b) => b.prefix).sort(), ["command", "skill"]);
});
