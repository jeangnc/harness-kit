export {
  CompanionSchema,
  SkillSchema,
  checkCompanionFiles,
  defineSkill,
  findSkillFile,
  formatLoadSkillError,
  isReservedCompanionFilename,
  loadSkill,
} from "./skill/index.js";
export type {
  Companion,
  FindSkillFileError,
  LoadedSkill,
  LoadSkillError,
  Skill,
  SkillFile,
  SkillSource,
} from "./skill/index.js";

export { ContextEntrySchema, PluginSchema, definePlugin } from "./plugin/index.js";
export type { ContextEntry, Plugin } from "./plugin/index.js";

export { formatFrontmatterError, parseFrontmatter } from "./parsing/index.js";
export type { FrontmatterError, ParsedFrontmatter } from "./parsing/index.js";

export { err, ok } from "./result.js";
export type { Result } from "./result.js";

export { parsePlaceholders, substitute } from "./placeholders/index.js";
export type {
  Placeholder,
  SubstituteResult,
  Validator,
  ValidatorRegistry,
  ValidatorResult,
} from "./placeholders/index.js";

export { compile } from "./compile/index.js";
export type { BodyInvariant, CompileOptions, WarningSink } from "./compile/index.js";

export { build } from "./build.js";
export type { BuildOptions } from "./build.js";

export { lint } from "./lint.js";
export type { LintOptions, LintResult } from "./lint.js";

export { install, uninstall } from "./install/index.js";
export type { InstallOptions } from "./install/index.js";

export { initHarness } from "./init/index.js";
export type { InitOptions } from "./init/index.js";

export { loadHarnessConfig } from "./config/harness.js";
export type { HarnessConfig } from "./config/harness.js";

export { builtinVendors } from "./vendor/builtins.js";
export { resolveVendors } from "./vendor/registry.js";
export type {
  DiscoveredVendorPlugin,
  LinkedFile,
  Vendor,
  VendorEmitContext,
  VendorInstallContext,
} from "./vendor/schema.js";

export { check } from "./check/index.js";
export type {
  CheckOptions,
  CheckResult,
  ReferenceViolation,
  ReferenceViolationKind,
  SourceSummary,
} from "./check/index.js";

export { defaultSources, discoverInstalled, indexInstalled } from "./installed.js";
export type {
  InstalledAgent,
  InstalledArtifacts,
  InstalledCommand,
  InstalledIndex,
  InstalledSkill,
  PluginSource,
} from "./installed.js";
