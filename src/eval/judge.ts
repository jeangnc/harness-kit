import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const Verdict = z.object({
  pass: z.union([z.boolean(), z.literal("unknown")]),
  evidence: z.string(),
});

export type Verdict = z.infer<typeof Verdict>;

export interface JudgeRequest {
  readonly dimension: string;
  readonly criterion: string;
  readonly output: string;
}

export type Judge = (request: JudgeRequest) => Promise<Verdict>;

function abstain(evidence: string): Verdict {
  return { pass: "unknown", evidence };
}

export function parseVerdict(raw: unknown): Verdict {
  if (raw === undefined || raw === null) return abstain("judge returned no verdict");
  const result = Verdict.safeParse(raw);
  return result.success ? result.data : abstain("judge returned an unparseable verdict");
}

const SYSTEM_PREAMBLE =
  "You are a strict grader for AI agent outputs. Judge the output against the single criterion " +
  "you are given, in isolation. Record a verdict via the tool: pass=true only if the criterion is " +
  'clearly met, pass=false if clearly unmet, and pass="unknown" if you genuinely cannot tell. ' +
  "Always cite concrete evidence from the output.";

const VERDICT_TOOL: Anthropic.Tool = {
  name: "record_verdict",
  description: "Record the grading verdict for one rubric dimension.",
  input_schema: {
    type: "object",
    properties: {
      pass: {
        description: 'true if met, false if unmet, "unknown" if undeterminable',
        anyOf: [{ type: "boolean" }, { type: "string", enum: ["unknown"] }],
      },
      evidence: { type: "string", description: "concrete evidence from the output" },
    },
    required: ["pass", "evidence"],
  },
};

export interface AnthropicJudgeOptions {
  readonly model: string;
  readonly apiKey: string;
  readonly maxTokens?: number;
}

export function createAnthropicJudge(options: AnthropicJudgeOptions): Judge {
  const client = new Anthropic({ apiKey: options.apiKey });
  return async ({ dimension, criterion, output }) => {
    const response = await client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 1024,
      tools: [VERDICT_TOOL],
      tool_choice: { type: "tool", name: VERDICT_TOOL.name },
      system: [{ type: "text", text: SYSTEM_PREAMBLE, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Dimension: ${dimension}\nCriterion: ${criterion}\n\nOutput to grade:\n${output}`,
        },
      ],
    });
    const block = response.content.find((b) => b.type === "tool_use");
    return parseVerdict(block?.input);
  };
}
