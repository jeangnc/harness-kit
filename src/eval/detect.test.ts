import { test } from "node:test";
import { strict as assert } from "node:assert";

import { createDetector, type ExitReason } from "./detect.js";

function streamStart(name: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "tool_use", name } },
  });
}

function streamDelta(partialJson: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: partialJson },
    },
  });
}

const messageStop = JSON.stringify({ type: "stream_event", event: { type: "message_stop" } });

function run(lines: string[], reason: ExitReason = "stream-end", stopAfter = 1) {
  const detector = createDetector(stopAfter);
  for (const line of lines) {
    detector.push(line);
    if (detector.done) break;
  }
  return detector.result(reason);
}

test("detect, when Skill fires via partial stream, captures the skill id", () => {
  const out = run([streamStart("Skill"), streamDelta('{"skill": "alpha:plan"'), streamDelta("}")]);
  assert.equal(out.firstSkill, "alpha:plan");
  assert.equal(out.exitReason, "skill");
});

test("detect, when skill id arrives split across deltas, reassembles it", () => {
  const out = run([streamStart("Skill"), streamDelta('{"skill": "alpha:'), streamDelta('build"}')]);
  assert.equal(out.firstSkill, "alpha:build");
});

test("detect, when a hyphenated id splits mid-token, does not capture the valid-looking prefix", () => {
  const out = run([
    streamStart("Skill"),
    streamDelta('{"skill":"acme:do'),
    streamDelta('-thing"}'),
  ]);
  assert.equal(out.firstSkill, "acme:do-thing");
});

test("detect, when a non-Skill tool fires first, records no skill", () => {
  const out = run([streamStart("Read"), messageStop], "no-skill");
  assert.equal(out.firstSkill, null);
  assert.deepEqual(out.observed, []);
});

test("detect, when no tool fires and the message stops, reports no skill", () => {
  const out = run([messageStop], "no-skill");
  assert.equal(out.firstSkill, null);
  assert.equal(out.exitReason, "no-skill");
});

test("detect, via the full assistant message fallback, reads the Skill input", () => {
  const assistant = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Skill", input: { skill: "beta:check" } }],
    },
  });
  const out = run([assistant]);
  assert.equal(out.firstSkill, "beta:check");
});

test("detect, when the Skill input uses the command key, still extracts the id", () => {
  const out = run([streamStart("Skill"), streamDelta('{"command":"beta:format"}')]);
  assert.equal(out.firstSkill, "beta:format");
});

test("detect ignores malformed JSON lines", () => {
  const out = run(["not json", streamStart("Skill"), streamDelta('{"skill":"alpha:plan"}')]);
  assert.equal(out.firstSkill, "alpha:plan");
});

test("detect captures the first skill in a chain via observed order", () => {
  const out = run([streamStart("Skill"), streamDelta('{"skill":"alpha:validate"}')]);
  assert.deepEqual(out.observed, ["alpha:validate"]);
  assert.equal(out.firstSkill, "alpha:validate");
});

test("detect, with stopAfter=2, collects a two-skill chain in order", () => {
  const out = run(
    [
      streamStart("Skill"),
      streamDelta('{"skill":"alpha:validate"}'),
      streamStart("Skill"),
      streamDelta('{"skill":"alpha:plan"}'),
    ],
    "stream-end",
    2,
  );
  assert.deepEqual(out.observed, ["alpha:validate", "alpha:plan"]);
  assert.equal(out.firstSkill, "alpha:validate");
});

test("detect, with stopAfter=1, finishes after the first skill of a chain", () => {
  const out = run(
    [streamStart("Skill"), streamDelta('{"skill":"alpha:validate"}')],
    "stream-end",
    1,
  );
  assert.deepEqual(out.observed, ["alpha:validate"]);
});
