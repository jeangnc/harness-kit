# Harness Kit

`harness-kit` is a framework for building multi-agent harnesses — author plugins once, target every vendor.

Declare your marketplace and vendors in `harness.yaml`. Author plugins in `src/plugins/` and drop any per-vendor config files in `src/configs/`. `harness build` compiles a per-vendor dist tree, validating cross-references and expanding placeholders along the way. `harness install` links your config files into each vendor's home directory and registers the compiled plugins through each vendor's own CLI. Claude Code and Codex are built in; new vendors implement a single interface.

## Requirements

- Node ≥ 24
- A package manager (pnpm, npm, yarn — pnpm is what this repo uses)
- The `claude` and/or `codex` CLIs on `$PATH` — only needed to run `harness install` / `uninstall`

## Quickstart

```sh
pnpm add @jean.gnc/harness-kit
harness init --marketplace my-harness --vendors claude,codex
# author src/plugins/<plugin>/... (see Authoring below)
harness build
harness install
```

`harness` is the canonical bin; `harness-kit` is an alias.

## How it works

### `harness.yaml`

A declarative repo config with two required fields:

```yaml
marketplace: my-harness
vendors:
  - claude
  - codex
```

Created by `harness init`. Read automatically by `build`, `install`, and `uninstall` via `--repo` (default `.`).

### Vendors

A vendor is a named target with a home directory, a per-vendor manifest path, an `emitPluginManifest` hook, `install`/`uninstall` hooks, and an optional `aliases` hook for fan-out symlink destinations. Built-in:

- **claude** — registers plugins via `claude plugin install`; creates a `CLAUDE.md` symlink whenever an `AGENTS.md` config file is linked.
- **codex** — primes the local cache by copying compiled plugins, then runs `codex plugin marketplace add`.

Writing your own vendor: see [docs/vendors.md](./docs/vendors.md).

### Source layout

```text
harness.yaml
src/
  .claude-plugin/
    marketplace.json                # marketplace metadata (plugins[], owner, etc.)
  configs/
    common/                         # linked into every declared vendor's home
    <vendor>/                       # linked only into that vendor's home
  plugins/
    <plugin>/
      .claude-plugin/plugin.json    # (or PLUGIN.ts)
      skills/<name>/SKILL.md        # (or SKILL.ts + body.md)
      agents/<agent>.md             # optional
      commands/<command>.md         # optional
      hooks/<hook>.json             # optional
```

The marketplace manifest enumerates its plugins under `plugins[]` with a `source: { kind: "relative", path: "..." }` for each; folders not listed there are ignored. Set `metadata.pluginRoot` on the marketplace to rebase that lookup (e.g. `plugins/` lives next to a `packages/` tree).

Plugin manifests can also declare `context: [{ file }]` (files copied into the compiled plugin) and `hookRequires: [{ event, skill|command|agent }]` (hook requirements validated against discovered local IDs at build time).

The marketplace and plugin manifests accept the full upstream Claude Code shape — `homepage`, `repository`, `allowCrossMarketplaceDependenciesOn`, object-form dependencies (`{ name, marketplace }`), and any other documented fields pass through unchanged. Existing Claude marketplaces drop in without rewriting their manifests.

### Compile pipeline

`harness build` reads vendors from `harness.yaml`, validates the marketplace manifest, discovers plugins, checks every `context` file exists, and validates each `hookRequires` against the local artifact IDs. Then for each plugin × vendor pair it emits the per-vendor manifest and compiles skills/agents/commands into `dist/plugins/<vendor>/<plugin>/`. It also copies `dist/.claude-plugin/marketplace.json` and writes a vendor-agnostic `dist/configs.json` link manifest derived from `src/configs/`.

### Install pipeline

`harness install` reads `harness.yaml`, then:

1. Applies links from `dist/configs.json`. Existing symlinks are replaced. Regular files are renamed to `<dest>.backup` (incrementing to `.backup.2`, `.backup.3`, …) before the symlink is created. Orphan symlinks pointing back into the repo are swept before applying.
2. For each declared vendor, discovers compiled plugins under `dist/plugins/<vendor>/` and calls the vendor's `install` hook.

`--dry-run` prints the plan without touching the filesystem.

## Authoring a skill

Skills are auto-discovered by walking `<srcRoot>/plugins/<plugin>/skills/<name>/SKILL.md`. The `name` field in frontmatter must match the skill's folder name.

```md
<!-- SKILL.md -->
---
name: my-skill
description: What the skill does — single line.
companions:
  - file: details.md
    summary: Deeper notes.
---

# My Skill

For type safety conventions, see {{skill:dev-tools:typescript}}.
For TDD discipline, see {{ext:superpowers:test-driven-development}}.
For details, see {{ref:details.md}}.

{{companions}}
```

Compiles to (once per declared vendor):

```md
<!-- dist/plugins/<vendor>/<plugin>/skills/my-skill/SKILL.md -->
---
name: my-skill
description: What the skill does — single line.
companions:
  - file: details.md
    summary: Deeper notes.
---

# My Skill

For type safety conventions, see `dev-tools:typescript`.
For TDD discipline, see `superpowers:test-driven-development`.
For details, see `details.md`.

## Companion files (read on demand)

- `details.md` — Deeper notes.
```

### Composing with includes

Use `{{include:./fragment.md}}` to inline another Markdown file verbatim into the body. Includes expand recursively (an included file may itself contain `{{include:...}}`), and any other placeholders inside the inlined content are resolved against the **host skill**, not the include source.

Constraints:

- Path must be relative and stay inside the skill directory.
- Target must end in `.md`.
- Cycles are detected and fail the build.
- Included files are not copied into `dist/` and are not flagged as undeclared companions.

### Authoring with TypeScript (alternative)

If you prefer typed metadata, use `SKILL.ts` + sibling `body.md` instead of a single `SKILL.md`:

```ts
// SKILL.ts
import { defineSkill } from "@jean.gnc/harness-kit";

export default defineSkill({
  name: "my-skill",
  description: "What the skill does — single line.",
  companions: [{ file: "details.md", summary: "Deeper notes." }],
});
```

```md
<!-- body.md -->
# My Skill

For type safety conventions, see {{skill:dev-tools:typescript}}.
```

A skill folder must contain exactly one of `SKILL.md` or `SKILL.ts`. Both forms run through the same placeholder pipeline and produce identical `dist/` output.

### Placeholder reference

Local skills are auto-discovered by walking `<srcRoot>/plugins/<plugin>/skills/<name>/`. Use `{{skill:...}}` for local references (build fails on typos) and `{{ext:...}}` for cross-plugin references (rendered as-is, no validation).

| Placeholder | Renders to | Validation |
| --- | --- | --- |
| `{{skill:<plugin>:<name>}}` | `` `<plugin>:<name>` `` | Must be a discovered local skill |
| `{{ext:<plugin>:<skill>}}` | `` `<plugin>:<skill>` `` | None — opaque external reference |
| `{{ref:<relative-path>}}` | `` `<relative-path>` `` | Must be a file under the skill directory |
| `{{include:<relative-path.md>}}` | Inlined content of the target file | Must be a `.md` file inside the skill, no cycles |
| `{{companions}}` | Companion files section | Required iff companions are declared |

## CLI

```sh
harness init      # scaffold harness.yaml + src/configs/{common,<vendor>}/ + src/plugins/
harness build     # compile src/ → dist/ per declared vendors
harness lint      # lint compiled markdown under dist/
harness check     # validate plugin references against local + installed sources
harness install   # link configs + register plugins per declared vendor
harness uninstall # remove installed plugins per declared vendor
```

**`harness init`** — `--marketplace <name>` (required), `--vendors <csv>` (required), `--repo <path>` (default `.`), `--silent`. Creates `harness.yaml`, `src/configs/common/`, `src/configs/<vendor>/` for each vendor, `src/plugins/`, and ensures `dist/` is in `.gitignore`. Fails if `harness.yaml` already exists.

**`harness build`** — `--src <path>` (default `./src`), `--out <path>` (default `./dist`), `--repo <path>` (default `.`), `--silent`. Reads vendor list from `harness.yaml`.

**`harness lint`** — `--out <path>` (default `./dist`), `--silent`. Runs `markdownlint-cli2` against `plugins/**/*.md` with harness-kit's bundled rules — `MD013` (line length), `MD041` (first-line h1), and `MD033` (inline HTML) disabled; `MD024` scoped to `siblings_only`; `MD031` allows omitting blank lines around fences inside list items.

**`harness check`** — `--src <path>` (default `./src`), `--mode <local|installed|all>` (default `installed`), `--silent`. `local` validates `{{skill:...}}` against locally discovered skills; `installed` validates `{{ext:...}}` against plugins in the vendor's installed index; `all` does both.

**`harness install`** — `--dist <path>` (default `./dist`), `--repo <path>` (default `.`), `--dry-run`, `--silent`. Vendor scope comes from `harness.yaml`.

**`harness uninstall`** — same flags as `install`.

In your `package.json`:

```json
{
  "scripts": {
    "init:harness": "harness init",
    "build": "harness build",
    "lint": "harness build && harness lint",
    "install:plugins": "harness install",
    "uninstall:plugins": "harness uninstall"
  },
  "dependencies": {
    "@jean.gnc/harness-kit": "latest"
  }
}
```

## Programmatic API

Full reference: [docs/api.md](./docs/api.md). Top-level exports by category:

- **Compile** — `compile`, `build` (+ `CompileOptions`, `BuildOptions`, `BodyInvariant`)
- **Lint** — `lint` (+ `LintOptions`, `LintResult`)
- **Install / Uninstall** — `install`, `uninstall` (+ `InstallOptions`)
- **Init** — `initHarness` (+ `InitOptions`)
- **Vendor interface** — `Vendor`, `VendorEmitContext`, `VendorInstallContext`, `LinkedFile`, `DiscoveredVendorPlugin`, `builtinVendors`, `resolveVendors`, `loadHarnessConfig` (+ `HarnessConfig`)
- **Check** — `check` (+ `CheckOptions`, `CheckResult`, `ExtViolation`, `ExtViolationKind`, `SourceSummary`)
- **Installed index** — `discoverInstalled`, `indexInstalled`, `defaultSources` (+ `InstalledIndex`, `InstalledSkill`, `InstalledAgent`, `InstalledCommand`, `InstalledArtifacts`, `PluginSource`)
- **Skill authoring** — `defineSkill`, `checkCompanionFiles`, `parsePlaceholders`, `substitute`, `loadSkill`, `findSkillFile` (+ schema/type exports)
- **Plugin authoring** — `definePlugin` (+ `Plugin`, `ContextEntry`)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
