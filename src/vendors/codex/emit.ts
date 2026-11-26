import { join } from "node:path";

import { z } from "zod";

import { formatZodIssues } from "../../errors/index.js";
import type { Catalog, ResolvedPlugin } from "../../layout/index.js";
import { extensionBlock, withoutExtensions } from "../../plugin/index.js";
import { pluginIdentity, pluginSourcePath, writeJson } from "../shared.js";
import type { VendorEmitContext } from "../../vendor/schema.js";

export const EXTENSION_KEY = "codex";
export const PLUGIN_MANIFEST_REL = ".codex-plugin/plugin.json";
export const CATALOG_REL = ".agents/plugins/marketplace.json";

const PolicySchema = z
  .object({
    installation: z.string().min(1),
    authentication: z.string().min(1).default("ON_INSTALL"),
  })
  .strict();

const ExtensionSchema = z
  .object({
    policy: PolicySchema.default({ installation: "AVAILABLE", authentication: "ON_INSTALL" }),
    category: z.string().min(1).default("Productivity"),
  })
  .passthrough();

type Extension = z.infer<typeof ExtensionSchema>;

export async function emitPluginManifest(ctx: VendorEmitContext): Promise<void> {
  const { policy: _policy, category: _category, ...manifestFields } = readExtension(ctx.plugin);
  await writeJson(join(ctx.pluginOutDir, PLUGIN_MANIFEST_REL), {
    ...withoutExtensions(ctx.plugin.manifest),
    ...manifestFields,
    ...pluginIdentity(ctx.plugin.manifest),
  });
}

export async function emitCatalog(vendorDir: string, catalog: Catalog): Promise<void> {
  await writeJson(join(vendorDir, CATALOG_REL), {
    interface: { displayName: catalog.name },
    ...(catalog.extensions[EXTENSION_KEY] ?? {}),
    name: catalog.name,
    plugins: catalog.plugins.map(catalogEntry),
  });
}

function catalogEntry(plugin: ResolvedPlugin): Record<string, unknown> {
  const { policy, category } = readExtension(plugin);
  return {
    name: plugin.name,
    source: { source: "local", path: pluginSourcePath(plugin.name) },
    policy,
    category,
  };
}

function readExtension(plugin: ResolvedPlugin): Extension {
  const parsed = ExtensionSchema.safeParse(extensionBlock(plugin.manifest, EXTENSION_KEY));
  if (parsed.success) return parsed.data;
  throw new Error(
    `invalid extensions.codex in ${plugin.manifestPath}: ${formatZodIssues(parsed.error).join("; ")}`,
  );
}
