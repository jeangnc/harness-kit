import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

import { createCaptor, type SolvingCapture, type WrittenFile } from "./capture.js";
import { scrubEnv, SUBPROCESS_ENV_OVERRIDES } from "./claude-env.js";
import { createDetector, type DetectionResult } from "./detect.js";
import { createMetrics, type RunMetrics } from "./metrics.js";
import type { LoadedCase, LoadedRoutingCase, LoadedSolvingCase } from "./cases.js";

const DEFAULT_RUNS = 5;
const DEFAULT_SOLVING_RUNS = 1;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_SOLVING_TIMEOUT_MS = 300_000;

export interface RunnerOptions {
  readonly cwd: string;
  readonly runs?: number;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly solvingTimeoutMs?: number;
  readonly model?: string;
  readonly enabledPlugins?: ReadonlySet<string>;
  readonly claudeBin?: string;
  readonly onRun?: (caseId: string, result: DetectionResult) => void;
  readonly onCapture?: (caseId: string, capture: SolvingCapture) => void;
}

export type CaseResult =
  | {
      readonly tier: "routing";
      readonly evalCase: LoadedRoutingCase;
      readonly runs: readonly DetectionResult[];
    }
  | {
      readonly tier: "solving";
      readonly evalCase: LoadedSolvingCase;
      readonly captures: readonly SolvingCapture[];
    };

export interface RunOutcome {
  readonly results: readonly CaseResult[];
  readonly metrics: readonly RunMetrics[];
}

export async function runCases(
  cases: readonly LoadedCase[],
  options: RunnerOptions,
): Promise<RunOutcome> {
  const routing = new Map<LoadedCase, DetectionResult[]>();
  const solving = new Map<LoadedCase, SolvingCapture[]>();
  const metrics: RunMetrics[] = [];
  const jobs = cases.flatMap((evalCase) => {
    if (evalCase.tier === "routing") routing.set(evalCase, []);
    else solving.set(evalCase, []);
    return Array.from({ length: runsFor(evalCase, options) }, () => evalCase);
  });

  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  await forEachLimit(jobs, concurrency, async (evalCase) => {
    if (evalCase.tier === "routing") {
      const run = await runRouting(evalCase, options);
      routing.get(evalCase)?.push(run.result);
      metrics.push(run.metrics);
      options.onRun?.(evalCase.id, run.result);
    } else {
      const run = await runSolving(evalCase, options);
      solving.get(evalCase)?.push(run.result);
      metrics.push(run.metrics);
      options.onCapture?.(evalCase.id, run.result);
    }
  });

  const results = cases.map(
    (evalCase): CaseResult =>
      evalCase.tier === "routing"
        ? { tier: "routing", evalCase, runs: routing.get(evalCase) ?? [] }
        : { tier: "solving", evalCase, captures: solving.get(evalCase) ?? [] },
  );
  return { results, metrics };
}

function runsFor(evalCase: LoadedCase, options: RunnerOptions): number {
  const fallback = evalCase.tier === "solving" ? DEFAULT_SOLVING_RUNS : DEFAULT_RUNS;
  return evalCase.runs ?? options.runs ?? fallback;
}

function skillsToCollect(evalCase: LoadedRoutingCase): number {
  return "path" in evalCase.expect ? evalCase.expect.path.length : 1;
}

interface RoutingRun {
  readonly result: DetectionResult;
  readonly metrics: RunMetrics;
}

async function runRouting(
  evalCase: LoadedRoutingCase,
  options: RunnerOptions,
): Promise<RoutingRun> {
  const detector = createDetector(skillsToCollect(evalCase));
  const session = await runSession(evalCase, options, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onLine: (line) => detector.push(line),
    done: () => detector.done,
    killOnDone: true,
  });
  return {
    result: detector.result(session.reached ? "timeout" : "no-skill"),
    metrics: session.metrics,
  };
}

interface SolvingRun {
  readonly result: SolvingCapture;
  readonly metrics: RunMetrics;
}

async function runSolving(
  evalCase: LoadedSolvingCase,
  options: RunnerOptions,
): Promise<SolvingRun> {
  const captor = createCaptor();
  const session = await runSession(evalCase, options, {
    timeoutMs: options.solvingTimeoutMs ?? DEFAULT_SOLVING_TIMEOUT_MS,
    onLine: (line) => captor.push(line),
    done: () => captor.done,
    killOnDone: false,
  });
  const capture = captor.result(session.reached ? "timeout" : "stream-end");
  return {
    result: await mergeDiskWrites(capture, evalCase, options.cwd),
    metrics: session.metrics,
  };
}

interface SessionHandlers {
  readonly timeoutMs: number;
  readonly onLine: (line: string) => void;
  readonly done: () => boolean;
  readonly killOnDone: boolean;
}

interface SessionResult {
  readonly reached: boolean;
  readonly metrics: RunMetrics;
}

async function runSession(
  evalCase: LoadedCase,
  options: RunnerOptions,
  handlers: SessionHandlers,
): Promise<SessionResult> {
  const cwd = evalCase.cwd ? resolveCwd(options.cwd, evalCase.cwd) : options.cwd;
  const argsOptions: BuildArgsOptions = {
    ...(options.model !== undefined && { model: options.model }),
    ...(options.enabledPlugins !== undefined && { enabledPlugins: options.enabledPlugins }),
  };
  const child = spawn(options.claudeBin ?? "claude", buildArgs(evalCase.prompt, argsOptions), {
    cwd,
    env: scrubEnv(process.env, SUBPROCESS_ENV_OVERRIDES),
    stdio: ["ignore", "pipe", "ignore"],
  });

  const spawnFailure = new Promise<never>((_, reject) => {
    child.on("error", (cause) => reject(new Error(`failed to spawn claude: ${cause.message}`)));
  });

  const deadline = { reached: false };
  const timer = setTimeout(() => {
    deadline.reached = true;
    child.kill("SIGKILL");
  }, handlers.timeoutMs);

  const metrics = createMetrics();
  const onLine = (line: string) => {
    metrics.push(line);
    handlers.onLine(line);
  };

  const killOnDone = handlers.killOnDone ? () => child.kill("SIGKILL") : undefined;
  try {
    await Promise.race([drain(child.stdout, onLine, handlers.done, killOnDone), spawnFailure]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  return { reached: deadline.reached, metrics: metrics.result() };
}

export interface BuildArgsOptions {
  readonly model?: string;
  readonly enabledPlugins?: ReadonlySet<string>;
}

export function buildArgs(prompt: string, options: BuildArgsOptions = {}): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.enabledPlugins?.size) {
    const enabledPlugins = Object.fromEntries(
      [...options.enabledPlugins].map((key) => [key, true]),
    );
    args.push("--settings", JSON.stringify({ enabledPlugins }));
  }
  return args;
}

async function drain(
  stdout: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  done: () => boolean,
  killOnDone?: () => void,
): Promise<void> {
  const lines = createInterface({ input: stdout });
  for await (const line of lines) {
    onLine(line);
    if (done()) {
      killOnDone?.();
      break;
    }
  }
}

async function mergeDiskWrites(
  capture: SolvingCapture,
  evalCase: LoadedSolvingCase,
  baseCwd: string,
): Promise<SolvingCapture> {
  const declared = declaredWritePaths(evalCase);
  if (declared.length === 0) return capture;

  const cwd = evalCase.cwd ? resolveCwd(baseCwd, evalCase.cwd) : baseCwd;
  const writes = new Map(capture.writes.map((w) => [w.path, w]));
  for (const path of declared) {
    const onDisk = await readFileOrNull(resolveCwd(cwd, path));
    if (onDisk !== null) writes.set(path, { path, content: onDisk });
  }
  return { ...capture, writes: [...writes.values()] as readonly WrittenFile[] };
}

function declaredWritePaths(evalCase: LoadedSolvingCase): string[] {
  return evalCase.assert.flatMap((a) => (a.kind === "wroteFile" ? [a.path] : []));
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
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
