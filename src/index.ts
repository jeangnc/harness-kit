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

export { PluginSchema, definePlugin } from "./plugin/index.js";
export type { Plugin } from "./plugin/index.js";

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

export { compilePlugins } from "./compile/index.js";
export type { CompilePluginsOptions, WarningSink } from "./compile/index.js";

export { compile } from "./compile.js";
export type { CompileOptions } from "./compile.js";

export { lint } from "./lint.js";
export type { LintOptions, LintResult } from "./lint.js";

export { install, uninstall } from "./install/index.js";
export type { InstallOptions } from "./install/index.js";
export { INSTALL_MODES, isInstallMode, parseInstallMode } from "./install/mode.js";
export type { InstallMode } from "./install/mode.js";

export { initHarness } from "./init/index.js";
export type { InitOptions } from "./init/index.js";

export { loadHarnessConfig } from "./config/harness.js";
export type { HarnessConfig } from "./config/harness.js";

export { builtinVendors } from "./vendor/builtins.js";
export { resolveVendors } from "./vendor/registry.js";
export type {
  DiscoveredVendorPlugin,
  LinkedFile,
  PluginPartition,
  Vendor,
  VendorEmitContext,
  VendorInstallContext,
} from "./vendor/schema.js";

export { check } from "./check/index.js";
export type {
  BypassWarning,
  CheckOptions,
  CheckResult,
  ReferenceViolation,
  ReferenceViolationKind,
  SourceSummary,
} from "./check/index.js";

export { runEval, formatConsole, toJson } from "./eval/index.js";
export type {
  EvalOptions,
  EvalReport,
  CaseReport,
  LoadedCase,
  CaseLoadError,
} from "./eval/index.js";
export { CaseFileSchema, TIERS } from "./eval/schema.js";
export type { CaseFile, EvalCase, Expectation, Tier } from "./eval/schema.js";

export { defaultSources, discoverInstalled, indexInstalled } from "./installed.js";
export type {
  InstalledAgent,
  InstalledArtifacts,
  InstalledCommand,
  InstalledIndex,
  InstalledSkill,
  PluginSource,
} from "./installed.js";
