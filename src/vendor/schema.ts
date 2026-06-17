import type { InstallMode } from "../install/mode.js";
import type { CommandRunner } from "../install/runner.js";
import type { Marketplace } from "../marketplace/index.js";
import type { Plugin } from "../plugin/index.js";

export interface LinkedFile {
  readonly srcAbs: string;
  readonly destAbs: string;
  readonly destRel: string;
  readonly basename: string;
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

export interface VendorInstallContext {
  readonly distRoot: string;
  readonly marketplace: string;
  readonly plugins: readonly DiscoveredVendorPlugin[];
  readonly mode: InstallMode;
  readonly run: CommandRunner;
  readonly log: (msg: string) => void;
}

export interface VendorEmitContext {
  readonly manifest: Plugin;
  readonly pluginOutDir: string;
}

export interface VendorMarketplaceEmitContext {
  readonly outRoot: string;
  readonly marketplace: Marketplace;
}

export interface Vendor {
  readonly name: string;
  readonly home: string;
  readonly pluginManifestPath: string;
  readonly marketplaceManifestPath: string;
  readonly vendorOutDir: (outRoot: string) => string;
  readonly pluginOutDir: (outRoot: string, pluginName: string) => string;
  readonly configsOutDir: (outRoot: string) => string;
  readonly aliases?: (linkedFile: LinkedFile) => readonly string[];
  readonly emitPluginManifest: (ctx: VendorEmitContext) => Promise<void>;
  readonly emitMarketplaceManifest: (ctx: VendorMarketplaceEmitContext) => Promise<void>;
  readonly install: (ctx: VendorInstallContext) => Promise<void>;
  readonly refresh: (ctx: VendorInstallContext) => Promise<void>;
  readonly uninstall: (ctx: VendorInstallContext) => Promise<void>;
  readonly partitionPlugins: (ctx: VendorInstallContext) => PluginPartition;
  readonly isInstalled: (ctx: VendorInstallContext) => Promise<boolean>;
  readonly installedVersions: (ctx: VendorInstallContext) => Promise<ReadonlyMap<string, string>>;
}
