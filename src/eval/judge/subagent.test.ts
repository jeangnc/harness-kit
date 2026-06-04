import { test } from "node:test";
import { strict as assert } from "node:assert";

import { createSubagentJudge, type SubagentRunner } from "./subagent.js";

function runnerReturning(stdout: string): SubagentRunner {
  return async () => stdout;
}

function runnerThrowing(message: string): SubagentRunner {
  return async () => {
    throw new Error(message);
  };
}

const request = { dimension: "error-handling", criterion: "handles empty list", output: "code" };

test("abstains with the failure reason when the runner rejects", async () => {
  const judge = createSubagentJudge({
    model: "claude-haiku-4-5",
    run: runnerThrowing("claude judge timed out after 120000ms"),
  });

  const verdict = await judge(request);

  assert.equal(verdict.pass, "unknown");
  assert.match(verdict.evidence, /timed out/);
});

test("maps a pass structured_output to a passing verdict", async () => {
  const cli = JSON.stringify({
    is_error: false,
    structured_output: { verdict: "pass", evidence: "reduce has an initial value" },
  });
  const judge = createSubagentJudge({ model: "claude-haiku-4-5", run: runnerReturning(cli) });

  const verdict = await judge(request);

  assert.equal(verdict.pass, true);
  assert.equal(verdict.evidence, "reduce has an initial value");
});

test("maps a fail structured_output to a failing verdict", async () => {
  const cli = JSON.stringify({
    is_error: false,
    structured_output: { verdict: "fail", evidence: "returns NaN" },
  });
  const judge = createSubagentJudge({ model: "claude-haiku-4-5", run: runnerReturning(cli) });

  const verdict = await judge(request);

  assert.equal(verdict.pass, false);
  assert.equal(verdict.evidence, "returns NaN");
});

test("maps an unknown structured_output to an abstaining verdict", async () => {
  const cli = JSON.stringify({
    is_error: false,
    structured_output: { verdict: "unknown", evidence: "cannot tell" },
  });
  const judge = createSubagentJudge({ model: "claude-haiku-4-5", run: runnerReturning(cli) });

  const verdict = await judge(request);

  assert.equal(verdict.pass, "unknown");
  assert.equal(verdict.evidence, "cannot tell");
});

test("abstains when the CLI reports an error", async () => {
  const cli = JSON.stringify({ is_error: true, result: "Credit balance is too low" });
  const judge = createSubagentJudge({ model: "claude-haiku-4-5", run: runnerReturning(cli) });

  const verdict = await judge(request);

  assert.equal(verdict.pass, "unknown");
  assert.match(verdict.evidence, /Credit balance is too low/);
});

test("abstains when stdout is not valid JSON", async () => {
  const judge = createSubagentJudge({
    model: "claude-haiku-4-5",
    run: runnerReturning("not json at all"),
  });

  const verdict = await judge(request);

  assert.equal(verdict.pass, "unknown");
});

test("abstains when structured_output is missing", async () => {
  const cli = JSON.stringify({ is_error: false, result: "freeform prose, no schema" });
  const judge = createSubagentJudge({ model: "claude-haiku-4-5", run: runnerReturning(cli) });

  const verdict = await judge(request);

  assert.equal(verdict.pass, "unknown");
});
