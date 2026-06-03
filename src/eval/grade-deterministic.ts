import type { SolvingCapture } from "./capture.js";
import type { Assertion } from "./schema.js";

export interface AssertionResult {
  readonly assertion: Assertion;
  readonly pass: boolean;
  readonly evidence: string;
}

export function gradeAssertions(
  assertions: readonly Assertion[],
  capture: SolvingCapture,
): AssertionResult[] {
  return assertions.map((assertion) => grade(assertion, capture));
}

function grade(assertion: Assertion, capture: SolvingCapture): AssertionResult {
  switch (assertion.kind) {
    case "outputMatches":
      return outputContains(assertion, capture.outputText)
        ? pass(assertion, `matched "${assertion.pattern}"`)
        : fail(assertion, `no match for "${assertion.pattern}"`);

    case "outputExcludes": {
      const offending = firstMatch(assertion, capture.outputText);
      return offending === null
        ? pass(assertion, `absent: "${assertion.pattern}"`)
        : fail(assertion, `found forbidden "${offending}"`);
    }

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

function gradeWroteFile(
  assertion: Extract<Assertion, { kind: "wroteFile" }>,
  capture: SolvingCapture,
): AssertionResult {
  const written = capture.writes.find((w) => w.path === assertion.path);
  if (!written) {
    const paths = capture.writes.map((w) => w.path);
    return fail(assertion, `${assertion.path} not written (wrote: [${paths.join(", ")}])`);
  }
  if (assertion.contentMatches === undefined) {
    return pass(assertion, `wrote ${assertion.path}`);
  }
  return textContains(written.content, assertion.contentMatches, assertion.regex)
    ? pass(assertion, `${assertion.path} content matched`)
    : fail(assertion, `${assertion.path} content did not match "${assertion.contentMatches}"`);
}

function outputContains(
  assertion: Extract<Assertion, { kind: "outputMatches" }>,
  output: string,
): boolean {
  return textContains(output, assertion.pattern, assertion.regex);
}

function firstMatch(
  assertion: Extract<Assertion, { kind: "outputExcludes" }>,
  output: string,
): string | null {
  if (!assertion.regex) return output.includes(assertion.pattern) ? assertion.pattern : null;
  const found = new RegExp(assertion.pattern).exec(output);
  return found ? found[0] : null;
}

function textContains(haystack: string, pattern: string, regex: boolean): boolean {
  return regex ? new RegExp(pattern).test(haystack) : haystack.includes(pattern);
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
