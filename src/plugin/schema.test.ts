import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  AGENT_PLUGINS_SCHEMA,
  HarnessExtensionSchema,
  HookRequirementSchema,
  PluginSchema,
  extensionBlock,
  withoutExtensions,
} from "./schema.js";

const minimal = {
  $schema: AGENT_PLUGINS_SCHEMA,
  name: "foo",
  version: "1.0.0",
  description: "demo",
};

test("PluginSchema accepts a minimal Agent Plugins manifest", () => {
  assert.equal(PluginSchema.safeParse(minimal).success, true);
});

test("PluginSchema rejects a manifest without $schema", () => {
  const { $schema: _schema, ...rest } = minimal;
  assert.equal(PluginSchema.safeParse(rest).success, false);
});

test("PluginSchema rejects a $schema for another spec version", () => {
  const result = PluginSchema.safeParse({ ...minimal, $schema: "https://example.com/other.json" });
  assert.equal(result.success, false);
});

test("PluginSchema rejects a non-kebab-case name", () => {
  assert.equal(PluginSchema.safeParse({ ...minimal, name: "Foo" }).success, false);
});

test("PluginSchema rejects a multi-line description", () => {
  const result = PluginSchema.safeParse({ ...minimal, description: "line one\nline two" });
  assert.equal(result.success, false);
});

test("PluginSchema rejects a description over 1024 chars", () => {
  const result = PluginSchema.safeParse({ ...minimal, description: "x".repeat(1025) });
  assert.equal(result.success, false);
});

test("PluginSchema accepts every optional metadata field", () => {
  const result = PluginSchema.safeParse({
    ...minimal,
    author: { name: "A", email: "a@b.c", url: "https://example.com" },
    homepage: "https://example.com",
    repository: "https://example.com/repo",
    license: "MIT",
    keywords: ["claude", "plugin"],
  });
  assert.equal(result.success, true);
});

test("PluginSchema rejects a vendor-specific field at the top level", () => {
  assert.equal(PluginSchema.safeParse({ ...minimal, dependencies: ["bar"] }).success, false);
});

test("PluginSchema rejects an extension that is not an object", () => {
  const result = PluginSchema.safeParse({ ...minimal, extensions: { claude: "x" } });
  assert.equal(result.success, false);
});

test("extensionBlock returns the named vendor block", () => {
  const plugin = PluginSchema.parse({
    ...minimal,
    extensions: { claude: { dependencies: ["bar"] } },
  });
  assert.deepEqual(extensionBlock(plugin, "claude"), { dependencies: ["bar"] });
});

test("extensionBlock returns an empty block when the vendor has none", () => {
  assert.deepEqual(extensionBlock(PluginSchema.parse(minimal), "codex"), {});
});

test("withoutExtensions drops $schema and extensions but keeps metadata", () => {
  const plugin = PluginSchema.parse({ ...minimal, license: "MIT", extensions: { claude: {} } });
  assert.deepEqual(withoutExtensions(plugin), {
    name: "foo",
    version: "1.0.0",
    description: "demo",
    license: "MIT",
  });
});

test("HarnessExtensionSchema rejects an unknown key", () => {
  assert.equal(HarnessExtensionSchema.safeParse({ bogus: 1 }).success, false);
});

test("HookRequirementSchema accepts an event with exactly one of skill/command/agent", () => {
  const skill = HookRequirementSchema.safeParse({ event: "SessionStart", skill: "foo:bar" });
  const command = HookRequirementSchema.safeParse({ event: "UserPromptSubmit", command: "foo:do" });
  const agent = HookRequirementSchema.safeParse({ event: "Stop", agent: "foo:rev" });
  assert.equal(skill.success, true);
  assert.equal(command.success, true);
  assert.equal(agent.success, true);
});

test("HookRequirementSchema rejects an event with no slug", () => {
  const result = HookRequirementSchema.safeParse({ event: "SessionStart" });
  assert.equal(result.success, false);
});

test("HookRequirementSchema rejects an event with more than one slug", () => {
  const result = HookRequirementSchema.safeParse({
    event: "SessionStart",
    skill: "foo:bar",
    command: "foo:do",
  });
  assert.equal(result.success, false);
});
