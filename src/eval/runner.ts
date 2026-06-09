import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

import { createCaptor, type SolvingCapture, type WrittenFile } from "./capture.js";
import { scrubEnv, SUBPROCESS_ENV_OVERRIDES } from "./claude-env.js";
import { createDetector, type DetectionResult } from "./detect.js";
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

export async function runCases(
  cases: readonly LoadedCase[],
  options: RunnerOptions,
): Promise<CaseResult[]> {
  const routing = new Map<LoadedCase, DetectionResult[]>();
  const solving = new Map<LoadedCase, SolvingCapture[]>();
  const jobs = cases.flatMap((evalCase) => {
    if (evalCase.tier === "routing") routing.set(evalCase, []);
    else solving.set(evalCase, []);
    return Array.from({ length: runsFor(evalCase, options) }, () => evalCase);
  });

  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  await forEachLimit(jobs, concurrency, async (evalCase) => {
    if (evalCase.tier === "routing") {
      const result = await runRouting(evalCase, options);
      routing.get(evalCase)?.push(result);
      options.onRun?.(evalCase.id, result);
    } else {
      const capture = await runSolving(evalCase, options);
      solving.get(evalCase)?.push(capture);
      options.onCapture?.(evalCase.id, capture);
    }
  });

  return cases.map((evalCase) =>
    evalCase.tier === "routing"
      ? { tier: "routing", evalCase, runs: routing.get(evalCase) ?? [] }
      : { tier: "solving", evalCase, captures: solving.get(evalCase) ?? [] },
  );
}

function runsFor(evalCase: LoadedCase, options: RunnerOptions): number {
  const fallback = evalCase.tier === "solving" ? DEFAULT_SOLVING_RUNS : DEFAULT_RUNS;
  return evalCase.runs ?? options.runs ?? fallback;
}

function skillsToCollect(evalCase: LoadedRoutingCase): number {
  return "path" in evalCase.expect ? evalCase.expect.path.length : 1;
}

async function runRouting(
  evalCase: LoadedRoutingCase,
  options: RunnerOptions,
): Promise<DetectionResult> {
  const detector = createDetector(skillsToCollect(evalCase));
  const reached = await runSession(evalCase, options, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onLine: (line) => detector.push(line),
    done: () => detector.done,
    killOnDone: true,
  });
  return detector.result(reached ? "timeout" : "no-skill");
}

async function runSolving(
  evalCase: LoadedSolvingCase,
  options: RunnerOptions,
): Promise<SolvingCapture> {
  const captor = createCaptor();
  const reached = await runSession(evalCase, options, {
    timeoutMs: options.solvingTimeoutMs ?? DEFAULT_SOLVING_TIMEOUT_MS,
    onLine: (line) => captor.push(line),
    done: () => captor.done,
    killOnDone: false,
  });
  const capture = captor.result(reached ? "timeout" : "stream-end");
  return mergeDiskWrites(capture, evalCase, options.cwd);
}

interface SessionHandlers {
  readonly timeoutMs: number;
  readonly onLine: (line: string) => void;
  readonly done: () => boolean;
  readonly killOnDone: boolean;
}

async function runSession(
  evalCase: LoadedCase,
  options: RunnerOptions,
  handlers: SessionHandlers,
): Promise<boolean> {
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

  const killOnDone = handlers.killOnDone ? () => child.kill("SIGKILL") : undefined;
  try {
    await Promise.race([
      drain(child.stdout, handlers.onLine, handlers.done, killOnDone),
      spawnFailure,
    ]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  return deadline.reached;
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
