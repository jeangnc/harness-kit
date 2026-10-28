import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { EvaluateResult } from "promptfoo";

import { runMetrics } from "./metrics.js";

function row(partial: Partial<EvaluateResult>): EvaluateResult {
  return { latencyMs: 50, ...partial } as EvaluateResult;
}

test("runMetrics flags a row whose error reports a rate limit", () => {
  assert.equal(runMetrics(row({ error: "429 rate_limit_error" })).rateLimited, true);
});

test("runMetrics does not flag a row without an error", () => {
  assert.equal(runMetrics(row({})).rateLimited, false);
});

test("runMetrics prefers the session duration the provider reports", () => {
  const metrics = runMetrics(row({ response: { output: "", metadata: { durationMs: 1234 } } }));
  assert.equal(metrics.durationMs, 1234);
});

test("runMetrics falls back to the row latency", () => {
  assert.equal(runMetrics(row({})).durationMs, 50);
});
