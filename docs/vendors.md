# Vendors

A **vendor** is harness-kit's extension point for targeting a coding-agent runtime. Each vendor knows where its home directory is, what its plugin manifest and catalog look like, and how to install or uninstall plugins through its own CLI or cache layout. The build + install pipelines are vendor-agnostic — everything vendor-specific lives behind the `Vendor` interface.

Built-in: [`claude`](../src/vendors/claude/index.ts) and [`codex`](../src/vendors/codex/index.ts). Custom vendors are wired through the programmatic API today; `harness.yaml` currently only resolves built-in names.

## The `Vendor` interface

Defined in [`src/vendor/schema.ts`](../src/vendor/schema.ts):

```ts
interface Vendor {
  readonly name: string;
  readonly home: string;
  readonly pluginManifestPath: string;
  readonly catalogPath: string;
  readonly runtimeLayout: RuntimeLayout;
  readonly pluginSelection: "declared" | "native";
  readonly configPlacement: (destRel: string) => ConfigPlacement | null;
  readonly emitPluginManifest: (ctx: VendorEmitContext) => Promise<void>;
  readonly emitCatalog: (ctx: VendorCatalogEmitContext) => Promise<void>;
  readonly install: (ctx: VendorInstallContext) => Promise<void>;
  readonly refresh: (ctx: VendorInstallContext) => Promise<void>;
  readonly uninstall: (ctx: VendorInstallContext) => Promise<void>;
  readonly partitionPlugins: (ctx: VendorInstallContext) => PluginPartition;
  readonly isInstalled: (ctx: VendorInstallContext) => Promise<boolean>;
  readonly installedVersions: (ctx: VendorInstallContext) => Promise<ReadonlyMap<string, string>>;
  readonly pruneStale: (ctx: VendorInstallContext, names: readonly string[]) => Promise<void>;
}

type RuntimeLayout =
  | { readonly kind: "home"; readonly preservedFiles: readonly string[] }
  | { readonly kind: "nested"; readonly directories: readonly string[] };

interface ConfigPlacement {
  readonly strategy: "link" | "merge";
  readonly destAbs: string;
}

type InstallSource =
  | { readonly kind: "local" }
  | { readonly kind: "remote"; readonly repository: Repository };

interface VendorInstallContext {
  readonly distRoot: string;
  readonly marketplace: string;
  readonly plugins: readonly DiscoveredVendorPlugin[];
  readonly source: InstallSource;
  readonly run: CommandRunner;
  readonly log: (msg: string) => void;
}

interface VendorEmitContext {
  readonly plugin: ResolvedPlugin;
  readonly pluginOutDir: string;
}

interface VendorCatalogEmitContext {
  readonly vendorDir: string;
  readonly catalog: Catalog;
}
```

### Field responsibilities

- **`name`** — identifier used in the `harness.yaml` `vendors:` list, as the build subtree (`.harness/<name>/`), as the overlay folder name (`plugins/<p>/<name>/`), and as the published branch name.
- **`home`** — absolute path to the vendor's user-level home (e.g. `~/.claude`, `~/.codex`). Config links are anchored here.
- **`pluginManifestPath`** — relative path inside each built plugin where the vendor manifest is written (e.g. `.claude-plugin/plugin.json`).
- **`catalogPath`** — path relative to `.harness/<name>/` where the vendor catalog is written (e.g. `.claude-plugin/marketplace.json`).
- **`runtimeLayout`** — which runtime paths must not link into `.harness/`. `build` and `install` refuse such links; `migrate-runtime` detaches them.
- **`pluginSelection`** — `declared` means `partitionPlugins` decides which plugins install; `native` means the vendor CLI decides at execution, so `--dry-run` lists candidates only.
- **`configPlacement`** — where a built config file lands and how, or `null` to skip it. `link` symlinks it into place; `merge` merges a TOML file's keys into an existing file the vendor app also writes. Claude links everything except `settings.json`; Codex places nothing.
- **`emitPluginManifest`** — write the vendor plugin manifest into `ctx.pluginOutDir` during build. `ctx.plugin.manifest` is the neutral `plugin.json`; the vendor decides how to translate it and its `extensions.<name>` block.
- **`emitCatalog`** — write the vendor catalog into `ctx.vendorDir` from the discovered plugins and `harness.yaml`. Plugin sources point at `./plugins/<name>`.
- **`install`** — register the discovered plugins with the vendor (CLI commands, cache priming, whatever the vendor needs), including enabling them where the vendor distinguishes cache from enablement. `ctx.source` says whether to use the local build or the published branch. `ctx.run` is a recordable command runner so test code can intercept shell calls.
- **`refresh`** — prime/refresh the plugin cache **only**, never touching enablement. `install` composes `refresh` plus any enable step; `update` calls `refresh` alone so an already-installed harness gets fresh plugin code without re-enabling anything in settings.
- **`uninstall`** — reverse of `install`. Should be idempotent.
- **`partitionPlugins`**, **`isInstalled`**, **`installedVersions`**, **`pruneStale`** — back `install --dry-run` and `update` (detection, version diff, `--prune`).

## Built-in vendors

### `claude`

- **Home**: `~/.claude`
- **Manifest path**: `.claude-plugin/plugin.json`
- **Catalog path**: `.claude-plugin/marketplace.json`
- **Marketplace source**: local mode runs `claude plugin marketplace add .harness/claude --scope local`. Remote mode removes that local-scoped entry, runs `claude plugin marketplace add <owner>/<repo>#claude`, then `claude plugin marketplace update <marketplace>`.
- **Install**: the disabled set is read from the built `settings.json` `enabledPlugins` **first**, before any `claude` command runs — `claude plugin uninstall` strips a plugin's entry from settings, and when `~/.claude/settings.json` is symlinked to the built file that would otherwise erase the `false` mid-install. Then the marketplace is refreshed, and each enabled plugin absent from `~/.claude/plugins/installed_plugins.json` gets `claude plugin install <name>@<marketplace>` — which is what writes the `enabledPlugins[...]=true` entry. An install that does not register the plugin is a hard error, never swallowed. Every enabled plugin then goes through the same cache refresh as below. Install never uninstalls and never deletes a working cache: a plugin already registered keeps its entry, and its cache is replaced by copy-then-swap rather than destroy-then-rebuild.
- **Refresh**: refreshes the cache for plugins **already installed** without enabling anything. For each shipped plugin already present in `~/.claude/plugins/installed_plugins.json` (the install registry), the built tree is copied into `~/.claude/plugins/.staging/incoming-*/`, the live version dir is moved aside into `~/.claude/plugins/.staging/displaced-*/`, and only then is the new copy renamed into `~/.claude/plugins/cache/<marketplace>/<name>/<version>/`. A failure at any point leaves the live plugin in place — a failed copy never touches it, and a failed swap restores it. Staging lives outside `plugins/cache` so a copy in flight is never discovered as a real plugin. Every registry entry for that plugin (all scopes — user/project/local) is then patched to the new `installPath`/`version`/`lastUpdated`, and only afterwards are sibling version dirs pruned — sparing any dir another registry entry still points at. A plugin absent from the registry is skipped (refresh never installs something new). `settings.json` is never opened, so `enabledPlugins` is left exactly as the user set it. This is the path `harness update` takes. The cache is populated by filesystem copy (not `claude plugin install`) precisely because `claude plugin install` is the command that would write `enabledPlugins`.
- **Uninstall**: `claude plugin uninstall <name>@<marketplace>` per plugin, then `claude plugin marketplace remove <marketplace>`.

### `codex`

- **Home**: `~/.codex`
- **Home**: `$CODEX_HOME` when set.
- **Manifest path**: `.codex-plugin/plugin.json`
- **Catalog path**: `.agents/plugins/marketplace.json`
- **Install / Refresh**: local mode runs `codex plugin marketplace add .harness/codex`. Remote mode runs `codex plugin marketplace add <owner>/<repo> --ref codex`, then `codex plugin marketplace upgrade <marketplace>`. Each shipped plugin that Codex reports as enabled is then installed with `codex plugin add <name>@<marketplace>`. Disabled plugins are skipped and logged. Codex owns cache writes and enabled state, so `refresh` and `install` are identical.
- **Uninstall**: `codex plugin remove <name>@<marketplace>` for each installed plugin, then `codex plugin marketplace remove <marketplace>`.

## Writing a custom vendor

Implement the interface and pass your vendor to `build` / `install` / `uninstall` directly:

```ts
import { build, install, type Vendor } from "@jean.gnc/harness-kit";

const myVendor: Vendor = {
  name: "myagent",
  home: `${process.env.HOME}/.myagent`,
  pluginManifestPath: ".myagent/plugin.json",
  catalogPath: ".myagent/marketplace.json",
  runtimeLayout: { kind: "home", preservedFiles: [] },
  pluginSelection: "declared",
  configPlacement: () => null,
  async emitPluginManifest(ctx) {
    /* write ctx.plugin.manifest into ctx.pluginOutDir / pluginManifestPath */
  },
  async emitCatalog(ctx) {
    /* write ctx.catalog into ctx.vendorDir / catalogPath */
  },
  async install(ctx) {
    /* register plugins with the vendor */
  },
  /* refresh, uninstall, partitionPlugins, isInstalled, installedVersions, pruneStale */
};

await build({ repoRoot: ".", vendors: [myVendor] });
await install({ repoRoot: ".", vendors: [myVendor] });
```

`harness.yaml` currently resolves vendor names against `builtinVendors()` only, so custom vendors must be wired through the programmatic API. Vendor-name registration in `harness.yaml` is a separate piece of work.

## See also

- [`src/vendor/schema.ts`](../src/vendor/schema.ts) — interface definitions.
- [`src/vendors/claude/index.ts`](../src/vendors/claude/index.ts) and [`src/vendors/codex/index.ts`](../src/vendors/codex/index.ts) — reference implementations.
- [`src/install/links.ts`](../src/install/links.ts) — how the config-link planner consumes `configPlacement`.
