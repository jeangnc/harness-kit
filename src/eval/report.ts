import type { LoadedCase } from "./cases.js";
import type { CaseScore } from "./score.js";
import type { Expectation } from "./schema.js";

export interface CaseReport {
  readonly evalCase: LoadedCase;
  readonly score: CaseScore;
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
    for (const { evalCase, score } of entries) {
      const tag = score.pass ? "PASS" : "FAIL";
      const tally = `${score.matched}/${score.runs}`;
      lines.push(`  ${tag}  ${evalCase.id}  ${tally}  → ${describeExpectation(evalCase.expect)}`);
      if (!score.pass) {
        lines.push(`          got: ${formatHistogram(score.histogram)}`);
        lines.push(`          prompt: ${truncate(evalCase.prompt)}`);
        if (evalCase.note) lines.push(`          note: ${evalCase.note}`);
      }
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
      cases: report.cases.map(({ evalCase, score }) => ({
        id: evalCase.id,
        suite: evalCase.suite,
        tier: evalCase.tier,
        prompt: evalCase.prompt,
        expect: evalCase.expect,
        pass: score.pass,
        matched: score.matched,
        runs: score.runs,
        triggerRate: score.triggerRate,
        threshold: score.threshold,
        histogram: Object.fromEntries(score.histogram),
      })),
    },
    null,
    2,
  );
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
