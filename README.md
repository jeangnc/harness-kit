# Harness Kit

`harness-kit` is a framework for building multi-agent harnesses — author plugins once, target every vendor.

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

Two trees live under `src/`:

```text
src/configs/
  common/        # linked into every declared vendor's home
  <vendor>/      # linked only into that vendor's home
```

```text
src/plugins/<plugin>/
  .claude-plugin/plugin.json    # or PLUGIN.ts
  skills/<name>/SKILL.md        # or SKILL.ts + body.md
  agents/<agent>.md             # optional
  commands/<command>.md         # optional
  hooks/<hook>.json             # optional
```

Plus `src/.claude-plugin/marketplace.json` at the root, listing the plugins to compile.

→ Manifest fields, passthrough behavior, and plugin extensions: [docs/marketplace.md](./docs/marketplace.md).

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

→ Full flag reference, bundled lint rules, and `package.json` integration: [docs/cli.md](./docs/cli.md).

## Programmatic API

Everything the CLI does is also a typed module API. See [docs/api.md](./docs/api.md).

## Requirements

- Node ≥ 24
- A package manager (pnpm, npm, yarn — pnpm is what this repo uses)
- The `claude` and/or `codex` CLIs on `$PATH` — only needed to run `harness install` / `uninstall`

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
