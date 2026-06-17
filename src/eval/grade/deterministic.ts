import { err, ok, type Result } from "../../result.js";
import type { SolvingCapture } from "../capture.js";
import type { Assertion } from "../schema.js";

export interface AssertionResult {
  readonly assertion: Assertion;
  readonly pass: boolean;
  readonly evidence: string;
}

export function gradeAssertions(
  assertions: readonly Assertion[],
  capture: SolvingCapture,
  answer: string,
): AssertionResult[] {
  return assertions.map((assertion) => grade(assertion, capture, answer));
}

function grade(assertion: Assertion, capture: SolvingCapture, answer: string): AssertionResult {
  switch (assertion.kind) {
    case "outputMatches":
      return matchOutput(assertion, answer, {
        whenPresent: () => pass(assertion, `matched "${assertion.pattern}"`),
        whenAbsent: () => fail(assertion, `no match for "${assertion.pattern}"`),
      });

    case "outputExcludes":
      return matchOutput(assertion, capture.outputText, {
        whenPresent: (hit) => fail(assertion, `found forbidden "${hit}"`),
        whenAbsent: () => pass(assertion, `absent: "${assertion.pattern}"`),
      });

    case "usedTool":
      return tools(capture).includes(assertion.tool)
        ? pass(assertion, `used ${assertion.tool}`)
        : fail(assertion, `tools used: [${tools(capture).join(", ")}]`);

    case "didNotUseTool":
      return tools(capture).includes(assertion.tool)
        ? fail(assertion, `unexpectedly used ${assertion.tool}`)
        : pass(assertion, `did not use ${assertion.tool}`);

    case "wroteFile":
      return gradeWroteFile(assertion, capture);
  }
}

interface MatchOutcome {
  readonly whenPresent: (hit: string) => AssertionResult;
  readonly whenAbsent: () => AssertionResult;
}

function matchOutput(
  assertion: Extract<Assertion, { kind: "outputMatches" | "outputExcludes" }>,
  text: string,
  outcome: MatchOutcome,
): AssertionResult {
  const matcher = compileMatcher(assertion.pattern, assertion.regex);
  if (!matcher.ok) return fail(assertion, matcher.error);
  const hit = matcher.value(text);
  return hit === null ? outcome.whenAbsent() : outcome.whenPresent(hit);
}

function gradeWroteFile(
  assertion: Extract<Assertion, { kind: "wroteFile" }>,
  capture: SolvingCapture,
): AssertionResult {
  if (!wroteTo(capture, assertion.path)) {
    return fail(
      assertion,
      `${assertion.path} not written (wrote: [${writtenPaths(capture).join(", ")}])`,
    );
  }
  if (assertion.contentMatches === undefined) {
    return pass(assertion, `wrote ${assertion.path}`);
  }
  const content = capture.writes.find((w) => w.path === assertion.path)?.content ?? "";
  const matcher = compileMatcher(assertion.contentMatches, assertion.regex);
  if (!matcher.ok) return fail(assertion, matcher.error);
  return matcher.value(content) !== null
    ? pass(assertion, `${assertion.path} content matched`)
    : fail(assertion, `${assertion.path} content did not match "${assertion.contentMatches}"`);
}

type Matcher = (text: string) => string | null;

function compileMatcher(pattern: string, regex: boolean): Result<Matcher, string> {
  if (!regex) {
    return ok((text) => (text.includes(pattern) ? pattern : null));
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern);
  } catch (cause) {
    return err(`invalid regex "${pattern}": ${(cause as Error).message}`);
  }
  return ok((text) => compiled.exec(text)?.[0] ?? null);
}

function wroteTo(capture: SolvingCapture, path: string): boolean {
  return writtenPaths(capture).includes(path);
}

function writtenPaths(capture: SolvingCapture): string[] {
  return capture.writes.map((w) => w.path);
}

function tools(capture: SolvingCapture): string[] {
  return capture.trajectory.map((call) => call.name);
}

function pass(assertion: Assertion, evidence: string): AssertionResult {
  return { assertion, pass: true, evidence };
}

function fail(assertion: Assertion, evidence: string): AssertionResult {
  return { assertion, pass: false, evidence };
}
