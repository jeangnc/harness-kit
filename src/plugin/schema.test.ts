import { test } from "node:test";
import { strict as assert } from "node:assert";

import { HookRequirementSchema, PluginSchema, definePlugin } from "./schema.js";

test("PluginSchema rejects non-kebab-case name", () => {
  const result = PluginSchema.safeParse({
    name: "Foo",
    version: "1.0.0",
    description: "demo",
  });
  assert.equal(result.success, false);
});

test("PluginSchema accepts a minimal valid plugin", () => {
  const result = PluginSchema.safeParse({
    name: "foo",
    version: "1.0.0",
    description: "demo",
  });
  assert.equal(result.success, true);
});

test("PluginSchema rejects multi-line description", () => {
  const result = PluginSchema.safeParse({
    name: "foo",
    version: "1.0.0",
    description: "line one\nline two",
  });
  assert.equal(result.success, false);
});

test("PluginSchema rejects description over 1024 chars", () => {
  const result = PluginSchema.safeParse({
    name: "foo",
    version: "1.0.0",
    description: "x".repeat(1025),
  });
  assert.equal(result.success, false);
});

test("PluginSchema accepts a plugin with all optional metadata", () => {
  const result = PluginSchema.safeParse({
    name: "foo",
    version: "1.0.0",
    description: "demo",
    author: { name: "A", email: "a@b.c", url: "https://example.com" },
    homepage: "https://example.com",
    repository: "https://example.com/repo",
    license: "MIT",
    keywords: ["claude", "plugin"],
    dependencies: ["bar"],
  });
  assert.equal(result.success, true);
});

test("definePlugin returns the parsed plugin on valid input", () => {
  const plugin = definePlugin({
    name: "foo",
    version: "1.0.0",
    description: "demo",
  });
  assert.equal(plugin.name, "foo");
  assert.equal(plugin.version, "1.0.0");
});

test("definePlugin throws on invalid input", () => {
  assert.throws(() =>
    definePlugin({
      name: "Bad",
      version: "1.0.0",
      description: "demo",
    }),
  );
});

test("PluginSchema accepts commands/agents/hooks path overrides", () => {
  const result = PluginSchema.safeParse({
    name: "foo",
    version: "1.0.0",
    description: "demo",
    commands: "cmds",
    agents: "ai/agents",
    hooks: "wiring/hooks",
  });
  assert.equal(result.success, true);
});

test("PluginSchema rejects empty-string path overrides", () => {
  const result = PluginSchema.safeParse({
    name: "foo",
    version: "1.0.0",
    description: "demo",
    commands: "",
  });
  assert.equal(result.success, false);
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

test("PluginSchema accepts hookRequires", () => {
  const result = PluginSchema.safeParse({
    name: "foo",
    version: "1.0.0",
    description: "demo",
    hookRequires: [
      { event: "SessionStart", skill: "foo:bar" },
      { event: "Stop", agent: "foo:rev" },
    ],
  });
  assert.equal(result.success, true);
});

test("PluginSchema accepts hooks as a bare path-override string", () => {
  const result = PluginSchema.safeParse({
    name: "foo",
    version: "1.0.0",
    description: "demo",
    hooks: "wiring/hooks",
  });
  assert.equal(result.success, true);
});

test("PluginSchema accepts object-form dependencies with marketplace and version", () => {
  const result = PluginSchema.safeParse({
    name: "gq-core",
    version: "1.3.5",
    description: "demo",
    dependencies: [
      { name: "slack", marketplace: "claude-plugins-official" },
      { name: "other", version: "^2.0.0" },
      "legacy-string-dep",
    ],
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  const deps = result.data.dependencies;
  assert.ok(Array.isArray(deps));
  assert.equal(deps?.length, 3);
});

test("PluginSchema preserves upstream passthrough fields on parse", () => {
  const result = PluginSchema.safeParse({
    name: "foo",
    version: "1.0.0",
    description: "demo",
    category: "development",
    tags: ["ai", "tools"],
    mcpServers: { example: { command: "node", args: ["server.js"] } },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal((result.data as { category?: string }).category, "development");
  assert.deepEqual((result.data as { tags?: string[] }).tags, ["ai", "tools"]);
  assert.ok((result.data as { mcpServers?: unknown }).mcpServers);
});
