import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { InstalledIndex, InstalledSkill } from "../installed.js";
import { enabledPluginKeys } from "./index.js";
import type { LoadedRoutingCase } from "./cases.js";

function routing(expect: LoadedRoutingCase["expect"]): LoadedRoutingCase {
  return { id: "r1", prompt: "p", expect, suite: "s", tier: "routing", file: "f.yaml" };
}

function skill(
  partial: Partial<InstalledSkill> & Pick<InstalledSkill, "plugin" | "skill">,
): InstalledSkill {
  return { source: "claude", marketplace: "market-a", path: "p", ...partial };
}

function index(skills: readonly InstalledSkill[]): InstalledIndex {
  const map = new Map<string, InstalledSkill[]>();
  for (const s of skills) {
    const id = `${s.plugin}:${s.skill}`;
    (map.get(id) ?? map.set(id, []).get(id)!).push(s);
  }
  return { skills: map, commands: new Map(), agents: new Map() };
}

test("enabledPluginKeys maps an expected skill to its plugin@marketplace key", () => {
  const idx = index([skill({ plugin: "dev-tools", skill: "code-review" })]);
  const keys = enabledPluginKeys([routing({ first: "dev-tools:code-review" })], idx);
  assert.deepEqual([...keys], ["dev-tools@market-a"]);
});

test("enabledPluginKeys includes forbidden (not) skills so negative assertions stay meaningful", () => {
  const idx = index([
    skill({ plugin: "dev-tools", skill: "code-review", marketplace: "market-a" }),
    skill({ plugin: "other", skill: "thing", marketplace: "market-b" }),
  ]);
  const keys = enabledPluginKeys(
    [routing({ first: "dev-tools:code-review", not: ["other:thing"] })],
    idx,
  );
  assert.deepEqual([...keys].sort(), ["dev-tools@market-a", "other@market-b"]);
});

test("enabledPluginKeys emits one key per marketplace when a plugin:skill collides across marketplaces", () => {
  const idx = index([
    skill({ plugin: "dev-tools", skill: "code-review", marketplace: "market-a" }),
    skill({ plugin: "dev-tools", skill: "code-review", marketplace: "market-b" }),
  ]);
  const keys = enabledPluginKeys([routing({ first: "dev-tools:code-review" })], idx);
  assert.deepEqual([...keys].sort(), ["dev-tools@market-a", "dev-tools@market-b"]);
});

test("enabledPluginKeys excludes skills from non-claude vendors", () => {
  const idx = index([
    skill({ plugin: "dev-tools", skill: "code-review", source: "codex", marketplace: "market-a" }),
  ]);
  const keys = enabledPluginKeys([routing({ first: "dev-tools:code-review" })], idx);
  assert.deepEqual([...keys], []);
});

test("enabledPluginKeys returns an empty set for a noSkill case", () => {
  const idx = index([skill({ plugin: "dev-tools", skill: "code-review" })]);
  const keys = enabledPluginKeys([routing({ noSkill: true })], idx);
  assert.deepEqual([...keys], []);
});

test("enabledPluginKeys skips an entry whose marketplace is empty", () => {
  const idx = index([skill({ plugin: "dev-tools", skill: "code-review", marketplace: "" })]);
  const keys = enabledPluginKeys([routing({ first: "dev-tools:code-review" })], idx);
  assert.deepEqual([...keys], []);
});

test("enabledPluginKeys maps an expected command to its plugin@marketplace key", () => {
  const idx: InstalledIndex = {
    skills: new Map(),
    commands: new Map([
      [
        "dev-tools:post-review",
        [
          {
            source: "claude" as const,
            marketplace: "market-a",
            path: "p",
            plugin: "dev-tools",
            command: "post-review",
          },
        ],
      ],
    ]),
    agents: new Map(),
  };
  const keys = enabledPluginKeys([routing({ first: "dev-tools:post-review" })], idx);
  assert.deepEqual([...keys], ["dev-tools@market-a"]);
});
