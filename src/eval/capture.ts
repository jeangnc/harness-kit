import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { asRecord, type ToolCall } from "./trajectory.js";

export interface WrittenFile {
  readonly path: string;
  readonly content: string;
}

export interface SolvingCapture {
  readonly outputText: string;
  readonly trajectory: readonly ToolCall[];
  readonly writes: readonly WrittenFile[];
}

const WRITE_TOOLS = new Set(["Write", "Edit"]);

export function captureRun(outputText: string, trajectory: readonly ToolCall[]): SolvingCapture {
  return {
    outputText,
    trajectory,
    writes: trajectory.flatMap((call) => {
      const write = writtenFileOf(call);
      return write ? [write] : [];
    }),
  };
}

function writtenFileOf(call: ToolCall): WrittenFile | null {
  if (!WRITE_TOOLS.has(call.name)) return null;
  const record = asRecord(call.input);
  const path = record["file_path"];
  if (typeof path !== "string") return null;
  const content = record["content"] ?? record["new_string"];
  return { path, content: typeof content === "string" ? content : "" };
}

export async function withDiskWrites(
  capture: SolvingCapture,
  cwd: string,
  declared: readonly string[],
): Promise<SolvingCapture> {
  if (declared.length === 0) return capture;
  const writes = new Map(capture.writes.map((w) => [w.path, w]));
  for (const path of declared) {
    const onDisk = await readFileOrNull(resolve(cwd, path));
    if (onDisk !== null) writes.set(path, { path, content: onDisk });
  }
  return { ...capture, writes: [...writes.values()] };
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
