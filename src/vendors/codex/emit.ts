import { join } from "node:path";

import { z } from "zod";

import { formatZodIssues } from "../../errors/index.js";
import type { Catalog, ResolvedPlugin } from "../../layout/index.js";
import { extensionBlock, withoutExtensions } from "../../plugin/index.js";
import { pluginSourcePath, writeJson } from "../shared.js";
import type { VendorEmitContext } from "../../vendor/schema.js";

export const CODEX_EXTENSION = "codex";
export const PLUGIN_MANIFEST_REL = ".codex-plugin/plugin.json";
export const CATALOG_REL = ".agents/plugins/marketplace.json";

const PolicySchema = z
  .object({
    installation: z.string().min(1),
    authentication: z.string().min(1).default("ON_INSTALL"),
  })
  .strict();

const CodexExtensionSchema = z
  .object({
    policy: PolicySchema.default({ installation: "AVAILABLE", authentication: "ON_INSTALL" }),
    category: z.string().min(1).default("Productivity"),
  })
  .passthrough();

type CodexExtension = z.infer<typeof CodexExtensionSchema>;

export async function emitCodexPluginManifest(ctx: VendorEmitContext): Promise<void> {
  const { policy: _policy, category: _category, ...manifestFields } = codexExtension(ctx.plugin);
  await writeJson(join(ctx.pluginOutDir, PLUGIN_MANIFEST_REL), {
    ...withoutExtensions(ctx.plugin.manifest),
    ...manifestFields,
  });
}

export async function emitCodexCatalog(vendorDir: string, catalog: Catalog): Promise<void> {
  await writeJson(join(vendorDir, CATALOG_REL), {
    name: catalog.name,
    interface: { displayName: catalog.name },
    ...(catalog.extensions[CODEX_EXTENSION] ?? {}),
    plugins: catalog.plugins.map(catalogEntry),
  });
}

function catalogEntry(plugin: ResolvedPlugin): Record<string, unknown> {
  const { policy, category } = codexExtension(plugin);
  return {
    name: plugin.name,
    source: { source: "local", path: pluginSourcePath(plugin.name) },
    policy,
    category,
  };
}

function codexExtension(plugin: ResolvedPlugin): CodexExtension {
  const parsed = CodexExtensionSchema.safeParse(extensionBlock(plugin.manifest, CODEX_EXTENSION));
  if (parsed.success) return parsed.data;
  throw new Error(
    `invalid extensions.codex in ${plugin.manifestPath}: ${formatZodIssues(parsed.error).join("; ")}`,
  );
}
