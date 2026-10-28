import type { EvaluateResult } from "promptfoo";

import { asRecord } from "./trajectory.js";

export interface RunMetrics {
  readonly rateLimited: boolean;
  readonly durationMs: number | null;
}

const RATE_LIMITED = /rate.?limit|429/i;

export function runMetrics(row: EvaluateResult): RunMetrics {
  const reported = asRecord(row.response?.metadata)["durationMs"];
  return {
    rateLimited: RATE_LIMITED.test(row.error ?? ""),
    durationMs: typeof reported === "number" ? reported : row.latencyMs,
  };
}
