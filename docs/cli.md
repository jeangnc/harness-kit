# CLI reference

`harness` is the canonical bin; `harness-kit` is an alias.

## `harness init`

Scaffolds a new harness repo.

- `--marketplace <name>` (required) — marketplace name.
- `--vendors <csv>` (required) — comma-separated vendor names (e.g. `claude,codex`).
- `--repo <path>` (default `.`) — repo root to scaffold into.
- `--silent` — suppress success log.

Creates `harness.yaml`, `src/<vendor>/configs/` for each declared vendor, `src/plugins/`, and ensures `dist/` is in `.gitignore`. Fails if `harness.yaml` already exists.

## `harness compile`

Compiles `src/` to `dist/` for every vendor declared in `harness.yaml`.

- `--src <path>` (default `./src`).
- `--out <path>` (default `./dist`).
- `--repo <path>` (default `.`).
- `--silent`.

## `harness lint`

Lints compiled markdown under `dist/` with `markdownlint-cli2`.

- `--out <path>` (default `./dist`).
- `--silent`.

### Bundled rules

Runs against `plugins/**/*.md` with these overrides:

- `MD013` (line length) — disabled.
- `MD041` (first-line h1) — disabled.
- `MD033` (inline HTML) — disabled.
- `MD024` (no duplicate headings) — scoped to `siblings_only`.
- `MD031` (fences need surrounding blank lines) — allows omitting them inside list items.

## `harness check`

Validates `{{skill:...}}`, `{{command:...}}`, and `{{agent:...}}` references.

- `--src <path>` (default `./src`).
- `--mode <local | installed | all>` (default `installed`).
  - `local` — resolves references against locally discovered artifacts only.
  - `installed` — resolves references against plugins in the vendor's installed index.
  - `all` — resolves against the union; the hard gate that fails on any unresolved reference.
- `--silent`.

## `harness install`

Links config files into each vendor's home and registers compiled plugins through the vendor's own CLI.

- `--dist <path>` (default `./dist`).
- `--repo <path>` (default `.`).
- `--mode <local|remote>` (default `local`) — install source. `local` registers the compiled `dist/claude/` tree as a local-scoped marketplace, installing uncommitted builds without publishing; `remote` resolves Claude plugins from the published marketplace. Codex is local-only and ignores this flag.
- `--dry-run` — print the plan without touching the filesystem.
- `--silent`.

Vendor scope comes from `harness.yaml`. Existing symlinks at a destination are replaced; existing regular files are renamed to `<dest>.backup` (incrementing to `.backup.2`, `.backup.3`, …) before the symlink is created. Orphan symlinks pointing back into the repo are swept before applying.

## `harness uninstall`

Same flags as `install`. Reverses each vendor's `install` hook.

## `package.json` integration

```json
{
  "scripts": {
    "init:harness": "harness init",
    "build": "harness compile",
    "lint": "harness compile && harness lint",
    "install:plugins": "harness install",
    "uninstall:plugins": "harness uninstall"
  },
  "dependencies": {
    "@jean.gnc/harness-kit": "latest"
  }
}
```
