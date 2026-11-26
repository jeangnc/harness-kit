# Catalog + plugin manifests

A harness repo has no hand-written marketplace manifest. `harness build` derives one catalog per vendor from `harness.yaml` and the plugins it discovers. This page covers `harness.yaml`, `plugin.json`, and what each vendor catalog contains.

## `harness.yaml`

```yaml
marketplace: my-harness
owner:
  name: you
  email: you@example.com # optional
  url: https://example.com # optional
vendors:
  claude:
    ref: harness/claude # branch that harness publish writes and installs read
    catalog: # optional — extra fields for this vendor's catalog
      metadata: { description: My harness }
  codex:
    ref: harness/codex
roots: # optional — named include aliases
  shared: shared
```

- `marketplace` (required) — kebab-case catalog name. Users install plugins as `<plugin>@<marketplace>`.
- `owner` (required) — `name`, plus optional `email` and `url`.
- `vendors` (required) — map from built-in vendor name to its settings. At least one.
  - `ref` (required) — git branch that `harness publish` writes and remote installs read. Each vendor needs its own. Avoid `claude` and `codex`: Claude Code and Codex create `claude/<slug>` and `codex/<slug>` branches, and git cannot hold a branch next to a folder of the same name.
  - `catalog` — fields merged into that vendor's catalog as-is. They cannot override `name` or `owner`.
- `roots` — name → repo-relative path. Reachable from markdown as `{{include:@<name>/…}}`. See [authoring.md](./authoring.md#composing-with-includes).

Unknown keys fail the build. There is no `repository` key; remote installs read the GitHub repository from `GITHUB_REPOSITORY` or the `origin` remote. `harness.yml` also works, but not both.

## Plugin discovery

Every folder `plugins/<plugin>/` is a plugin. There is no plugin list.

- Each folder must contain `plugin.json`, or the build fails.
- The manifest `name` must equal the folder name.
- Folders starting with `.` are ignored.
- Plugins are emitted in folder-name order.

## Plugin manifest (`plugins/<plugin>/plugin.json`)

The manifest follows [Agent Plugins 1.0](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json). Vendor-specific fields live under `extensions.<vendor>`.

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What the plugin does.",
  "extensions": {
    "codex": {
      "policy": { "installation": "AVAILABLE" },
      "category": "Productivity",
      "interface": { "displayName": "My Plugin" }
    },
    "harness": {
      "hookRequires": [{ "event": "SessionStart", "skill": "my-plugin:warmup" }]
    }
  }
}
```

Required: `$schema` (exactly the URL above), `name` (kebab-case), `version`, `description`. Optional: `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`. Unknown top-level keys fail the build.

### `extensions.claude`

Merged into the emitted `.claude-plugin/plugin.json` as top-level fields.

### `extensions.codex`

- `policy` — copied to the plugin's catalog entry. Default `{ "installation": "AVAILABLE", "authentication": "ON_INSTALL" }`.
- `category` — copied to the plugin's catalog entry. Default `"Productivity"`.
- Every other field (e.g. `interface`) is merged into the emitted `.codex-plugin/plugin.json`.

### `extensions.harness.hookRequires: [{ event, skill | command | agent }]`

Declares that a hook depends on a specific skill, command, or agent. Each entry sets exactly one of `skill`, `command`, or `agent` as `<plugin>:<name>`. The build checks each requirement against the local artifacts for every vendor, so a typo fails the build instead of surfacing as a runtime "skill not found".

## Vendor catalogs

`harness build` writes one catalog per declared vendor:

| Vendor   | Catalog                                           | Plugin manifest                                          |
| -------- | ------------------------------------------------- | -------------------------------------------------------- |
| `claude` | `.harness/claude/.claude-plugin/marketplace.json` | `.harness/claude/plugins/<p>/.claude-plugin/plugin.json` |
| `codex`  | `.harness/codex/.agents/plugins/marketplace.json` | `.harness/codex/plugins/<p>/.codex-plugin/plugin.json`   |

Claude's catalog holds `name`, `owner`, `vendors.claude.catalog` from `harness.yaml`, and one `{ name, source: "./plugins/<p>", description }` entry per plugin.

Codex's catalog holds `name`, `interface.displayName` (the marketplace name), `vendors.codex.catalog` from `harness.yaml`, and one `{ name, source: { source: "local", path: "./plugins/<p>" }, policy, category }` entry per plugin.

Each vendor plugin manifest is the neutral `plugin.json` without `$schema` and `extensions`, plus that vendor's extension fields. `harness publish` pushes each `.harness/<vendor>/` tree, minus `configs/`, to that vendor's `ref`.
