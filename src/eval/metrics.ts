import { asRecord } from "./detect.js";

export interface RunMetrics {
  readonly rateLimited: boolean;
  readonly durationMs: number | null;
}

interface Metrics {
  readonly push: (line: string) => void;
  readonly result: () => RunMetrics;
}

export function createMetrics(): Metrics {
  let rateLimited = false;
  let durationMs: number | null = null;

  return {
    push(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      const event = asRecord(parsed);

      if (event["type"] === "rate_limit_event") {
        if (asRecord(event["rate_limit_info"])["status"] === "rejected") rateLimited = true;
        return;
      }

      if (event["type"] === "result") {
        const ms = event["duration_ms"];
        if (typeof ms === "number") durationMs = ms;
      }
    },
    result: () => ({ rateLimited, durationMs }),
  };
}
