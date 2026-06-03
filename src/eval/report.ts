import type { LoadedCase } from "./cases.js";
import type { CaseScore, SolvingRunResult } from "./score.js";
import type { Expectation } from "./schema.js";

export interface SolvingBreakdown {
  readonly perRun: readonly SolvingRunResult[];
}

export interface CaseReport {
  readonly evalCase: LoadedCase;
  readonly score: CaseScore;
  readonly solving?: SolvingBreakdown;
}

export interface EvalReport {
  readonly cases: readonly CaseReport[];
  readonly passed: number;
  readonly failed: number;
}

export function buildReport(cases: readonly CaseReport[]): EvalReport {
  const passed = cases.filter((c) => c.score.pass).length;
  return { cases, passed, failed: cases.length - passed };
}

export function formatConsole(report: EvalReport): string {
  const lines: string[] = [];
  const groups = groupBy(report.cases, (c) => `${c.evalCase.tier}/${c.evalCase.suite}`);

  for (const [group, entries] of groups) {
    lines.push(group);
    for (const entry of entries) {
      lines.push(...formatCase(entry));
    }
    lines.push("");
  }

  const total = report.passed + report.failed;
  const pct = total === 0 ? 0 : Math.round((report.passed / total) * 100);
  lines.push(`Summary: ${report.passed}/${total} cases passed (${pct}%).`);
  return lines.join("\n");
}

export function toJson(report: EvalReport): string {
  return JSON.stringify(
    {
      summary: {
        total: report.passed + report.failed,
        passed: report.passed,
        failed: report.failed,
      },
      cases: report.cases.map(({ evalCase, score, solving }) => ({
        id: evalCase.id,
        suite: evalCase.suite,
        tier: evalCase.tier,
        prompt: evalCase.prompt,
        ...("expect" in evalCase && { expect: evalCase.expect }),
        pass: score.pass,
        matched: score.matched,
        runs: score.runs,
        triggerRate: score.triggerRate,
        threshold: score.threshold,
        ...(solving
          ? { solving: jsonSolving(solving) }
          : { histogram: Object.fromEntries(score.histogram) }),
      })),
    },
    null,
    2,
  );
}

const INDENT = "          ";

function formatCase({ evalCase, score, solving }: CaseReport): string[] {
  const tag = score.pass ? "PASS" : "FAIL";
  const tally = `${score.matched}/${score.runs}`;
  const lines = [`  ${tag}  ${evalCase.id}  ${tally}  → ${describeCase(evalCase)}`];
  if (score.pass) return lines;

  if (solving) lines.push(...solvingFailures(solving));
  else lines.push(`${INDENT}got: ${formatHistogram(score.histogram)}`);
  lines.push(`${INDENT}prompt: ${truncate(evalCase.prompt)}`);
  if (evalCase.note) lines.push(`${INDENT}note: ${evalCase.note}`);
  return lines;
}

function describeCase(evalCase: LoadedCase): string {
  if ("expect" in evalCase) return describeExpectation(evalCase.expect);
  const parts = [`${evalCase.assert.length} assertions`];
  if (evalCase.rubric) parts.push(`${evalCase.rubric.dimensions.length} rubric dims`);
  return parts.join(", ");
}

function solvingFailures(solving: SolvingBreakdown): string[] {
  const lines: string[] = [];
  solving.perRun.forEach((run, index) => {
    const prefix = solving.perRun.length > 1 ? `run ${index + 1} ` : "";
    for (const a of run.assertions) {
      if (!a.pass) lines.push(`${INDENT}${prefix}assert ${a.assertion.kind}: ${a.evidence}`);
    }
    for (const d of run.rubric?.dimensions ?? []) {
      if (d.verdict.pass !== true) {
        lines.push(
          `${INDENT}${prefix}rubric ${d.dimension} (${d.verdict.pass}): ${d.verdict.evidence}`,
        );
      }
    }
  });
  return lines;
}

function jsonSolving(solving: SolvingBreakdown): unknown {
  return solving.perRun.map((run) => ({
    assertions: run.assertions.map((a) => ({
      kind: a.assertion.kind,
      pass: a.pass,
      evidence: a.evidence,
    })),
    rubric: run.rubric
      ? {
          pass: run.rubric.pass,
          dimensions: run.rubric.dimensions.map((d) => ({
            dimension: d.dimension,
            pass: d.verdict.pass,
            evidence: d.verdict.evidence,
          })),
        }
      : null,
  }));
}

function describeExpectation(expectation: Expectation): string {
  if ("noSkill" in expectation) return "(no skill)";
  if ("first" in expectation) return expectation.first;
  if ("anyOf" in expectation) return `one of [${expectation.anyOf.join(", ")}]`;
  return expectation.path.join(" → ");
}

function formatHistogram(histogram: ReadonlyMap<string, number>): string {
  return [...histogram.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => `${id} ×${count}`)
    .join(", ");
}

function truncate(text: string, max = 80): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = groups.get(k);
    if (existing) existing.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}
