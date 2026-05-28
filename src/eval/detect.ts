import { FQ_ID } from "../ids.js";

export type ExitReason = "skill" | "no-skill" | "timeout" | "stream-end";

export interface DetectionResult {
  readonly observed: readonly string[];
  readonly firstSkill: string | null;
  readonly exitReason: ExitReason;
}

interface Detector {
  readonly push: (line: string) => void;
  readonly done: boolean;
  readonly result: (reason: ExitReason) => DetectionResult;
}

function skillIdOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const value = record["skill"] ?? record["command"];
  return typeof value === "string" && FQ_ID.test(value) ? value : null;
}

function parseSkillInput(buffer: string): unknown {
  try {
    return JSON.parse(buffer);
  } catch {
    return null;
  }
}

export function createDetector(stopAfter = 1): Detector {
  const observed: string[] = [];
  let pendingSkillJson: string | null = null;
  let finished = false;

  function record(id: string | null): boolean {
    if (id !== null) observed.push(id);
    if (observed.length >= stopAfter) finished = true;
    return finished;
  }

  function flushPending(): void {
    if (pendingSkillJson === null) return;
    record(skillIdOf(parseSkillInput(pendingSkillJson)));
    pendingSkillJson = null;
  }

  return {
    get done() {
      return finished;
    },
    push(line: string) {
      if (finished) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = event["type"];

      if (type === "stream_event") {
        const se = (event["event"] ?? {}) as Record<string, unknown>;
        const seType = se["type"];

        if (seType === "content_block_start") {
          const block = (se["content_block"] ?? {}) as Record<string, unknown>;
          if (block["type"] === "tool_use" && block["name"] === "Skill") {
            pendingSkillJson = "";
          }
        } else if (seType === "content_block_delta" && pendingSkillJson !== null) {
          const delta = (se["delta"] ?? {}) as Record<string, unknown>;
          if (delta["type"] === "input_json_delta") {
            const partial = delta["partial_json"];
            if (typeof partial === "string") pendingSkillJson += partial;
            if (skillIdOf(parseSkillInput(pendingSkillJson)) !== null) flushPending();
          }
        } else if (seType === "content_block_stop") {
          flushPending();
        } else if (seType === "message_stop") {
          flushPending();
          finished = true;
        }
        return;
      }

      if (type === "assistant") {
        const message = (event["message"] ?? {}) as Record<string, unknown>;
        const content = (message["content"] ?? []) as unknown[];
        for (const item of content) {
          const block = item as Record<string, unknown>;
          if (block["type"] === "tool_use" && block["name"] === "Skill") {
            if (record(skillIdOf(block["input"]))) return;
          }
        }
        return;
      }

      if (type === "result") {
        finished = true;
      }
    },
    result(reason: ExitReason): DetectionResult {
      return {
        observed,
        firstSkill: observed[0] ?? null,
        exitReason: observed.length > 0 ? "skill" : reason,
      };
    },
  };
}
