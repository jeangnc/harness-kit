import type { CommandRunner } from "../install/runner.js";
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

export interface VendorInstallContext {
  readonly distRoot: string;
  readonly marketplace: string;
  readonly plugins: readonly DiscoveredVendorPlugin[];
  readonly run: CommandRunner;
  readonly log: (msg: string) => void;
}

export interface VendorEmitContext {
  readonly manifest: Plugin;
  readonly pluginOutDir: string;
}

export interface Vendor {
  readonly name: string;
  readonly home: string;
  readonly pluginManifestPath: string;
  readonly aliases?: (linkedFile: LinkedFile) => readonly string[];
  readonly emitPluginManifest: (ctx: VendorEmitContext) => Promise<void>;
  readonly install: (ctx: VendorInstallContext) => Promise<void>;
  readonly uninstall: (ctx: VendorInstallContext) => Promise<void>;
}
