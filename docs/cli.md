# CLI reference

`harness` is the canonical bin; `harness-kit` is an alias.

## `harness init`

Scaffolds a new harness repo.

- `--marketplace <name>` (required) — marketplace name.
- `--vendors <csv>` (required) — comma-separated vendor names (e.g. `claude,codex`).
- `--owner <name>` — marketplace owner name. Empty (the default) uses the GitHub owner of the `origin` remote.
- `--repo <path>` (default `.`) — repo root to scaffold into.
- `--silent` — suppress success log.

Creates `harness.yaml`, `plugins/`, `configs/`, and the release workflow `.github/workflows/harness.yml` ([action.md](./action.md)), and ensures `.harness/` is in `.gitignore`. Fails if `harness.yaml` or the workflow already exists.

## `harness build`

Builds `plugins/`, `configs/`, and named roots into `.harness/<vendor>/` for every vendor declared in `harness.yaml`. Deletes `.harness/` first.

- `--repo <path>` (default `.`).
- `--silent`.

## `harness lint`

Lints built markdown under `.harness/` with `markdownlint-cli2`.

- `--repo <path>` (default `.`).
- `--silent`.

### Bundled rules

Runs against `<vendor>/**/*.md` under `.harness/` for each declared vendor, with these overrides:

- `MD013` (line length) — disabled.
- `MD041` (first-line h1) — disabled.
- `MD033` (inline HTML) — disabled.
- `MD040` (fenced code language) — disabled.
- `MD024` (no duplicate headings) — scoped to `siblings_only`.
- `MD031` (fences need surrounding blank lines) — allows omitting them inside list items.

## `harness check`

Validates `{{skill:...}}`, `{{command:...}}`, and `{{agent:...}}` references.

- `--repo <path>` (default `.`).
- `--docs <paths>` — comma-separated files or directories outside `plugins/` to scan as well.
- `--silent`.

By default only plugin files are scanned, once per declared vendor with that vendor's overlays applied. Repo docs that name skills — a `README.md`, a `docs/` reference table — keep stale names indefinitely: a rename updates every `{{…}}` placeholder in `plugins/` and silently leaves the docs pointing at an artifact that no longer exists. `--docs` brings those files into the same check. A path may be a directory (walked for `.md`) or a single file; anything already inside a plugin directory is skipped rather than scanned twice. Docs own no plugin, so the `{{ref:}}` plugin-boundary rule does not apply to them.

References resolve against the union of this marketplace's local artifacts and the installed plugins. A malformed reference (not `<plugin>:<name>` shape) is always a violation and exits non-zero. An unresolved reference is classified by who owns its plugin: if the plugin belongs to **this marketplace** (the artifact is just missing), it's a violation and exits non-zero; if the plugin is **external** (vendor, installed, or unknown), it's a warning that never affects the exit code.

Separately, `check` emits **warnings** (never affecting the exit code) when a body names a known artifact directly instead of through a placeholder — a command's rendered `/<plugin>:<name>`, an agent's `@<plugin>:<name>`, or a bare `<plugin>:<name>` for any kind. These raw references bypass the placeholder pipeline, so they go untracked and unrewritten when an id changes; the warning names the `{{…}}` form to use instead. A raw reference warns only when its id matches an artifact in the resolved scope, so ordinary prose is never flagged.

## `harness install`

Links config files into each vendor's home and registers built plugins through the vendor's own CLI. Run `harness build` first: both modes read the plugin list and marketplace name from `.harness/<vendor>/`.

- `--repo <path>` (default `.`).
- `--mode <local|remote>` (default `local`) — install source. `local` registers `.harness/<vendor>/` as a local marketplace, installing uncommitted builds without publishing. `remote` installs from the published vendor branches: `claude plugin marketplace add <owner>/<repo>#<ref>` and `codex plugin marketplace add <owner>/<repo> --ref <ref>`, with each vendor's `ref` from `harness.yaml`. The repository comes from `GITHUB_REPOSITORY` or the `origin` remote.
- `--dry-run` — print the plan without touching the filesystem.
- `--silent`.

Vendor scope comes from `harness.yaml`. Existing symlinks at a destination are replaced; existing regular files are renamed to `<dest>.backup` (incrementing to `.backup.2`, `.backup.3`, …) before the symlink is created. Orphan symlinks pointing back into the repo are swept before applying.

A plugin set to `false` in the claude vendor's built `settings.json` `enabledPlugins` (keyed `<name>@<marketplace>`) is built and its marketplace refreshed, but not passed to `claude plugin install`. Absent from `enabledPlugins` means enabled. `--dry-run` marks skipped plugins.

## `harness publish`

Builds, then pushes each `.harness/<vendor>/` tree to the `ref` that vendor declares in `harness.yaml`. `.harness/<vendor>/configs/` is never published.

- `--repo <path>` (default `.`).
- `--vendors <csv>` — vendors to publish. Empty (the default) publishes every vendor in `harness.yaml`.
- `--remote <name>` (default `origin`).

Refuses, before building, when the working tree has uncommitted changes. Each commit is a child of the current remote branch head, with message `build: <source sha>`. An unchanged tree pushes nothing. Publishing never force-pushes; a push that would not fast-forward fails. Run it from CI: [action.md](./action.md).

## `harness uninstall`

Same flags as `install`. Reverses each vendor's `install` hook.

## `harness update`

Refreshes plugins for an **already-installed** harness. It defaults to `--mode remote`; pass `--mode local` to refresh an uncommitted local build. Otherwise it has the same flags as `install`, plus `--prune`. It skips the config-link bootstrap (step 1 of install), so a symlinked `settings.json` and its `enabledPlugins` are left untouched, and runs only the per-vendor plugin refresh. Refuses with an error if no vendor reports an existing install, and reports a per-plugin version diff (`added` / `→` / `unchanged` / `removed`) against the versions currently cached.

- `--prune` — remove plugins that are still installed but no longer shipped in `.harness/<vendor>/`.

A plugin deleted from source stays in the vendor's cache, and `update` reads that cache to build the diff — so it reports `removed` on every run and nothing acts on it. `--prune` is what acts: it uninstalls the plugin, drops its registry entry (all scopes), then deletes its cache directory. Without the flag the report names it and points here, because removal is destructive and a plugin absent from _this_ build may still be shipped by another. With `--dry-run` the line reads `would prune` and nothing is touched.

The registry entry goes before the cache directory on purpose. Detection reads the cache, so a removal that fails midway leaves the plugin still cached and therefore still reported on the next run — never a registry orphan that no `update` can see.

## `harness eval`

Runs routing (_did the right skill fire?_) and solving (_graded behavior_) evals against the installed harness. Format and tiers: [evals.md](./evals.md).

- `--cases <path>` (default `./evals/cases`) — directory of eval case files.
- `--cwd <path>` (default `.`) — working directory for the `claude -p` sessions.
- `--dist <path>` (default `./.harness`) — local build to overlay over the installed plugin cache (local wins). Empty disables it.
- `--suite <name>` — only run cases from this suite.
- `--case <id>` — only run the case with this id.
- `--tier <routing|solving>` — only run this tier.
- `--runs <n>` — runs per case (overrides the per-case default).
- `--concurrency <n>` (default `1`) — max concurrent sessions. Parallel sessions interfere with routing detection, so the default is serial.
- `--model <model>` — model for the `claude -p` sessions (default: the user's configured model).
- `--judge-model <model>` (default `opus`) — model for the solving-tier LLM judge.
- `--solving-timeout <seconds>` (default `300`) — per-case timeout for solving sessions.
- `--json <path>` — write machine-readable results to this path.

No API key needed: sessions and the judge both spawn the `claude` CLI on its own auth.

## `package.json` integration

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
