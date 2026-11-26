# Programmatic API

Everything the `harness` CLI does is also available as a typed module API. Use this when scripting a multi-step pipeline, embedding harness-kit into a larger build system, or wiring a custom [`Vendor`](./vendors.md).

```ts
import {
  build,
  compilePlugins,
  install,
  uninstall,
  initHarness,
  lint,
  check,
  builtinVendors,
  resolveVendors,
  loadHarnessConfig,
} from "@jean.gnc/harness-kit";
```

All exports are re-exported from the package root; see [`src/index.ts`](../src/index.ts) for the full surface.

## Build

### `build(options?: BuildOptions): Promise<void>`

Builds `plugins/`, `configs/`, and named roots into `.harness/`. Reads `harness.yaml` at `repoRoot` (default `.`) to determine vendors unless `vendors` is passed. Emits per-vendor subtrees under `.harness/<vendor>/` (plugins, configs, and the vendor catalog) plus a top-level `.harness/configs.json` link manifest.

```ts
await build({ repoRoot: "." });
```

### `compilePlugins(options: CompilePluginsOptions): Promise<void>`

Lower-level entry that emits plugins and catalogs only. It takes a `Layout` and `vendors` explicitly. `build` adds vendor resolution, a clean `.harness/`, and configs — prefer `build` unless you need that control.

## Lint

### `lint(options: LintOptions): Promise<LintResult>`

```ts
const result = await lint({ repoRoot: ".", silent: false });
if (result.errorCount > 0) process.exit(1);
```

Runs `markdownlint-cli2` against `<vendor>/**/*.md` under `.harness/` with harness-kit's bundled rules. See [cli.md](./cli.md#bundled-rules) for the rule set.

## Install / Uninstall

### `install(options: InstallOptions): Promise<void>`

```ts
import {
  builtinVendors,
  install,
  loadHarnessConfig,
  resolveVendors,
} from "@jean.gnc/harness-kit";

const config = await loadHarnessConfig(".");
const vendors = resolveVendors(
  config.vendors.map((vendor) => vendor.name),
  builtinVendors(),
);
await install({ repoRoot: ".", vendors, mode: "local" });
```

Applies config links from `.harness/configs.json` (replacing existing symlinks, backing up regular files) and calls each vendor's `install` hook. `mode` is `"local"` (default) or `"remote"`; remote mode resolves the GitHub repository from `GITHUB_REPOSITORY` or the `origin` remote unless `repository` is passed, and reads each vendor's `ref` from `harness.yaml` in `repoRoot` unless `refs` is passed. It fails before touching any vendor when one has no ref.

### `uninstall(options: InstallOptions): Promise<void>`

Same shape as `install`. Calls each vendor's `uninstall` hook.

> **Note:** `installWithRunner` and `uninstallWithRunner` are exported but `@internal` — they exist so tests can inject a recording `CommandRunner`. Don't depend on them from application code.

## Init

### `initHarness(options: InitOptions): Promise<void>`

```ts
await initHarness({
  repoRoot: ".",
  marketplace: "my-harness",
  owner: { name: "you" },
  vendors: ["claude", "codex"],
});
```

Writes `harness.yaml`, scaffolds `plugins/` and `configs/`, writes `.github/workflows/harness.yml`, and adds `.harness/` to `.gitignore`. Fails if `harness.yaml` or the workflow already exists.

## Vendor interface

See [docs/vendors.md](./vendors.md) for the full `Vendor` interface and a walkthrough of writing one.

Helpers exported here:

- `builtinVendors(): readonly Vendor[]` — returns `[claudeVendor, codexVendor]`.
- `resolveVendors(names, available): readonly Vendor[]` — looks up vendor names against an available list; throws on unknown names.
- `loadHarnessConfig(repoRoot): Promise<HarnessConfig>` — parses `harness.yaml` or `harness.yml`.

## Check

### `check(options: CheckOptions): Promise<CheckResult>`

```ts
const result = await check({ repoRoot: "." });
for (const v of result.violations) {
  console.log(`${v.file}:${v.line}:${v.column} ${v.token} — ${v.message}`);
}
```

References resolve against the union of local artifacts and the installed-plugin index. An unresolved reference into a **local** plugin (artifact missing) is a `violation`; an unresolved reference into an **external** plugin is an `unresolved-external` entry in `warnings`. Pass `sources` to override the installed-plugin index (defaults to the vendor homes).

Pass `docRoots` to scan files outside `plugins/` — repo docs that name skills but would otherwise keep stale names through a rename. Each entry is a directory (walked for `.md`) or a single file; paths already inside a plugin directory are skipped. Docs own no plugin, so the `{{ref:}}` plugin-boundary rule does not apply to them.

## Installed index

Discover and index plugins already installed under a vendor home. Useful for the `sources` override on `check` and for ad-hoc tooling that needs to enumerate installed skills/agents/commands.

```ts
import { defaultSources, discoverInstalled, indexInstalled } from "@jean.gnc/harness-kit";

const sources = defaultSources(); // claude + codex homes
const artifacts = await discoverInstalled(sources);
const index = indexInstalled(artifacts);
```

Types: `InstalledIndex`, `InstalledSkill`, `InstalledAgent`, `InstalledCommand`, `InstalledArtifacts`, `PluginSource`.

## Eval

Run routing + solving evals and render the report. `runEval` loads cases from `casesDir`, runs them, and returns a `Result` — `err` carries the per-file load errors when a case file is malformed.

```ts
import { runEval, formatConsole, toJson } from "@jean.gnc/harness-kit";

const result = await runEval({ casesDir: "./evals/cases", cwd: "." });
if (!result.ok) throw new Error(`bad case files: ${result.error.length}`);

const report = result.value;            // { cases, passed, failed }
console.log(formatConsole(report));     // human-readable table
await writeFile("out.json", toJson(report));
```

`EvalOptions` narrows a run: `suite`, `caseId`, `tier`, `runs`, `concurrency`, `model`, `judgeModel`, `solvingTimeoutMs`. Inject a custom `judge` to bypass the default `claude`-CLI judge, or an `onRun` callback for progress. Sessions and the judge spawn the `claude` CLI on its own auth — no API key.

Case files are validated by `CaseFileSchema` (exported alongside `TIERS`); types: `EvalReport`, `CaseReport`, `CaseFile`, `EvalCase`, `Expectation`, `Tier`.

## Skill + plugin schemas

Exported for tooling that reads authored files: `parsePlaceholders`, `substitute`, `loadSkill`, `findSkillFile`, `checkCompanionFiles`, plus all related schemas (`SkillSchema`, `PluginSchema`, `CompanionSchema`) and types (`Skill`, `Plugin`, `LoadedSkill`, `Companion`, …).

## Result type

A small `Result<T, E>` helper used internally for fallible operations:

```ts
import { err, ok, type Result } from "@jean.gnc/harness-kit";

function parse(input: string): Result<Parsed, string> {
  if (input === "") return err("empty input");
  return ok({ value: input });
}
```
