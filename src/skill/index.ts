export { CompanionSchema, SkillSchema, isReservedCompanionFilename } from "./schema.js";
export type { Companion, Skill } from "./schema.js";

export { SKILL_FILE, findSkillFile, formatLoadSkillError, loadSkill } from "./source.js";
export type { LoadSkillError, LoadedSkill } from "./source.js";

export { checkCompanionFiles } from "./invariants.js";

export { IDENTITY_VIEW, expandIncludes, formatIncludeError } from "./includes.js";
export type { ExpandedBody, IncludeError, IncludeRoots, SourceView } from "./includes.js";
