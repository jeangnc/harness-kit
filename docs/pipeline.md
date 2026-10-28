# Compile & install pipeline

The mechanics of `harness compile`, `harness install`, and `harness update`. For the conceptual overview (`harness.yaml`, vendors, source layout), see the [README](../README.md#how-it-works).

## Compile pipeline

`harness compile` reads vendors from `harness.yaml`, validates the marketplace manifest, discovers plugins, and validates each `hookRequires` against the local artifact IDs. For each declared vendor it emits everything under a single top-level `dist/<vendor>/` subtree:

- `dist/<vendor>/.claude-plugin/marketplace.json` — the per-vendor marketplace manifest.
- `dist/<vendor>/plugins/<plugin>/` — compiled skills/agents/commands plus the per-vendor plugin manifest.
- `dist/<vendor>/configs/` — vendor-specific config files (everything under `src/<vendor>/configs/` minus dot-prefixed entries).

Compilation refuses runtime links into `dist/`. Run `harness migrate-runtime --vendor codex` (and `--vendor claude` for Claude settings) before rebuilding a legacy installation. Migration backs up content and detaches links without merging configuration.

A top-level `dist/configs.json` link manifest enumerates the symlinks `harness install` will create.

## Install pipeline

`harness install` reads `harness.yaml`, then:

1. Refuses runtime files linked into this generated output. Applies permitted links from `dist/configs.json`: Codex runtime files and Claude `settings.json` are excluded. Other vendor links retain their existing backup and orphan-sweep behavior.
2. For each declared vendor, discovers compiled plugins under `dist/<vendor>/plugins/` and calls the vendor's `install` hook.

`--mode` selects where Claude resolves plugins from: `local` (default) registers the freshly compiled `dist/claude/` tree as a local-scoped marketplace, so uncommitted builds install without publishing; `remote` pulls from the published marketplace. Codex local mode registers `dist/codex`; remote mode upgrades an already configured Git marketplace. Codex owns plugin cache writes and enabled state.

`--dry-run` prints the plan without touching the filesystem.

`harness update` is the refresh path for an **already-installed** harness: it defaults to remote mode, checks runtime detachment, skips config linking, and refreshes plugins. Pass `--mode local` to refresh an uncommitted local build. It refuses with an error if no vendor reports an existing install, and reports a per-plugin version diff (`added` / `→` / `unchanged` / `removed`) against observed versions after refresh. Disabled Codex plugins are skipped unless their installed version needs refreshing, in which case the operation fails before installing any plugin. Native installation would otherwise re-enable them.

> **Known gap — repo-root marketplace symlink.** A consumer repo that publishes its own marketplace from the root expects a `.claude-plugin/marketplace.json` at the repo root pointing at the compiled `dist/<vendor>/.claude-plugin/marketplace.json`. `install` does **not** create that symlink today — it only links into each vendor's home and emits the per-vendor manifest under `dist/`. Repos that need the root manifest currently maintain it by hand, which drifts from the compiled source. Linking it from `install` (the same way configs are linked) is not yet implemented.
