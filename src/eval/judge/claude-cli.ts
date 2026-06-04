import { spawn } from "node:child_process";

import { scrubEnv, SUBPROCESS_ENV_OVERRIDES } from "../claude-env.js";
import type { SubagentRunner } from "./subagent.js";

export function judgeArgs(prompt: string, model: string, schema: string): string[] {
  return ["-p", prompt, "--output-format", "json", "--model", model, "--json-schema", schema];
}

export interface ClaudeCliOptions {
  readonly bin?: string;
  readonly schema: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function createClaudeCliRunner(options: ClaudeCliOptions): SubagentRunner {
  return async ({ model, prompt }) =>
    captureStdout(options.bin ?? "claude", judgeArgs(prompt, model, options.schema), {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
}

interface SpawnOptions {
  readonly timeoutMs: number;
}

async function captureStdout(bin: string, args: string[], opts: SpawnOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: scrubEnv(process.env, SUBPROCESS_ENV_OVERRIDES),
      stdio: ["ignore", "pipe", "ignore"],
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const timedOut = { reached: false };
    const timer = setTimeout(() => {
      timedOut.reached = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn claude: ${cause.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut.reached) reject(new Error(`claude judge timed out after ${opts.timeoutMs}ms`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
