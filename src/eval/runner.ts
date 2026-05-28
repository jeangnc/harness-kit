import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

import { createDetector, type DetectionResult } from "./detect.js";
import type { LoadedCase } from "./cases.js";

const DEFAULT_RUNS = 5;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunnerOptions {
  readonly cwd: string;
  readonly runs?: number;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly claudeBin?: string;
  readonly onRun?: (caseId: string, result: DetectionResult) => void;
}

export interface CaseRuns {
  readonly evalCase: LoadedCase;
  readonly runs: readonly DetectionResult[];
}

export async function runCases(
  cases: readonly LoadedCase[],
  options: RunnerOptions,
): Promise<CaseRuns[]> {
  const byCase = new Map<LoadedCase, DetectionResult[]>();
  const jobs = cases.flatMap((evalCase) => {
    byCase.set(evalCase, []);
    const count = evalCase.runs ?? options.runs ?? DEFAULT_RUNS;
    return Array.from({ length: count }, () => evalCase);
  });

  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  await forEachLimit(jobs, concurrency, async (evalCase) => {
    const result = await runOnce(evalCase, options);
    byCase.get(evalCase)?.push(result);
    options.onRun?.(evalCase.id, result);
  });

  return cases.map((evalCase) => ({ evalCase, runs: byCase.get(evalCase) ?? [] }));
}

function skillsToCollect(evalCase: LoadedCase): number {
  return "path" in evalCase.expect ? evalCase.expect.path.length : 1;
}

async function runOnce(evalCase: LoadedCase, options: RunnerOptions): Promise<DetectionResult> {
  const cwd = evalCase.cwd ? resolveCwd(options.cwd, evalCase.cwd) : options.cwd;
  const args = [
    "-p",
    evalCase.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (options.model) args.push("--model", options.model);

  const env = { ...process.env };
  delete env["CLAUDECODE"];

  const detector = createDetector(skillsToCollect(evalCase));
  const child = spawn(options.claudeBin ?? "claude", args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });

  const spawnFailure = new Promise<never>((_, reject) => {
    child.on("error", (cause) => reject(new Error(`failed to spawn claude: ${cause.message}`)));
  });

  const deadline = { reached: false };
  const timer = setTimeout(() => {
    deadline.reached = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    await Promise.race([drain(child.stdout, () => child.kill("SIGKILL"), detector), spawnFailure]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  return detector.result(deadline.reached ? "timeout" : "no-skill");
}

async function drain(
  stdout: NodeJS.ReadableStream,
  stop: () => void,
  detector: ReturnType<typeof createDetector>,
): Promise<void> {
  const lines = createInterface({ input: stdout });
  for await (const line of lines) {
    detector.push(line);
    if (detector.done) {
      stop();
      break;
    }
  }
}

function resolveCwd(base: string, caseCwd: string): string {
  return isAbsolute(caseCwd) ? caseCwd : resolve(base, caseCwd);
}

async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}
