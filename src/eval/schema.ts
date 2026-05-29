import { z } from "zod";

import { FQ_ID } from "../ids.js";

const FqId = z.string().regex(FQ_ID, "must be a `plugin:name` id");

const FirstExpectation = z.object({
  first: FqId,
  not: z.array(FqId).optional(),
});

const AnyOfExpectation = z.object({
  anyOf: z.array(FqId).min(1),
  not: z.array(FqId).optional(),
});

const PathExpectation = z.object({
  path: z.array(FqId).min(2),
  not: z.array(FqId).optional(),
});

const NoSkillExpectation = z.object({
  noSkill: z.literal(true),
});

const Expectation = z.union([
  FirstExpectation,
  AnyOfExpectation,
  PathExpectation,
  NoSkillExpectation,
]);

const Case = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  expect: Expectation,
  cwd: z.string().optional(),
  runs: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
  note: z.string().optional(),
});

export const TIERS = ["routing", "solving"] as const;

export const CaseFileSchema = z.object({
  suite: z.string().min(1),
  tier: z.enum(TIERS),
  cases: z.array(Case).min(1),
});

export type Tier = (typeof TIERS)[number];
export type Expectation = z.infer<typeof Expectation>;
export type EvalCase = z.infer<typeof Case>;
export type CaseFile = z.infer<typeof CaseFileSchema>;

export function expectedSkills(expectation: Expectation): readonly string[] {
  if ("noSkill" in expectation) return [];
  const forbidden = expectation.not ?? [];
  if ("first" in expectation) return [expectation.first, ...forbidden];
  if ("anyOf" in expectation) return [...expectation.anyOf, ...forbidden];
  return [...expectation.path, ...forbidden];
}
