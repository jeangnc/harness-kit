import { test } from "node:test";
import { strict as assert } from "node:assert";

import { createMetrics } from "./metrics.js";

function feed(lines: string[]) {
  const metrics = createMetrics();
  for (const line of lines) metrics.push(line);
  return metrics.result();
}

const rejected = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
});

const allowed = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
});

const result = (durationMs: number) =>
  JSON.stringify({ type: "result", subtype: "success", duration_ms: durationMs, result: "ok" });

test("metrics, with no rate-limit event, reports not rate-limited", () => {
  assert.equal(feed([result(100)]).rateLimited, false);
});

test("metrics, when a rejected rate-limit event arrives, reports rate-limited", () => {
  assert.equal(feed([rejected, result(100)]).rateLimited, true);
});

test("metrics, when only an allowed rate-limit event arrives, reports not rate-limited", () => {
  assert.equal(feed([allowed, result(100)]).rateLimited, false);
});

test("metrics reads duration from the result event", () => {
  assert.equal(feed([result(2142)]).durationMs, 2142);
});

test("metrics, when the stream ends before a result event, reports null duration", () => {
  assert.equal(feed([rejected]).durationMs, null);
});

test("metrics ignores malformed json lines", () => {
  assert.equal(feed(["not json", rejected]).rateLimited, true);
});
