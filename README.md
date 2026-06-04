# Harness Kit

`harness-kit` is a framework for building multi-agent harnesses — author plugins once, target every vendor.

## Quickstart

```sh
pnpm add @jean.gnc/harness-kit
harness init --marketplace my-harness --vendors claude,codex
# author src/plugins/<plugin>/... (see docs/authoring.md)
harness compile
harness install
```

`harness` is the canonical bin; `harness-kit` is an alias.

## How it works

You write plugins and configs once under `src/`, declare which vendors to target, and `harness compile` emits a per-vendor `dist/` tree that `harness install` links into each vendor's home.

### `harness.yaml`

A declarative repo config with two required fields and one optional one:

```yaml
marketplace: my-harness
vendors:
  - claude
  - codex
roots:                       # optional — named include aliases (see docs/authoring.md)
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
    .fragments/                 # source-only snippets; never emitted to dist
  plugins/<plugin>/             # shared across every declared vendor
    .claude-plugin/plugin.json  # or PLUGIN.ts
    skills/<name>/SKILL.md      # or SKILL.ts + body.md
    agents/<agent>.md           # optional
    commands/<command>.md       # optional
    hooks/<hook>.json           # optional
  .claude-plugin/marketplace.json  # lists the plugins to compile
```

`compile` reads `src/` and writes a `dist/<vendor>/` subtree per declared vendor; `install` links those into place. Mechanics: [docs/pipeline.md](./docs/pipeline.md). Manifest fields: [docs/marketplace.md](./docs/marketplace.md).

## Capabilities

**Author once, render per vendor.** A single `SKILL.md` compiles to every declared vendor's tree:

```md
---
name: my-skill
description: What the skill does — single line.
---

# My Skill

For type safety conventions, see {{skill:dev-tools:typescript}}.
```

**Compose with shared fragments.** Inline a snippet anywhere, reach it by relative path, repo-root `#`, or a named `@alias`:

```md
{{include:@shared/preamble.md}}
```

**Cross-reference artifacts by handle.** `{{skill:...}}`, `{{command:...}}`, `{{agent:...}}` resolve against the local marketplace and installed plugins and render the scoped `<plugin>:<name>` handle — internal-missing fails the build, external-missing only warns.

**Evaluate behavior.** `harness eval` runs routing cases (*did the right skill fire?*) and solving cases (*did the agent produce the right thing?*), graded by deterministic assertions plus an optional LLM-judge rubric. No API key — the judge spawns the `claude` CLI on its own auth.

Full authoring guide (skill format, includes, fragments vs companions, TypeScript authoring, placeholder reference): [docs/authoring.md](./docs/authoring.md). Eval format and tiers: [docs/evals.md](./docs/evals.md).

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

## Programmatic API

Everything the CLI does is also a typed module API. See [docs/api.md](./docs/api.md).

## Requirements

- Node ≥ 24
- A package manager (pnpm, npm, yarn — pnpm is what this repo uses)
- The `claude` and/or `codex` CLIs on `$PATH` — only needed to run `harness install` / `uninstall`

## Releasing

Tag a version; CI publishes to npm. See [RELEASING.md](./RELEASING.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
