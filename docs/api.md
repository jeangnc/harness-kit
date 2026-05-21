# Programmatic API

Everything the `harness` CLI does is also available as a typed module API. Use this when scripting a multi-step pipeline, embedding harness-kit into a larger build system, or wiring a custom [`Vendor`](./vendors.md).

```ts
import {
  build,
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

## Compile

### `build(options: BuildOptions): Promise<void>`

Compiles `src/` to `dist/`. Reads `harness.yaml` at `repoRoot` to determine vendors when none are passed explicitly.

```ts
await build({
  srcRoot: "./src",
  outRoot: "./dist",
  repoRoot: ".",
  bodyInvariants: [
    /* (body: string) => string[] — extra checks per skill body */
  ],
});
```

`bodyInvariants` run after `{{include:...}}` expansion and before placeholder substitution. Each returns a list of violation messages; any non-empty result fails the build.

### `compile(options: CompileOptions): Promise<void>`

Lower-level compile entry. `build` is `compile` with vendor resolution wired up — prefer `build` unless you need to inject vendors or skip `harness.yaml` reads.

## Lint

### `lint(options: LintOptions): Promise<LintResult>`

```ts
const result = await lint({ outRoot: "./dist", silent: false });
if (result.errorCount > 0) process.exit(1);
```

Runs `markdownlint-cli2` against `plugins/**/*.md` with harness-kit's bundled rules. See the README's CLI section for the rule set.

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
const vendors = resolveVendors(config.vendors, builtinVendors());
await install({ distRoot: "./dist", repoRoot: ".", vendors });
```

Applies config links from `dist/configs.json` (replacing existing symlinks, backing up regular files) and calls each vendor's `install` hook.

### `uninstall(options: InstallOptions): Promise<void>`

Same shape as `install`. Calls each vendor's `uninstall` hook.

> **Note:** `installWithRunner` and `uninstallWithRunner` are exported but `@internal` — they exist so tests can inject a recording `CommandRunner`. Don't depend on them from application code.

## Init

### `initHarness(options: InitOptions): Promise<void>`

```ts
await initHarness({
  repoRoot: ".",
  marketplace: "my-harness",
  vendors: ["claude", "codex"],
});
```

Writes `harness.yaml`, scaffolds `src/configs/common/`, `src/configs/<vendor>/` for each vendor, `src/plugins/`, and adds `dist/` to `.gitignore`. Fails if `harness.yaml` already exists.

## Vendor interface

See [docs/vendors.md](./vendors.md) for the full `Vendor` interface and a walkthrough of writing one.

Helpers exported here:

- `builtinVendors(): readonly Vendor[]` — returns `[claudeVendor, codexVendor]`.
- `resolveVendors(names, available): readonly Vendor[]` — looks up vendor names against an available list; throws on unknown names.
- `loadHarnessConfig(repoRoot): Promise<HarnessConfig>` — parses `harness.yaml` or `harness.yml`.

## Check

### `check(options: CheckOptions): Promise<CheckResult>`

```ts
const result = await check({ srcRoot: "./src", mode: "all" });
for (const v of result.violations) {
  console.log(`${v.file}:${v.line}:${v.column} ${v.token} — ${v.message}`);
}
```

`mode` is `"local"` | `"installed"` | `"all"`. `local` resolves references against local discovery; `installed` resolves against the installed-plugin index; `all` resolves against the union and is the hard gate that fails on any unresolved reference.

## Installed index

Discover and index plugins already installed under a vendor home. Useful for `check --mode=installed` and for ad-hoc tooling that needs to enumerate installed skills/agents/commands.

```ts
import { defaultSources, discoverInstalled, indexInstalled } from "@jean.gnc/harness-kit";

const sources = await defaultSources(); // claude + codex homes
const artifacts = await discoverInstalled(sources);
const index = indexInstalled(artifacts);
```

Types: `InstalledIndex`, `InstalledSkill`, `InstalledAgent`, `InstalledCommand`, `InstalledArtifacts`, `PluginSource`.

## Skill + plugin authoring

Use these in `SKILL.ts` / `PLUGIN.ts` files for typed metadata:

```ts
import { defineSkill, definePlugin } from "@jean.gnc/harness-kit";

export default defineSkill({
  name: "my-skill",
  description: "What the skill does — single line.",
});
```

Also exported: `parsePlaceholders`, `substitute`, `loadSkill`, `findSkillFile`, `checkCompanionFiles`, plus all related schemas (`SkillSchema`, `PluginSchema`, `CompanionSchema`, `ContextEntrySchema`) and types (`Skill`, `Plugin`, `LoadedSkill`, `Companion`, `ContextEntry`, …).

## Result type

A small `Result<T, E>` helper used internally for fallible operations:

```ts
import { err, ok, type Result } from "@jean.gnc/harness-kit";

function parse(input: string): Result<Parsed, string> {
  if (input === "") return err("empty input");
  return ok({ value: input });
}
```
