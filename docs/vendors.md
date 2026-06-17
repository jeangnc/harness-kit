# Vendors

A **vendor** is harness-kit's extension point for targeting a coding-agent runtime. Each vendor knows where its home directory is, what its plugin manifest looks like, and how to install or uninstall plugins through its own CLI or cache layout. The compile + install pipelines are vendor-agnostic — everything vendor-specific lives behind the `Vendor` interface.

Built-in: [`claude`](../src/vendors/claude/index.ts) and [`codex`](../src/vendors/codex/index.ts). Custom vendors are wired through the programmatic API today; `harness.yaml` currently only resolves built-in names.

## The `Vendor` interface

Defined in [`src/vendor/schema.ts`](../src/vendor/schema.ts):

```ts
interface Vendor {
  readonly name: string;
  readonly home: string;
  readonly pluginManifestPath: string;
  readonly marketplaceManifestPath: string;
  readonly vendorOutDir: (outRoot: string) => string;
  readonly pluginOutDir: (outRoot: string, pluginName: string) => string;
  readonly configsOutDir: (outRoot: string) => string;
  readonly aliases?: (linkedFile: LinkedFile) => readonly string[];
  readonly emitPluginManifest: (ctx: VendorEmitContext) => Promise<void>;
  readonly emitMarketplaceManifest: (ctx: VendorMarketplaceContext) => Promise<void>;
  readonly install: (ctx: VendorInstallContext) => Promise<void>;
  readonly uninstall: (ctx: VendorInstallContext) => Promise<void>;
}

interface LinkedFile {
  readonly srcAbs: string;
  readonly destAbs: string;
  readonly destRel: string;
  readonly basename: string;
}

interface DiscoveredVendorPlugin {
  readonly name: string;
  readonly path: string;
  readonly version: string;
}

interface VendorInstallContext {
  readonly distRoot: string;
  readonly marketplace: string;
  readonly plugins: readonly DiscoveredVendorPlugin[];
  readonly run: CommandRunner;
  readonly log: (msg: string) => void;
}

interface VendorEmitContext {
  readonly manifest: Plugin;
  readonly pluginOutDir: string;
}
```

### Field responsibilities

- **`name`** — identifier used in `harness.yaml` `vendors:` list and as the top-level segment of the per-vendor dist subtree (`dist/<name>/`).
- **`home`** — absolute path to the vendor's user-level home (e.g. `~/.claude`, `~/.codex`). Config links and aliases are anchored here.
- **`pluginManifestPath`** — relative path inside each compiled plugin where the vendor manifest is written (e.g. `.claude-plugin/plugin.json`).
- **`marketplaceManifestPath`** — path relative to `outRoot` where the per-vendor marketplace manifest is written (e.g. `claude/.claude-plugin/marketplace.json`).
- **`vendorOutDir(outRoot)`** — root of this vendor's dist subtree (typically `<outRoot>/<name>`).
- **`pluginOutDir(outRoot, pluginName)`** — destination for a compiled plugin (typically `<outRoot>/<name>/plugins/<pluginName>`).
- **`configsOutDir(outRoot)`** — destination for vendor-specific configs (typically `<outRoot>/<name>/configs`).
- **`aliases`** *(optional)* — given a linked config file, return additional symlink destinations. Claude uses this to add a `CLAUDE.md` alias whenever an `AGENTS.md` config is linked.
- **`emitPluginManifest`** — write the per-vendor manifest into `ctx.pluginOutDir` during compile. The shared `Plugin` shape is provided; the vendor decides how (or whether) to translate it.
- **`emitMarketplaceManifest`** — write the per-vendor marketplace manifest. Relative `source` values are rewritten to `./plugins/<name>` so they resolve under the new dist layout.
- **`install`** — register the discovered plugins with the vendor (CLI commands, cache priming, whatever the vendor needs), including enabling them where the vendor distinguishes cache from enablement. `ctx.run` is a recordable command runner so test code can intercept shell calls.
- **`refresh`** — prime/refresh the plugin cache **only**, never touching enablement. `install` composes `refresh` plus any enable step; `update` calls `refresh` alone so an already-installed harness gets fresh plugin code without re-enabling anything in settings.
- **`uninstall`** — reverse of `install`. Should be idempotent.

## Built-in vendors

### `claude`

- **Home**: `~/.claude`
- **Manifest path**: `.claude-plugin/plugin.json`
- **Aliases**: a linked `AGENTS.md` also gets a `CLAUDE.md` symlink in the vendor home (one-way).
- **Install**: the disabled set is read from the compiled `settings.json` `enabledPlugins` **first**, before any `claude` command runs — `claude plugin uninstall` strips a plugin's entry from settings, and when `~/.claude/settings.json` is symlinked to the compiled file that would otherwise erase the `false` mid-install. Then, for each discovered plugin, `claude plugin uninstall <name>@<marketplace>` (ignore-failure), remove `~/.claude/plugins/cache/<marketplace>/<name>`, refresh the marketplace, then `claude plugin install <name>@<marketplace>` — unless the plugin was disabled, in which case the install is skipped (the marketplace is still refreshed). The clean-reinstall cycle avoids stale-cache surprises. `claude plugin install` is what populates the cache and writes the `enabledPlugins[...]=true` entry — so install both caches and enables.
- **Refresh**: refreshes the cache for plugins **already installed** without enabling anything. For each shipped plugin already present in `~/.claude/plugins/installed_plugins.json` (the install registry), copy its compiled tree into `~/.claude/plugins/cache/<marketplace>/<name>/<version>/`, prune the stale prior-version dir, then patch every registry entry for that plugin (all scopes — user/project/local) to the new `installPath`/`version`/`lastUpdated`. A plugin absent from the registry is skipped (refresh never installs something new). `settings.json` is never opened, so `enabledPlugins` is left exactly as the user set it. This is the path `harness update` takes. The cache is populated by filesystem copy (not `claude plugin install`) precisely because `claude plugin install` is the command that would write `enabledPlugins`.
- **Uninstall**: `claude plugin uninstall <name>@<marketplace>` per plugin, then `claude plugin marketplace remove <marketplace>`.

### `codex`

- **Home**: `~/.codex`
- **Manifest path**: `.codex-plugin/plugin.json`
- **Install / Refresh**: drops `~/.codex/plugins/cache/<marketplace>`, runs `codex plugin marketplace add <distRoot>`, then copies each compiled plugin into `~/.codex/plugins/cache/<marketplace>/<name>/<version>/`. The copy primes the cache so Codex picks up plugins immediately without a separate fetch step. Codex never enables plugins through settings, so its `refresh` and `install` are identical.
- **Uninstall**: `codex plugin marketplace remove <marketplace>`, then drops the cache directory.

## Writing a custom vendor

Implement the interface and pass your vendor to `install` / `uninstall` / `compile` directly:

```ts
import { compile, install, type Vendor } from "@jean.gnc/harness-kit";
import { join } from "node:path";

const myVendor: Vendor = {
  name: "myagent",
  home: `${process.env.HOME}/.myagent`,
  pluginManifestPath: ".myagent/plugin.json",
  marketplaceManifestPath: "myagent/.myagent/marketplace.json",
  vendorOutDir: (outRoot) => join(outRoot, "myagent"),
  pluginOutDir: (outRoot, name) => join(outRoot, "myagent", "plugins", name),
  configsOutDir: (outRoot) => join(outRoot, "myagent", "configs"),
  async emitPluginManifest(ctx) {
    /* write ctx.manifest into ctx.pluginOutDir / pluginManifestPath */
  },
  async emitMarketplaceManifest(ctx) {
    /* write ctx.manifest into outRoot / marketplaceManifestPath */
  },
  async install(ctx) {
    /* register plugins with the vendor */
  },
  async uninstall(ctx) {
    /* reverse of install */
  },
};

await compile({ srcRoot: "./src", outRoot: "./dist", vendors: [myVendor] });
await install({ vendors: [myVendor] });
```

`harness.yaml` currently resolves vendor names against `builtinVendors()` only, so custom vendors must be wired through the programmatic API. Vendor-name registration in `harness.yaml` is a separate piece of work.

## See also

- [`src/vendor/schema.ts`](../src/vendor/schema.ts) — interface definitions.
- [`src/vendors/claude/index.ts`](../src/vendors/claude/index.ts) and [`src/vendors/codex/index.ts`](../src/vendors/codex/index.ts) — reference implementations.
- [`src/install/links.ts`](../src/install/links.ts) — how the config-link planner consumes `aliases`.
