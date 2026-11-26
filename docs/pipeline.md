# Build, publish & install pipeline

The mechanics of `harness build`, `harness publish`, `harness install`, and `harness update`. For the conceptual overview (`harness.yaml`, vendors, source layout), see the [README](../README.md#how-it-works).

## Build pipeline

`harness build` reads `harness.yaml`, discovers every `plugins/*/plugin.json`, and computes one effective tree per vendor for each plugin, each named root, and `configs/` ([overlays](./authoring.md#vendor-overlays)). It validates each `extensions.harness.hookRequires` against the local artifact IDs, then deletes `.harness/` and emits a `.harness/<vendor>/` subtree per declared vendor:

- the vendor catalog — `.claude-plugin/marketplace.json` for Claude, `.agents/plugins/marketplace.json` for Codex ([catalog.md](./catalog.md#vendor-catalogs)).
- `plugins/<plugin>/` — built skills/agents/commands/hooks plus the vendor plugin manifest (`.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`).
- `configs/` — the effective `configs/` tree minus dot-prefixed entries.

`.harness/` is gitignored. Build refuses runtime links into `.harness/`. Run `harness migrate-runtime --vendor codex` (and `--vendor claude` for Claude settings) before rebuilding a legacy installation. Migration backs up content and detaches links without merging configuration.

A top-level `.harness/configs.json` link manifest enumerates the symlinks `harness install` will create.

## Publish pipeline

`harness publish` turns each `.harness/<vendor>/` into a commit on the `ref` that vendor declares in `harness.yaml`, without a checkout. `configs/` is excluded. The new commit's parent is the current remote branch head, so history only moves forward. An identical tree is a no-op. Publish never force-pushes; a rejected push fails. The [GitHub Action](./action.md) runs build, check, lint, and publish on every push to `main`.

## Install pipeline

`harness install` reads `harness.yaml`, then:

1. Refuses runtime files linked into this generated output. Applies permitted links from `.harness/configs.json`: Codex runtime files and Claude `settings.json` are excluded. Other vendor links retain their existing backup and orphan-sweep behavior.
2. For each declared vendor, discovers built plugins under `.harness/<vendor>/plugins/` and calls the vendor's `install` hook.

`--mode` selects where vendors resolve plugins from. `local` (default) registers `.harness/<vendor>/` as a marketplace, so uncommitted builds install without publishing. `remote` registers the published branch: Claude adds `<owner>/<repo>#<ref>`, Codex adds `<owner>/<repo> --ref <ref>` and upgrades it, using each vendor's `ref`. Claude remote mode first removes a local-scoped marketplace of the same name. Codex owns plugin cache writes and enabled state.

`--dry-run` prints the plan without touching the filesystem.

`harness update` is the refresh path for an **already-installed** harness: it defaults to remote mode, checks runtime detachment, skips config linking, and refreshes plugins. Pass `--mode local` to refresh an uncommitted local build. It refuses with an error if no vendor reports an existing install, and reports a per-plugin version diff (`added` / `→` / `unchanged` / `removed`) against observed versions after refresh. Disabled Codex plugins are skipped and logged with the version they would receive. Native installation would otherwise re-enable them.
