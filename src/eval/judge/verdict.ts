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

export function abstain(evidence: string): Verdict {
  return { pass: "unknown", evidence };
}

export function parseVerdict(raw: unknown): Verdict {
  if (raw === undefined || raw === null) return abstain("judge returned no verdict");
  const result = Verdict.safeParse(raw);
  return result.success ? result.data : abstain("judge returned an unparseable verdict");
}
