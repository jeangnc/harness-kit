import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Assertion,
  AssertionValueFunction,
  AssertionValueFunctionContext,
  GradingResult,
} from "promptfoo";

import type { LoadedRoutingCase, LoadedSolvingCase } from "./cases.js";
import {
  compileRouting,
  compileSolving,
  metricNames,
  type CompiledSuite,
  type CompileOptions,
} from "./compile.js";
import { claude } from "./vendors.js";

const options: CompileOptions = {
  vendor: claude,
  cwd: "/work",
  judgeModel: "opus",
  pluginRoots: [],
  enabledPlugins: new Set(),
};

function routing(partial: Partial<LoadedRoutingCase> = {}): LoadedRoutingCase {
  return {
    id: "r1",
    prompt: "plan it",
    expect: { first: "alpha:plan" },
    suite: "s",
    tier: "routing",
    file: "f.yaml",
    ...partial,
  };
}

function solving(partial: Partial<LoadedSolvingCase> = {}): LoadedSolvingCase {
  return {
    id: "s1",
    prompt: "solve it",
    assert: [],
    suite: "s",
    tier: "solving",
    file: "f.yaml",
    ...partial,
  };
}

function providersOf(suite: CompiledSuite) {
  return suite.providers as ReadonlyArray<ReturnType<typeof claude.agent>>;
}

function context(raw: string, toolCalls: unknown[] = []): AssertionValueFunctionContext {
  return {
    providerResponse: {
      output: "transformed",
      providerTransformedOutput: raw,
      metadata: { toolCalls },
    },
  } as unknown as AssertionValueFunctionContext;
}

async function passes(
  assertion: Assertion | undefined,
  answer: string,
  ctx: AssertionValueFunctionContext,
): Promise<boolean> {
  const result = await (assertion?.value as AssertionValueFunction)(answer, ctx);
  return (result as GradingResult).pass;
}

function byMetric(
  evalCase: LoadedSolvingCase,
  metric: string,
  opts = options,
): Assertion | undefined {
  return compileSolving([evalCase], opts).tests[0]?.assert?.find((a) => a.metric === metric);
}

test("compileRouting labels providers by position so case ids never act as provider refs", () => {
  const suite = compileRouting([routing({ id: "anthropic" }), routing({ id: "b" })], options);
  assert.deepEqual(
    providersOf(suite).map((p) => p.label),
    ["case-0", "case-1"],
  );
});

test("compileRouting pins promptfoo result stripping off", () => {
  const { env } = compileRouting([routing()], options);
  assert.equal(env["PROMPTFOO_STRIP_METADATA"], "false");
  assert.equal(env["PROMPTFOO_STRIP_GRADING_RESULT"], "false");
});

test("compileRouting restricts each test to its own case provider", () => {
  const suite = compileRouting([routing({ id: "a" }), routing({ id: "b" })], options);
  assert.deepEqual(
    suite.tests.map((t) => t.providers),
    [["case-0"], ["case-1"]],
  );
});

test("compileRouting repeats a routing case five times by default", () => {
  const [testCase] = compileRouting([routing()], options).tests;
  assert.equal(testCase!.options.repeat, 5);
});

test("compileRouting prefers the case runs over the option runs", () => {
  const suite = compileRouting([routing({ runs: 2 })], { ...options, runs: 7 });
  const [testCase] = suite.tests;
  assert.equal(testCase!.options.repeat, 2);
});

test("compileRouting stops a path case after observing every skill in the path", async () => {
  const suite = compileRouting([routing({ expect: { path: ["a:x", "b:y", "c:z"] } })], options);
  const [hook] = providersOf(suite)[0]!.config.hooks!.PreToolUse[0]!.hooks;
  await hook!({ session_id: "s" });
  assert.deepEqual(await hook!({ session_id: "s" }), {});
  assert.equal((await hook!({ session_id: "s" })).continue, false);
});

test("compileRouting resolves a relative base cwd against the process cwd", () => {
  const suite = compileRouting([routing()], { ...options, cwd: "." });
  assert.equal(providersOf(suite)[0]!.config.working_dir, process.cwd());
});

test("compileRouting resolves a relative case cwd against the base cwd", () => {
  const suite = compileRouting([routing({ cwd: "fixtures/app" })], options);
  assert.equal(providersOf(suite)[0]!.config.working_dir, "/work/fixtures/app");
});

test("compileRouting renders the case prompt verbatim", async () => {
  const prompt = "keep {{ braces }} as typed";
  const suite = compileRouting([routing({ prompt })], options);
  const [promptConfig] = suite.prompts;
  assert.equal(await promptConfig!.function({ vars: { caseId: "r1" } }), prompt);
});

test("compileSolving installs no skill stop hook", () => {
  const suite = compileSolving([solving()], options);
  assert.equal(providersOf(suite)[0]!.config.hooks, undefined);
});

test("compileSolving fails the answer check when the start marker is missing", async () => {
  const evalCase = solving({ answer: { start: "===A===", end: "===" } });
  const pass = await passes(byMetric(evalCase, metricNames.answer), "", context("no marker here"));
  assert.equal(pass, false);
});

test("compileSolving transforms the output to the answer region", () => {
  const evalCase = solving({ answer: { start: "===A===", end: "===" } });
  const [testCase] = compileSolving([evalCase], options).tests;
  assert.equal(testCase!.options.transform!("chatter ===A=== body === tail"), "===A=== body ===");
});

test("compileSolving grades outputMatches against the answer it receives", async () => {
  const evalCase = solving({
    assert: [{ kind: "outputMatches", pattern: "VERDICT", regex: false }],
  });
  const pass = await passes(
    byMetric(evalCase, metricNames.assertion(0)),
    "VERDICT",
    context("raw"),
  );
  assert.equal(pass, true);
});

test("compileSolving grades outputExcludes against the raw output", async () => {
  const evalCase = solving({
    assert: [{ kind: "outputExcludes", pattern: "preamble", regex: false }],
  });
  const pass = await passes(
    byMetric(evalCase, metricNames.assertion(0)),
    "answer only",
    context("preamble then answer only"),
  );
  assert.equal(pass, false);
});

test("compileSolving grades usedTool against the response tool calls", async () => {
  const evalCase = solving({ assert: [{ kind: "usedTool", tool: "Write" }] });
  const pass = await passes(
    byMetric(evalCase, metricNames.assertion(0)),
    "",
    context("", [{ name: "Write", input: { file_path: "a", content: "" } }]),
  );
  assert.equal(pass, true);
});

test("compileSolving grades wroteFile against the file on disk under the case cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "compile-"));
  await writeFile(join(cwd, "out.txt"), "written by bash");
  const evalCase = solving({
    assert: [{ kind: "wroteFile", path: "out.txt", contentMatches: "bash", regex: false }],
  });
  const assertion = byMetric(evalCase, metricNames.assertion(0), { ...options, cwd });
  const pass = await passes(assertion, "", context(""));
  assert.equal(pass, true);
});

test("compileSolving grades each rubric dimension with the vendor judge", () => {
  const evalCase = solving({
    rubric: {
      dimensions: [{ dimension: "clarity", criterion: "is clear" }],
      combine: { combine: "all" },
    },
  });
  const rubric = byMetric(evalCase, metricNames.rubric(0));
  assert.equal(rubric?.type, "llm-rubric");
  assert.match(rubric?.value as string, /Dimension: clarity\nCriterion: is clear$/);
  assert.deepEqual(rubric?.provider, claude.judge("opus"));
});
