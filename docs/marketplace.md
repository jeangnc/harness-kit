# Marketplace + plugin manifests

harness-kit's manifests are a strict superset of the upstream Claude Code shapes — anything documented in the Claude marketplace schema passes through unchanged. This page covers the harness-kit-specific extensions and a few less-obvious behaviors.

## Marketplace manifest (`src/.claude-plugin/marketplace.json`)

Enumerates the plugins to compile. Folders not listed here are ignored.

```json
{
  "name": "my-harness",
  "owner": { "name": "you" },
  "plugins": [
    { "source": { "kind": "relative", "path": "my-plugin" } }
  ]
}
```

### `metadata.pluginRoot`

By default plugin source paths resolve relative to `src/plugins/`. Set `metadata.pluginRoot` to rebase the lookup elsewhere — useful when `plugins/` lives next to a `packages/` tree or another sibling directory.

```json
{
  "name": "my-harness",
  "metadata": { "pluginRoot": "packages" },
  "plugins": [
    { "source": { "kind": "relative", "path": "my-plugin" } }
  ]
}
```

### Passthrough fields

Upstream fields pass through to `dist/.claude-plugin/marketplace.json` untouched: `homepage`, `repository`, `allowCrossMarketplaceDependenciesOn`, object-form dependencies (`{ name, marketplace }`), and any other documented field. Existing Claude marketplaces drop in without rewriting their manifests.

## Plugin manifest (`src/plugins/<plugin>/.claude-plugin/plugin.json` or `PLUGIN.ts`)

### `context: [{ file }]`

Files listed here are copied verbatim into the compiled plugin directory. Useful for fixtures, prompts, or any asset a skill or hook needs to read at runtime. The build fails if a listed file is missing.

```json
{
  "name": "my-plugin",
  "context": [{ "file": "prompts/system.md" }]
}
```

### `hookRequires: [{ event, skill | command | agent }]`

Declares that a hook depends on a specific skill / command / agent being available. The build validates each requirement against the locally discovered artifact IDs — a typo fails the build instead of surfacing as a runtime "skill not found" later.

```json
{
  "name": "my-plugin",
  "hookRequires": [
    { "event": "SessionStart", "skill": "my-plugin:warmup" }
  ]
}
```
