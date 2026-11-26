# Harness Kit

`harness-kit` is a framework for building multi-agent harnesses — author plugins once, target every vendor.

## Quickstart

```sh
pnpm add @jean.gnc/harness-kit
harness init --marketplace my-harness --vendors claude,codex
# author plugins/<plugin>/plugin.json and skills (see docs/authoring.md)
harness build
harness install
```

`harness` is the canonical bin; `harness-kit` is an alias.

Upgrading from 0.x: see [MIGRATING.md](./MIGRATING.md).

## Install

For people who use a published harness repo. Replace `<owner>/<repo>`, `<plugin>`, and `<marketplace>` (the `marketplace` value in its `harness.yaml`).

Claude Code:

```sh
claude plugin marketplace add <owner>/<repo>#harness/claude
claude plugin install <plugin>@<marketplace>
```

Codex:

```sh
codex plugin marketplace add <owner>/<repo> --ref harness/codex
codex plugin add <plugin>@<marketplace>
```

Each vendor installs from the `ref` its `harness.yaml` declares (`harness/<vendor>` by default from `harness init`). The release workflow keeps those branches current.

Working on the harness repo itself? Run `harness build && harness install` to install the local build from `.harness/<vendor>/`. See [docs/cli.md](./docs/cli.md#harness-install).

## How it works

You write plugins and configs once on `main`, declare which vendors to target, and `harness build` emits a per-vendor tree under `.harness/` (gitignored). `harness publish` pushes each tree to the branch its vendor declares, and vendor CLIs install from that branch. Codex runtime files remain user-owned.

### `harness.yaml`

A declarative repo config:

```yaml
marketplace: my-harness
owner:
  name: you
vendors:
  claude:
    ref: harness/claude
  codex:
    ref: harness/codex
roots: # optional — named include aliases (see docs/authoring.md)
  shared: shared
```

`marketplace`, `owner`, and `vendors` are required. Plugins are not listed; every `plugins/*/plugin.json` is discovered. Created by `harness init`. Read by every command via `--repo` (default `.`). Field reference: [docs/catalog.md](./docs/catalog.md).

### Vendors

A vendor is a named target with a home directory, per-vendor manifest and catalog paths, emit hooks, and install/refresh/uninstall hooks. Built-in:

- **claude** — registers the marketplace and installs plugins via `claude plugin`; links config files into `~/.claude`, except `settings.json`.
- **codex** — uses native plugin commands and respects `CODEX_HOME`. It never links or merges runtime settings. Disabled plugins stay disabled; a refresh skips them and logs the version they are missing.

Writing your own vendor: see [docs/vendors.md](./docs/vendors.md).

### Source layout

| Path | What it is |
| --- | --- |
| `harness.yaml` | Marketplace name, owner, vendors with their refs, and optional named roots. |
| `plugins/<plugin>/plugin.json` | The plugin manifest ([Agent Plugins 1.0](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)). Vendor fields go under `extensions.<vendor>`. |
| `plugins/<plugin>/` | Everything else in the plugin — `skills/<name>/SKILL.md`, plus optional `agents/`, `commands/`, and `hooks/`. |
| `plugins/<plugin>/<vendor>/` | Vendor overlay. A file at the same relative path replaces the neutral file; other files are added. |
| `configs/` | Config files for every vendor (e.g. `AGENTS.md`). `configs/<vendor>/` overlays them per vendor. A `.fragments/` subdir holds source-only snippets. |
| `<root>/` | Any directory mapped under `roots:` in `harness.yaml` (e.g. `shared/`), reachable via `{{include:@<root>/…}}`. Overlays work the same way. |

`build` writes `.harness/<vendor>/` per declared vendor; `install` applies vendor-owned config placements and registers plugins. Mechanics: [docs/pipeline.md](./docs/pipeline.md). Overlays: [docs/authoring.md](./docs/authoring.md#vendor-overlays). Manifest fields: [docs/catalog.md](./docs/catalog.md).

## Capabilities

**Author once, render per vendor.** A single `SKILL.md` builds into every declared vendor's tree:

```md
---
name: my-skill
description: What the skill does — single line.
---

# My Skill

For type safety conventions, see {{skill:dev-tools:typescript}}.
```

**Override per vendor.** Put `plugins/<plugin>/codex/skills/my-skill/SKILL.md` next to the neutral file and Codex gets that copy instead.

**Compose with shared fragments.** Inline a snippet anywhere, reach it by relative path, repo-root `#`, or a named `@alias`:

```md
{{include:@shared/preamble.md}}
```

**Cross-reference artifacts by handle.** `{{skill:...}}`, `{{command:...}}`, `{{agent:...}}` resolve against the local marketplace and installed plugins and render the scoped `<plugin>:<name>` handle — internal-missing fails the build, external-missing only warns.

**Evaluate behavior.** `harness eval` runs routing cases (*did the right skill fire?*) and solving cases (*did the agent produce the right thing?*), graded by deterministic assertions plus an optional LLM-judge rubric. Runs on promptfoo; no API key — sessions and the judge use the `claude` login.

Full authoring guide (skill format, overlays, includes, fragments vs companions, placeholder reference): [docs/authoring.md](./docs/authoring.md). Eval format and tiers: [docs/evals.md](./docs/evals.md).

## CLI

```sh
harness init      # scaffold harness.yaml, plugins/, configs/, and .github/workflows/harness.yml
harness build     # build plugins/ + configs/ → .harness/<vendor>/ per declared vendor
harness lint      # lint built markdown under .harness/
harness check     # validate plugin references against local + installed sources
harness publish   # push each .harness/<vendor>/ to its declared ref
harness install   # bootstrap: link configs + register plugins per declared vendor (--mode=local|remote)
harness update    # refresh plugins for an already-installed harness; skips config links, reports version diff
harness migrate-runtime --vendor codex # back up and detach legacy runtime links before building
harness install-defaults --vendor codex # publish static /etc/codex/config.toml separately
harness uninstall # remove installed plugins per declared vendor
harness eval      # run routing + solving evals against the installed harness
```

→ Full flag reference, bundled lint rules, and `package.json` integration: [docs/cli.md](./docs/cli.md). CI: [docs/action.md](./docs/action.md).

## Programmatic API

Everything the CLI does is also a typed module API. See [docs/api.md](./docs/api.md).

## Project homes

`harness project` prepares independent Codex CLI homes from explicit local presets, adds a `CODEX_HOME` export to `.envrc`, and verifies native plugin, MCP, and hook state. Each Git checkout or worktree gets its own home. Project choices and approvals remain with the caller. See [project setup and API](./docs/projects.md).

## Runtime ownership

Run `harness migrate-runtime --vendor codex --dry-run` before rebuilding an existing linked installation, then repeat without `--dry-run`. Migrate Claude settings separately with `--vendor claude`. Migration preserves file contents and permissions with private backups. `build` and mutating install commands refuse runtime links into `.harness/`.

Publish Codex static defaults with `harness install-defaults --vendor codex`; `--dry-run` previews the destination. Only this command needs administrator permission for `/etc/codex/config.toml`. Existing machine defaults are backed up. Never elevate the whole plugin installer. User settings, personal instructions, hooks, and profiles stay in their native user locations and stop receiving automatic template updates.

Local mode registers `.harness/codex` through Codex. Remote mode registers `<owner>/<repo>` at `vendors.codex.ref`, re-registering an existing marketplace so a changed ref takes effect, and upgrades it through Codex. Native commands run outside the invoking project and only select plugins enabled at user/system scope. Project and named-profile enablement is never promoted to a global setting. Unsupported native refreshes fail explicitly instead of editing settings or caches. Run `node scripts/smoke-codex.mjs` after building the toolkit (`pnpm build`) to verify native CLI integration in an isolated temporary home.

## Requirements

- Node ≥ 24
- A package manager (pnpm, npm, yarn — pnpm is what this repo uses)
- The `claude` and/or `codex` CLIs on `$PATH` — only needed to run `harness install` / `uninstall`

## Releasing

Tag a version; CI publishes to npm. See [RELEASING.md](./RELEASING.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
