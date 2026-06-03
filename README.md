# Harness Kit

`harness-kit` is a framework for building multi-agent harnesses — author plugins once, target every vendor.

## Quickstart

```sh
pnpm add @jean.gnc/harness-kit
harness init --marketplace my-harness --vendors claude,codex
# author src/plugins/<plugin>/... (see Authoring below)
harness compile
harness install
```

`harness` is the canonical bin; `harness-kit` is an alias.

## How it works

### `harness.yaml`

A declarative repo config with two required fields and one optional one:

```yaml
marketplace: my-harness
vendors:
  - claude
  - codex
roots:                       # optional — named include aliases (see Composing with includes)
  shared: src/shared
```

Created by `harness init`. Read automatically by `compile`, `install`, and `uninstall` via `--repo` (default `.`).

### Vendors

A vendor is a named target with a home directory, a per-vendor manifest path, an `emitPluginManifest` hook, `install`/`uninstall` hooks, and an optional `aliases` hook for fan-out symlink destinations. Built-in:

- **claude** — registers plugins via `claude plugin install`; creates a `CLAUDE.md` symlink whenever an `AGENTS.md` config file is linked.
- **codex** — primes the local cache by copying compiled plugins, then runs `codex plugin marketplace add`.

Writing your own vendor: see [docs/vendors.md](./docs/vendors.md).

### Source layout

```text
src/
  <vendor>/configs/             # vendor-specific config files (e.g. AGENTS.md, settings.json)
    .fragments/                 # source-only snippets; never emitted to dist (see Fragments vs companions)
  plugins/<plugin>/             # shared across every declared vendor
    .claude-plugin/plugin.json  # or PLUGIN.ts
    skills/<name>/SKILL.md      # or SKILL.ts + body.md
    agents/<agent>.md           # optional
    commands/<command>.md       # optional
    hooks/<hook>.json           # optional
  .claude-plugin/marketplace.json  # lists the plugins to compile
```

→ Manifest fields, passthrough behavior, and plugin extensions: [docs/marketplace.md](./docs/marketplace.md).

### Compile pipeline

`harness compile` reads vendors from `harness.yaml`, validates the marketplace manifest, discovers plugins, and validates each `hookRequires` against the local artifact IDs. For each declared vendor it emits everything under a single top-level `dist/<vendor>/` subtree:

- `dist/<vendor>/.<vendor>-plugin/marketplace.json` — the per-vendor marketplace manifest.
- `dist/<vendor>/plugins/<plugin>/` — compiled skills/agents/commands plus the per-vendor plugin manifest.
- `dist/<vendor>/configs/` — vendor-specific config files (everything under `src/<vendor>/configs/` minus dot-prefixed entries).

A top-level `dist/configs.json` link manifest enumerates the symlinks `harness install` will create.

### Install pipeline

`harness install` reads `harness.yaml`, then:

1. Applies links from `dist/configs.json`. Existing symlinks are replaced. Regular files are renamed to `<dest>.backup` (incrementing to `.backup.2`, `.backup.3`, …) before the symlink is created. Orphan symlinks pointing back into the repo are swept before applying.
2. For each declared vendor, discovers compiled plugins under `dist/<vendor>/plugins/` and calls the vendor's `install` hook.

`--mode` selects where Claude resolves plugins from: `local` (default) registers the freshly compiled `dist/claude/` tree as a local-scoped marketplace, so uncommitted builds install without publishing; `remote` pulls from the published marketplace. Codex is local-only and ignores the flag.

`--dry-run` prints the plan without touching the filesystem.

`harness update` is the refresh path for an **already-installed** harness: it skips step 1 (no config-link bootstrap, so a symlinked `settings.json` and its `enabledPlugins` are left untouched) and runs step 2 only. It refuses with an error if no vendor reports an existing install, and reports a per-plugin version diff (`added` / `→` / `unchanged` / `removed`) against the versions currently cached.

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
For TDD discipline, see {{skill:superpowers:test-driven-development}}.
For details, see {{ref:details.md}}.

{{companions}}
```

Compiles to (once per declared vendor):

```md
<!-- dist/<vendor>/plugins/<plugin>/skills/my-skill/SKILL.md -->
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

Use `{{include:./.fragments/foo.md}}` to inline another file verbatim into the body. Includes expand recursively (an included file may itself contain `{{include:...}}`), and any other placeholders inside the inlined content are resolved against the **host skill**, not the include source.

An include target is named one of three ways:

| Form | Resolves from | Example |
| --- | --- | --- |
| **relative** | the directory of the including file | `{{include:./.fragments/foo.md}}`, `{{include:../shared/foo.md}}` |
| **`#` repo-root anchor** | the repo root (`--repo`, default `.`) — built in, no declaration | `{{include:#src/shared/foo.md}}` |
| **`@name` alias** | a named root declared under `roots:` in `harness.yaml` | `{{include:@shared/foo.md}}` |

`#` is the repo root; `@name` is whatever path you mapped that name to. Both let a deeply-nested skill reach a shared fragment without a fragile `../../../` chain — pick `#` for an ad-hoc repo-relative path, `@name` for a stable alias you reuse across many skills.

Constraints:

- Cycles are detected and fail the compile.
- An `@name` referencing an undeclared root, or a bare `@name` / `#` with no path, fails the compile.
- Included files are not copied into `dist/` and are not flagged as undeclared companions.

There is no skill-directory boundary and no extension restriction: an include reads any file from anywhere the path points, `.md` or not.

### Fragments vs companions

Two kinds of secondary file appear next to skills, plugins, and configs. They have different lifecycles, so harness-kit gives them different conventions.

| Kind | Lifecycle | Convention | Ships to `dist/`? |
| --- | --- | --- | --- |
| **Fragment** | Compile-time only — inlined via `{{include:...}}` | Leading-dot path (e.g. `.fragments/foo.md`) | No |
| **Companion** | Runtime — read by the artifact (skill, hook, command, agent) at execution | No leading dot (e.g. `details.md`, `companions/foo.md`) | Yes |

**The rule is one sentence: leading dot = source-only.** Any source file or directory whose basename starts with `.` is stripped from dist (the vendor manifest dirs like `.claude-plugin/` are still emitted because each vendor writes them separately). Everything else ships as-is.

Example: a skill that inlines a shared snippet at compile time and ships a runtime companion alongside it.

```text
src/plugins/foo/skills/bar/
  SKILL.md                  # uses {{include:./.fragments/snippet.md}} and references details.md
  .fragments/snippet.md     # stripped from dist
  details.md                # ships; consumed at runtime
```

After `harness compile`:

```text
dist/<vendor>/plugins/foo/skills/bar/
  SKILL.md                  # snippet content inlined
  details.md                # ships unchanged
```

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

Three reference kinds — `skill`, `command`, `agent` — each resolve against the **local marketplace ∪ installed plugins** and render the scoped `<plugin>:<name>` handle. The author never picks a prefix based on where a target lives; a single kind covers both local and cross-plugin references.

Both `harness compile` and `harness check` share one rule, keyed on who owns the reference's plugin. An unresolved **internal** reference — one whose plugin is part of this marketplace, but whose artifact is missing — **fails**: it's your own broken link. An unresolved **external** reference — to a vendor, installed, or otherwise-unknown plugin — only **warns**, so the build stays green on a machine without those plugins installed. A malformed value (not `<plugin>:<name>` shape) is always a hard error.

Writing a reference raw — as the rendered `<plugin>:<name>` handle — instead of through its placeholder bypasses all of this; `harness check` warns (without failing) when it spots one. See [docs/cli.md](./docs/cli.md#harness-check).

| Placeholder | Renders to | Validation |
| --- | --- | --- |
| `{{skill:<plugin>:<name>}}` | `` `<plugin>:<name>` `` | Resolves against local marketplace + installed plugins; internal-missing fails, external-missing warns |
| `{{command:<plugin>:<name>}}` | `` `/<plugin>:<name>` `` | Resolves against local marketplace + installed plugins; internal-missing fails, external-missing warns |
| `{{agent:<plugin>:<name>}}` | `` `<plugin>:<name>` `` | Resolves against local marketplace + installed plugins; internal-missing fails, external-missing warns |
| `{{ref:<relative-path>}}` | `` `<relative-path>` `` | Must be a file under the skill directory |
| `{{include:<path>}}` | Inlined content of the target file | Relative, `#`repo-root, or `@name` alias; any extension, anywhere; no cycles |
| `{{companions}}` | Companion files section | Required iff companions are declared |

## CLI

```sh
harness init      # scaffold harness.yaml + src/<vendor>/configs/ + src/plugins/
harness compile   # compile src/ → dist/ per declared vendors
harness lint      # lint compiled markdown under dist/
harness check     # validate plugin references against local + installed sources
harness install   # bootstrap: link configs + register plugins per declared vendor (--mode=local|remote)
harness update    # refresh plugins for an already-installed harness; skips config links, reports version diff
harness uninstall # remove installed plugins per declared vendor
harness eval      # run routing + solving evals against the installed harness
```

→ Full flag reference, bundled lint rules, and `package.json` integration: [docs/cli.md](./docs/cli.md).

## Evals

`harness eval` runs YAML cases in two tiers. A case file declares its `tier`, and the two
tiers carry mutually exclusive keys.

**Routing** — *did the right skill fire?* The session is killed on the first `Skill` tool_use;
the detector scores against an `expect` clause (`first` / `anyOf` / `path` / `noSkill`).

**Solving** — *did the agent produce the right thing?* The session runs to completion; the
final output, tool trajectory, and written files are graded by **deterministic assertions**
(all must pass) plus an optional **LLM-judge rubric** (one isolated call per dimension).

```yaml
suite: docs
tier: solving
cases:
  - id: writes-a-readme
    prompt: "Create a README.md describing this project."
    expectSkill: dev-tools:typescript      # optional; validated against installed skills
    assert:
      - { kind: wroteFile, path: README.md, contentMatches: "## " }
      - { kind: usedTool, tool: Write }
      - { kind: didNotUseTool, tool: Bash }
      - { kind: outputMatches, pattern: "README", regex: false }
    rubric:
      combine: { combine: fraction, threshold: 0.5 }   # or { combine: all }
      dimensions:
        - { dimension: clarity, criterion: "The README explains what the project does." }
        - { dimension: structure, criterion: "The README has clear sections." }
```

A solving run passes when every assertion passes **and** the rubric meets its combine rule;
across `runs`, the case passes when the pass rate meets `threshold` (default `runs` is 1).

Routing needs no API key. Solving cases that declare a `rubric` use `claude` for the judge —
set `ANTHROPIC_API_KEY` (the run errors clearly if absent). The judge model is separate from
the session model:

```sh
harness eval --tier solving --model claude-opus-4-8 --judge-model claude-sonnet-4-5
```

## Programmatic API

Everything the CLI does is also a typed module API. See [docs/api.md](./docs/api.md).

## Requirements

- Node ≥ 24
- A package manager (pnpm, npm, yarn — pnpm is what this repo uses)
- The `claude` and/or `codex` CLIs on `$PATH` — only needed to run `harness install` / `uninstall`

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
