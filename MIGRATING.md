# Migrating from 0.23 to 1.0

1.0 changes the repo layout and how users install. There is no migrate command; move the files by hand, then rebuild and publish.

## Layout

| 0.23                                                                        | 1.0                                                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/plugins/<p>/`                                                          | `plugins/<p>/`                                                                                                |
| `src/shared/` (or any `roots:` dir)                                         | `shared/` — update the paths under `roots:` in `harness.yaml`                                                 |
| `src/<vendor>/configs/`                                                     | `configs/` for files every vendor shares, `configs/<vendor>/` for the rest                                    |
| `src/.claude-plugin/marketplace.json`                                       | Gone. Plugins are discovered from `plugins/*/plugin.json`. Move `name` and `owner` into `harness.yaml`.       |
| `plugins/<p>/.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`    | One `plugins/<p>/plugin.json`. Vendor-only fields go under `extensions.<vendor>`.                             |
| Codex `policy` / `category` in `.agents/plugins/marketplace.json`           | `extensions.codex.policy` / `extensions.codex.category` in each `plugin.json`                                 |
| `hookRequires` in the plugin manifest                                       | `extensions.harness.hookRequires`                                                                             |
| `SKILL.ts` + `body.md`, `PLUGIN.ts`                                         | Removed. Use `SKILL.md` with frontmatter and `plugin.json`.                                                   |
| Vendor-specific copies of a file                                            | Vendor overlay: same relative path under `plugins/<p>/<vendor>/` (or `<root>/<vendor>/`, `configs/<vendor>/`) |
| Committed `dist/`                                                           | Delete it. The build goes to gitignored `.harness/<vendor>/`.                                                 |
| Root `.claude-plugin/marketplace.json` / `.agents/plugins/marketplace.json` | Delete them. Each vendor branch carries its own catalog.                                                      |
| `CLAUDE.md` symlink created next to a linked `AGENTS.md`                    | No longer created. `harness install` removes the old link; add a real `configs/claude/CLAUDE.md` if needed.   |

A 1.0 `plugin.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What the plugin does.",
  "extensions": {
    "codex": { "policy": { "installation": "AVAILABLE" }, "category": "Productivity" }
  }
}
```

`$schema`, `name`, `version`, and `description` are required. `name` must match the folder name. Unknown top-level keys fail the build. Full reference: [docs/catalog.md](./docs/catalog.md).

A 1.0 `harness.yaml`:

```yaml
marketplace: my-harness
owner:
  name: you
vendors: [claude, codex]
roots:
  shared: shared
```

## Commands

| 0.23                                       | 1.0                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `harness compile --src ./src --out ./dist` | `harness build` (writes `.harness/`)                                             |
| `harness lint --out ./dist`                | `harness lint`                                                                   |
| `harness check --src ./src`                | `harness check`                                                                  |
| `harness install --dist ./dist`            | `harness install`                                                                |
| `harness init --marketplace m --vendors v` | Same, plus `--owner`. Also writes `.github/workflows/harness.yml`.               |
| —                                          | `harness publish` pushes `.harness/<vendor>/` to the `claude` / `codex` branches |

Every command takes `--repo` (default `.`). `--src`, `--out`, and `--dist` are gone, except `harness eval --dist`, which now defaults to `./.harness`.

`harness install --mode remote` no longer reads `extraKnownMarketplaces` from the built Claude `settings.json`. It derives `<owner>/<repo>` from `GITHUB_REPOSITORY` or the `origin` remote.

## Steps

1. Move files per the layout table. Delete the root catalogs. Keep `dist/` for now: your runtime config links still point into it.
2. Add `owner` to `harness.yaml` and fix `roots:` paths. Rewrite repo-root includes such as `{{include:#src/shared/foo.md}}` to the new paths.
3. Add `.harness/` to `.gitignore`.
4. Run `harness build && harness check && harness lint`.
5. Run `harness install`. It relinks configs from `.harness/` and removes links left pointing into `dist/`.
6. Delete `dist/`.
7. Add the release workflow. Copy it from [docs/action.md](./docs/action.md); `harness init` refuses to run over an existing `harness.yaml`.
8. Push to `main`. The workflow publishes the `claude` and `codex` branches.
9. If `configs/claude/settings.json` lists your marketplace under `extraKnownMarketplaces`, point that entry at the vendor branch: `{ "source": "github", "repo": "<owner>/<repo>", "ref": "claude" }`. Claude refuses to add a marketplace whose source differs from that entry. A user `settings.json` copied by an earlier install needs the same edit.

## End users

Users who added the marketplace from the repo root must re-add it once from the vendor branch. Claude repoints an existing marketplace of the same name and keeps its plugins:

```sh
claude plugin marketplace add <owner>/<repo>#claude

codex plugin marketplace remove <marketplace>
codex plugin marketplace add <owner>/<repo> --ref codex
```

Plugin keys stay `<plugin>@<marketplace>`. If removing the Codex marketplace also removed its plugins, add them again (`codex plugin add <plugin>@<marketplace>`).

`harness install --mode remote` and `harness update` re-add the Claude marketplace from the vendor branch and fail if that add fails.
