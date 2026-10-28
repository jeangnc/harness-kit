import { test } from "node:test";
import { strict as assert } from "node:assert";

import { claude, stopAfterSkillCalls, type AgentSession } from "./vendors.js";

function session(partial: Partial<AgentSession> = {}): AgentSession {
  return {
    label: "case-1",
    cwd: "/work",
    pluginRoots: [],
    enabledPlugins: new Set(),
    ...partial,
  };
}

test("claude agent loads each local plugin root as a local plugin", () => {
  const provider = claude.agent(session({ pluginRoots: ["/dist/plugins/alpha"] }));
  assert.deepEqual(provider.config.plugins, [{ type: "local", path: "/dist/plugins/alpha" }]);
});

test("claude agent labels the provider with the session label", () => {
  assert.equal(claude.agent(session()).label, "case-1");
});

test("claude agent forces enabled plugins on through settings", () => {
  const provider = claude.agent(session({ enabledPlugins: new Set(["alpha@market"]) }));
  assert.deepEqual(provider.config.settings, { enabledPlugins: { "alpha@market": true } });
});

test("claude agent omits settings when no plugin must be enabled", () => {
  assert.equal(claude.agent(session()).config.settings, undefined);
});

test("claude agent installs a stop hook only when a skill limit is set", () => {
  assert.equal(claude.agent(session()).config.hooks, undefined);
  const hooks = claude.agent(session({ stopAfterSkills: 1 })).config.hooks;
  assert.equal(hooks?.PreToolUse[0]?.matcher, "Skill");
});

test("claude judge runs without user settings or tools on the given model", () => {
  const { config } = claude.judge("opus");
  assert.equal(config.model, "opus");
  assert.deepEqual(config.setting_sources, []);
  assert.deepEqual(config.custom_allowed_tools, []);
});

test("stopAfterSkillCalls stops a session once it reaches the limit", async () => {
  const [hook] = stopAfterSkillCalls(2).hooks;
  assert.deepEqual(await hook!({ session_id: "a" }), {});
  assert.deepEqual(await hook!({ session_id: "a" }), {
    continue: false,
    stopReason: "routing observed",
  });
});

test("stopAfterSkillCalls counts each session independently", async () => {
  const [hook] = stopAfterSkillCalls(2).hooks;
  await hook!({ session_id: "a" });
  assert.deepEqual(await hook!({ session_id: "b" }), {});
});
