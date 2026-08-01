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

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isSkillToolUse(block: Record<string, unknown>): boolean {
  return block["type"] === "tool_use" && block["name"] === "Skill";
}

function skillIdOf(input: unknown): string | null {
  const record = asRecord(input);
  const value = record["skill"] ?? record["command"];
  return typeof value === "string" && FQ_ID.test(value) ? value : null;
}

function skillIdInJson(buffer: string): string | null {
  try {
    return skillIdOf(JSON.parse(buffer));
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
    record(skillIdInJson(pendingSkillJson));
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      const event = asRecord(parsed);
      const type = event["type"];

      if (type === "stream_event") {
        const se = asRecord(event["event"]);
        const seType = se["type"];

        if (seType === "content_block_start") {
          if (isSkillToolUse(asRecord(se["content_block"]))) pendingSkillJson = "";
        } else if (seType === "content_block_delta" && pendingSkillJson !== null) {
          const delta = asRecord(se["delta"]);
          if (delta["type"] === "input_json_delta") {
            const partial = delta["partial_json"];
            if (typeof partial === "string") pendingSkillJson += partial;
            if (skillIdInJson(pendingSkillJson) !== null) flushPending();
          }
        } else if (seType === "content_block_stop" || seType === "message_stop") {
          flushPending();
        }
        return;
      }

      if (type === "assistant") {
        const content = asRecord(event["message"])["content"];
        for (const item of Array.isArray(content) ? content : []) {
          const block = asRecord(item);
          if (isSkillToolUse(block) && record(skillIdOf(block["input"]))) return;
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
