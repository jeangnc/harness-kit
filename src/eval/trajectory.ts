export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function hasTrajectory(metadata: unknown): boolean {
  return Array.isArray(toolCallsOf(metadata));
}

export function trajectoryOf(metadata: unknown): ToolCall[] {
  const calls = toolCallsOf(metadata);
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call) => {
    const record = asRecord(call);
    const name = record["name"];
    return typeof name === "string" ? [{ name, input: record["input"] }] : [];
  });
}

function toolCallsOf(metadata: unknown): unknown {
  return asRecord(metadata)["toolCalls"];
}
