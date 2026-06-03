export {
  CompanionSchema,
  SkillSchema,
  defineSkill,
  isReservedCompanionFilename,
} from "./schema.js";
export type { Companion, Skill } from "./schema.js";

export { findSkillFile, formatLoadSkillError, loadSkill } from "./source.js";
export type {
  FindSkillFileError,
  LoadSkillError,
  LoadedSkill,
  SkillFile,
  SkillSource,
} from "./source.js";

export { checkCompanionFiles } from "./invariants.js";

export { expandIncludes, formatIncludeError } from "./includes.js";
export type { ExpandedBody, IncludeError, IncludeRoots } from "./includes.js";
