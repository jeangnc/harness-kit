import type { CommandRunner } from "../install/runner.js";
import type { Catalog, ResolvedPlugin } from "../layout/index.js";
import type { Repository } from "../repository/index.js";

export interface ConfigPlacement {
  readonly strategy: "link" | "merge";
  readonly destAbs: string;
}

export interface DiscoveredVendorPlugin {
  readonly name: string;
  readonly path: string;
  readonly version: string;
}

export interface PluginPartition {
  readonly enabled: readonly DiscoveredVendorPlugin[];
  readonly disabled: readonly DiscoveredVendorPlugin[];
}

export type InstallSource =
  | { readonly kind: "local" }
  | { readonly kind: "remote"; readonly repository: Repository };

export interface VendorInstallContext {
  readonly distRoot: string;
  readonly marketplace: string;
  readonly plugins: readonly DiscoveredVendorPlugin[];
  readonly source: InstallSource;
  readonly run: CommandRunner;
  readonly log: (msg: string) => void;
}

export interface VendorEmitContext {
  readonly plugin: ResolvedPlugin;
  readonly pluginOutDir: string;
}

export interface VendorCatalogEmitContext {
  readonly vendorDir: string;
  readonly catalog: Catalog;
}

export type RuntimeLayout =
  | { readonly kind: "home"; readonly preservedFiles: readonly string[] }
  | { readonly kind: "nested"; readonly directories: readonly string[] };

export type PluginSelection = "declared" | "native";

export interface Vendor {
  readonly name: string;
  readonly home: string;
  readonly pluginManifestPath: string;
  readonly catalogPath: string;
  readonly runtimeLayout: RuntimeLayout;
  readonly pluginSelection: PluginSelection;
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
