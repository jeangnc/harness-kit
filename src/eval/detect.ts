import { FQ_ID } from "../ids.js";
import { asRecord, type ToolCall } from "./trajectory.js";

export interface DetectionResult {
  readonly observed: readonly string[];
  readonly firstSkill: string | null;
}

export function detectSkills(trajectory: readonly ToolCall[]): DetectionResult {
  const observed = trajectory.flatMap((call) => {
    if (call.name !== "Skill") return [];
    const id = skillIdOf(call.input);
    return id === null ? [] : [id];
  });
  return { observed, firstSkill: observed[0] ?? null };
}

function skillIdOf(input: unknown): string | null {
  const record = asRecord(input);
  const value = record["skill"] ?? record["command"];
  return typeof value === "string" && FQ_ID.test(value) ? value : null;
}
