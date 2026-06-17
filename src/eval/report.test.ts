import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { LoadedCase } from "./cases.js";
import type { RunMetrics } from "./metrics.js";
import { buildReport, formatConsole, toJson, type CaseReport } from "./report.js";
import type { CaseScore } from "./score.js";

function routingScore(pass: boolean): CaseScore {
  return {
    matched: pass ? 1 : 0,
    runs: 1,
    triggerRate: pass ? 1 : 0,
    threshold: 1,
    pass,
    histogram: new Map([[pass ? "alpha:plan" : "beta:check", 1]]),
  };
}

function routingCase(): LoadedCase {
  return {
    id: "r1",
    prompt: "do the thing",
    expect: { first: "alpha:plan" },
    suite: "suite",
    tier: "routing",
    file: "f.yaml",
  };
}

function solvingCase(): LoadedCase {
  return {
    id: "s1",
    prompt: "solve it",
    assert: [],
    suite: "suite",
    tier: "solving",
    file: "f.yaml",
  };
}

test("formatConsole renders a passing routing case unchanged", () => {
  const report = buildReport([{ evalCase: routingCase(), score: routingScore(true) }], []);
  const out = formatConsole(report);
  assert.match(out, /routing\/suite/);
  assert.match(out, /PASS {2}r1 {2}1\/1 {2}→ alpha:plan/);
  assert.match(out, /Summary: 1\/1 cases passed \(100%\)/);
});

test("formatConsole shows the routing histogram on failure", () => {
  const report = buildReport([{ evalCase: routingCase(), score: routingScore(false) }], []);
  const out = formatConsole(report);
  assert.match(out, /FAIL {2}r1/);
  assert.match(out, /got: beta:check ×1/);
});

test("formatConsole renders failed solving assertions with evidence", () => {
  const caseReport: CaseReport = {
    evalCase: solvingCase(),
    score: { matched: 0, runs: 1, triggerRate: 0, threshold: 1, pass: false, histogram: new Map() },
    solving: {
      perRun: [
        {
          assertions: [
            {
              assertion: { kind: "usedTool", tool: "Write" },
              pass: false,
              evidence: "tools used: [Read]",
            },
          ],
          rubric: {
            pass: false,
            dimensions: [
              { dimension: "clarity", verdict: { pass: false, evidence: "rambling intro" } },
            ],
          },
        },
      ],
    },
  };
  const out = formatConsole(buildReport([caseReport], []));
  assert.match(out, /FAIL {2}s1/);
  assert.match(out, /usedTool/);
  assert.match(out, /tools used: \[Read\]/);
  assert.match(out, /clarity/);
  assert.match(out, /rambling intro/);
});

test("diagnostics aggregate rate-limited runs and duration across all runs", () => {
  const metrics: RunMetrics[] = [
    { rateLimited: true, durationMs: 100 },
    { rateLimited: false, durationMs: 300 },
    { rateLimited: false, durationMs: null },
  ];
  const report = buildReport([{ evalCase: routingCase(), score: routingScore(true) }], metrics);
  assert.deepEqual(report.diagnostics, {
    totalRuns: 3,
    rateLimitedRuns: 1,
    durationMs: { min: 100, max: 300, mean: 200 },
  });
});

test("diagnostics report null duration when no run reached a result event", () => {
  const report = buildReport(
    [{ evalCase: routingCase(), score: routingScore(true) }],
    [{ rateLimited: false, durationMs: null }],
  );
  assert.equal(report.diagnostics.durationMs, null);
  assert.equal(report.diagnostics.totalRuns, 1);
});

test("formatConsole renders the diagnostics line with duration when present", () => {
  const cases = [{ evalCase: routingCase(), score: routingScore(true) }];
  const out = formatConsole(buildReport(cases, [{ rateLimited: true, durationMs: 200 }]));
  assert.match(
    out,
    /Diagnostics: 1\/1 runs rate-limited, duration ms min\/mean\/max 200\/200\/200\./,
  );
});

test("formatConsole omits the duration clause when no run reached a result event", () => {
  const cases = [{ evalCase: routingCase(), score: routingScore(true) }];
  const out = formatConsole(buildReport(cases, [{ rateLimited: false, durationMs: null }]));
  assert.match(out, /Diagnostics: 0\/1 runs rate-limited\./);
  assert.doesNotMatch(out, /duration ms/);
});

interface JsonReport {
  readonly cases: Array<{ expect?: unknown; tier: string }>;
}

test("toJson includes routing expect and omits it for solving", () => {
  const routing = JSON.parse(
    toJson(buildReport([{ evalCase: routingCase(), score: routingScore(true) }], [])),
  ) as JsonReport;
  assert.deepEqual(routing.cases[0]!.expect, { first: "alpha:plan" });

  const solving = JSON.parse(
    toJson(
      buildReport(
        [
          {
            evalCase: solvingCase(),
            score: {
              matched: 1,
              runs: 1,
              triggerRate: 1,
              threshold: 1,
              pass: true,
              histogram: new Map(),
            },
          },
        ],
        [],
      ),
    ),
  ) as JsonReport;
  assert.equal(solving.cases[0]!.expect, undefined);
  assert.equal(solving.cases[0]!.tier, "solving");
});
