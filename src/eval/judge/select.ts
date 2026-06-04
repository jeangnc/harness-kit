import { createClaudeCliRunner } from "./claude-cli.js";
import { createSubagentJudge, VERDICT_SCHEMA } from "./subagent.js";
import type { Judge } from "./verdict.js";

export const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5";

export interface SelectJudgeOptions {
  readonly model: string;
  readonly override?: Judge;
  readonly claudeBin?: string;
}

export function selectJudge(options: SelectJudgeOptions): Judge {
  if (options.override) return options.override;
  return createSubagentJudge({
    model: options.model,
    run: createClaudeCliRunner({
      schema: VERDICT_SCHEMA,
      ...(options.claudeBin !== undefined && { bin: options.claudeBin }),
    }),
  });
}
