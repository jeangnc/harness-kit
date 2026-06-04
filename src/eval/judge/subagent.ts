import { z } from "zod";

import { abstain, parseVerdict, type Judge, type Verdict } from "./verdict.js";

const StructuredOutput = z.object({
  verdict: z.enum(["pass", "fail", "unknown"]),
  evidence: z.string(),
});

const CliResult = z.object({
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
});

export const VERDICT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    verdict: { enum: ["pass", "fail", "unknown"] },
    evidence: { type: "string" },
  },
  required: ["verdict", "evidence"],
  additionalProperties: false,
});

export interface SubagentRequest {
  readonly model: string;
  readonly prompt: string;
}

export type SubagentRunner = (request: SubagentRequest) => Promise<string>;

export interface SubagentJudgeOptions {
  readonly model: string;
  readonly run: SubagentRunner;
}

export function createSubagentJudge(options: SubagentJudgeOptions): Judge {
  return async ({ dimension, criterion, output }) => {
    try {
      const stdout = await options.run({
        model: options.model,
        prompt: buildPrompt(dimension, criterion, output),
      });
      return verdictFrom(stdout);
    } catch (cause) {
      return abstain(cause instanceof Error ? cause.message : "subagent judge failed");
    }
  };
}

function buildPrompt(dimension: string, criterion: string, output: string): string {
  return (
    "You are a strict grader for AI agent outputs. Judge the output against the single " +
    "criterion in isolation. Set verdict to pass only if the criterion is clearly met, fail " +
    "if clearly unmet, and unknown if you genuinely cannot tell. Always cite concrete evidence " +
    `from the output.\n\nDimension: ${dimension}\nCriterion: ${criterion}\n\nOutput to grade:\n${output}`
  );
}

function verdictFrom(stdout: string): Verdict {
  const cli = CliResult.safeParse(safeJson(stdout));
  if (!cli.success) return parseVerdict(null);
  if (cli.data.is_error) return abstain(cli.data.result ?? "subagent judge failed");

  const structured = StructuredOutput.safeParse(cli.data.structured_output);
  if (!structured.success) return parseVerdict(null);
  return toDomain(structured.data);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toDomain({ verdict, evidence }: z.infer<typeof StructuredOutput>): Verdict {
  if (verdict === "unknown") return { pass: "unknown", evidence };
  return { pass: verdict === "pass", evidence };
}
