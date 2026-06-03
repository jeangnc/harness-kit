import { asRecord } from "./detect.js";

export type CaptureExitReason = "result" | "timeout" | "stream-end";

export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

export interface WrittenFile {
  readonly path: string;
  readonly content: string;
}

export interface SolvingCapture {
  readonly outputText: string;
  readonly trajectory: readonly ToolCall[];
  readonly writes: readonly WrittenFile[];
  readonly exitReason: CaptureExitReason;
}

interface Captor {
  readonly push: (line: string) => void;
  readonly done: boolean;
  readonly result: (reason: CaptureExitReason) => SolvingCapture;
}

const WRITE_TOOLS = new Set(["Write", "Edit"]);

export function createCaptor(): Captor {
  const trajectory: ToolCall[] = [];
  const writes: WrittenFile[] = [];
  let lastAssistantText = "";
  let resultText: string | null = null;
  let finished = false;

  function recordToolUse(block: Record<string, unknown>): void {
    const name = block["name"];
    if (typeof name !== "string") return;
    trajectory.push({ name, input: block["input"] });
    const write = writtenFileOf(name, block["input"]);
    if (write) writes.push(write);
  }

  function recordText(block: Record<string, unknown>): void {
    const text = block["text"];
    if (typeof text === "string") lastAssistantText = text;
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

      if (event["type"] === "assistant") {
        const content = asRecord(event["message"])["content"];
        for (const item of Array.isArray(content) ? content : []) {
          const block = asRecord(item);
          if (block["type"] === "tool_use") recordToolUse(block);
          else if (block["type"] === "text") recordText(block);
        }
        return;
      }

      if (event["type"] === "result") {
        const text = event["result"];
        resultText = typeof text === "string" ? text : "";
        finished = true;
      }
    },
    result(reason: CaptureExitReason): SolvingCapture {
      const outputText = resultText && resultText.length > 0 ? resultText : lastAssistantText;
      return {
        outputText,
        trajectory,
        writes,
        exitReason: resultText !== null ? "result" : reason,
      };
    },
  };
}

function writtenFileOf(name: string, input: unknown): WrittenFile | null {
  if (!WRITE_TOOLS.has(name)) return null;
  const record = asRecord(input);
  const path = record["file_path"];
  if (typeof path !== "string") return null;
  const content = record["content"] ?? record["new_string"];
  return { path, content: typeof content === "string" ? content : "" };
}
