import { resolve } from "node:path";

import type {
  Assertion as PromptfooAssertion,
  AssertionValueFunctionContext,
  GradingResult,
  TestCase,
} from "promptfoo";

import { captureRun, withDiskWrites } from "./capture.js";
import type { LoadedCase, LoadedRoutingCase, LoadedSolvingCase } from "./cases.js";
import { extractAnswer, gradeAssertion } from "./grade/index.js";
import type { Assertion } from "./schema.js";
import { trajectoryOf } from "./trajectory.js";
import type { EvalVendor, ProviderSpec } from "./vendors.js";

const DEFAULT_ROUTING_RUNS = 5;
const DEFAULT_SOLVING_RUNS = 1;

export interface CompileOptions {
  readonly vendor: EvalVendor;
  readonly cwd: string;
  readonly model?: string;
  readonly judgeModel: string;
  readonly runs?: number;
  readonly pluginRoots: readonly string[];
  readonly enabledPlugins: ReadonlySet<string>;
}

export interface CasePrompt {
  readonly label: string;
  readonly raw: string;
  readonly function: (context: { vars: Record<string, unknown> }) => Promise<string>;
}

export type CompiledTest = Omit<TestCase, "assert" | "options" | "providers"> & {
  readonly providers: string[];
  readonly options: { readonly repeat: number; readonly transform?: (output: unknown) => string };
  readonly assert?: PromptfooAssertion[];
};

export interface CompiledSuite {
  readonly prompts: CasePrompt[];
  readonly providers: Array<ProviderSpec<unknown>>;
  readonly tests: CompiledTest[];
  readonly env: Record<string, string>;
  readonly writeLatestResults: false;
}

export const metricNames = {
  answer: "answer",
  assertion: (index: number) => `assert:${index}`,
  rubric: (index: number) => `rubric:${index}`,
} as const;

export function compileRouting(
  cases: readonly LoadedRoutingCase[],
  options: CompileOptions,
): CompiledSuite {
  return suiteOf(cases, options, (evalCase) => testOf(evalCase, options, DEFAULT_ROUTING_RUNS));
}

export function compileSolving(
  cases: readonly LoadedSolvingCase[],
  options: CompileOptions,
): CompiledSuite {
  return suiteOf(cases, options, (evalCase) => {
    const base = testOf(evalCase, options, DEFAULT_SOLVING_RUNS);
    return {
      ...base,
      options: { ...base.options, transform: (output: unknown) => answerText(evalCase, output) },
      assert: solvingAssertions(evalCase, options),
    };
  });
}

function suiteOf<Case extends LoadedCase>(
  cases: readonly Case[],
  options: CompileOptions,
  toTest: (evalCase: Case) => CompiledTest,
): CompiledSuite {
  const prompts = new Map(cases.map((evalCase) => [evalCase.id, evalCase.prompt]));
  return {
    prompts: [
      {
        label: "case prompt",
        raw: "case prompt",
        function: async ({ vars }) => Promise.resolve(prompts.get(String(vars["caseId"])) ?? ""),
      },
    ],
    providers: cases.map((evalCase) => providerOf(evalCase, options)),
    tests: cases.map(toTest),
    env: { PROMPTFOO_DISABLE_TEMPLATING: "true", PROMPTFOO_DISABLE_TELEMETRY: "true" },
    writeLatestResults: false,
  };
}

function providerOf(evalCase: LoadedCase, options: CompileOptions) {
  return options.vendor.agent({
    label: evalCase.id,
    cwd: caseCwd(evalCase, options),
    pluginRoots: options.pluginRoots,
    enabledPlugins: options.enabledPlugins,
    ...(options.model !== undefined && { model: options.model }),
    ...(evalCase.tier === "routing" && { stopAfterSkills: skillsToObserve(evalCase) }),
  });
}

function skillsToObserve(evalCase: LoadedRoutingCase): number {
  return "path" in evalCase.expect ? evalCase.expect.path.length : 1;
}

function testOf(evalCase: LoadedCase, options: CompileOptions, defaultRuns: number): CompiledTest {
  return {
    description: evalCase.id,
    vars: { caseId: evalCase.id },
    providers: [evalCase.id],
    metadata: { caseId: evalCase.id },
    options: { repeat: evalCase.runs ?? options.runs ?? defaultRuns },
  };
}

function caseCwd(evalCase: LoadedCase, options: CompileOptions): string {
  return evalCase.cwd === undefined ? options.cwd : resolve(options.cwd, evalCase.cwd);
}

function answerText(evalCase: LoadedSolvingCase, output: unknown): string {
  const raw = textOf(output);
  const extracted = extractAnswer(evalCase.answer, raw);
  return extracted.found ? extracted.text : raw;
}

function solvingAssertions(
  evalCase: LoadedSolvingCase,
  options: CompileOptions,
): PromptfooAssertion[] {
  const judge = options.vendor.judge(options.judgeModel);
  return [
    {
      type: "javascript",
      metric: metricNames.answer,
      value: (_output: string, context: GradingContext) =>
        answerPresence(evalCase, rawOutput(context)),
    },
    ...evalCase.assert.map(
      (assertion, index): PromptfooAssertion => ({
        type: "javascript",
        metric: metricNames.assertion(index),
        value: async (answer: string, context: GradingContext) =>
          gradeRun(assertion, { answer, context, cwd: caseCwd(evalCase, options) }),
      }),
    ),
    ...(evalCase.rubric?.dimensions ?? []).map(
      ({ criterion }, index): PromptfooAssertion => ({
        type: "llm-rubric",
        metric: metricNames.rubric(index),
        value: criterion,
        provider: judge,
      }),
    ),
  ];
}

function answerPresence(evalCase: LoadedSolvingCase, raw: string): GradingResult {
  const found = extractAnswer(evalCase.answer, raw).found;
  return {
    pass: found,
    score: found ? 1 : 0,
    reason: found ? "answer found" : "no answer block in output",
  };
}

type GradingContext = Pick<AssertionValueFunctionContext, "providerResponse">;

interface RunContext {
  readonly answer: string;
  readonly context: GradingContext;
  readonly cwd: string;
}

async function gradeRun(assertion: Assertion, run: RunContext): Promise<GradingResult> {
  const captured = captureRun(
    rawOutput(run.context),
    trajectoryOf(run.context.providerResponse?.metadata),
  );
  const declared = assertion.kind === "wroteFile" ? [assertion.path] : [];
  const capture = await withDiskWrites(captured, run.cwd, declared);
  const result = gradeAssertion(assertion, capture, run.answer);
  return { pass: result.pass, score: result.pass ? 1 : 0, reason: result.evidence };
}

function rawOutput(context: GradingContext): string {
  return textOf(context.providerResponse?.output);
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}
