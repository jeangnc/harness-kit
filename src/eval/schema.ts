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

const Assertion = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("outputMatches"),
    pattern: z.string().min(1),
    regex: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("outputExcludes"),
    pattern: z.string().min(1),
    regex: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("usedTool"), tool: z.string().min(1) }),
  z.object({ kind: z.literal("didNotUseTool"), tool: z.string().min(1) }),
  z.object({
    kind: z.literal("wroteFile"),
    path: z.string().min(1),
    contentMatches: z.string().min(1).optional(),
    regex: z.boolean().default(false),
  }),
]);

const Dimension = z.object({
  dimension: z.string().min(1),
  criterion: z.string().min(1),
});

const CombineRule = z.discriminatedUnion("combine", [
  z.object({ combine: z.literal("all") }),
  z.object({ combine: z.literal("fraction"), threshold: z.number().min(0).max(1) }),
]);

const Rubric = z.object({
  dimensions: z.array(Dimension).min(1),
  combine: CombineRule.default({ combine: "all" }),
});

const CommonCaseFields = {
  id: z.string().min(1),
  prompt: z.string().min(1),
  cwd: z.string().optional(),
  runs: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
  note: z.string().optional(),
};

const RoutingCase = z.object({ ...CommonCaseFields, expect: Expectation }).strict();

const SolvingCase = z
  .object({
    ...CommonCaseFields,
    expectSkill: FqId.optional(),
    assert: z.array(Assertion).default([]),
    rubric: Rubric.optional(),
  })
  .strict();

export const TIERS = ["routing", "solving"] as const;

const RoutingFile = z.object({
  suite: z.string().min(1),
  tier: z.literal("routing"),
  cases: z.array(RoutingCase).min(1),
});

const SolvingFile = z.object({
  suite: z.string().min(1),
  tier: z.literal("solving"),
  cases: z.array(SolvingCase).min(1),
});

export const CaseFileSchema = z.discriminatedUnion("tier", [RoutingFile, SolvingFile]);

export type Tier = (typeof TIERS)[number];
export type Expectation = z.infer<typeof Expectation>;
export type Assertion = z.infer<typeof Assertion>;
export type Rubric = z.infer<typeof Rubric>;
export type CombineRule = z.infer<typeof CombineRule>;
export type RoutingCase = z.infer<typeof RoutingCase>;
export type SolvingCase = z.infer<typeof SolvingCase>;
export type EvalCase = RoutingCase | SolvingCase;
export type CaseFile = z.infer<typeof CaseFileSchema>;

export function expectedSkills(expectation: Expectation): readonly string[] {
  if ("noSkill" in expectation) return [];
  const forbidden = expectation.not ?? [];
  if ("first" in expectation) return [expectation.first, ...forbidden];
  if ("anyOf" in expectation) return [...expectation.anyOf, ...forbidden];
  return [...expectation.path, ...forbidden];
}

export function caseExpectedSkills(evalCase: EvalCase): readonly string[] {
  if ("expect" in evalCase) return expectedSkills(evalCase.expect);
  return evalCase.expectSkill ? [evalCase.expectSkill] : [];
}
