import { test } from "node:test";
import { strict as assert } from "node:assert";

import { scrubEnv, SUBPROCESS_ENV_OVERRIDES } from "./claude-env.js";

test("scrubEnv removes the named keys and leaves the rest intact", () => {
  const env = scrubEnv({ FOO: "1", BAR: "2", PATH: "/usr/bin" }, ["FOO", "BAR"]);

  assert.equal(env["FOO"], undefined);
  assert.equal(env["BAR"], undefined);
  assert.equal(env["PATH"], "/usr/bin");
});

test("scrubEnv is a no-op for keys that are absent", () => {
  const env = scrubEnv({ PATH: "/usr/bin" }, ["MISSING"]);

  assert.deepEqual(env, { PATH: "/usr/bin" });
});

test("the subprocess overrides strip the dead-account key, auth token, and nesting marker", () => {
  const dirty = {
    ANTHROPIC_API_KEY: "sk-dead",
    ANTHROPIC_AUTH_TOKEN: "tok",
    CLAUDECODE: "1",
    PATH: "/x",
  };

  const env = scrubEnv(dirty, SUBPROCESS_ENV_OVERRIDES);

  assert.equal(env["ANTHROPIC_API_KEY"], undefined);
  assert.equal(env["ANTHROPIC_AUTH_TOKEN"], undefined);
  assert.equal(env["CLAUDECODE"], undefined);
  assert.equal(env["PATH"], "/x");
});
