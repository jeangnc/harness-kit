import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { z } from "zod";

import { errnoCode } from "../../fs.js";
import type { CommandRunner } from "../../install/runner.js";

const pluginEntry = z.object({
  name: z.string(),
  marketplaceName: z.string(),
  version: z.string(),
  installed: z.boolean(),
  enabled: z.boolean(),
  source: z.object({ source: z.string().optional() }).optional(),
});
const pluginList = z.object({
  installed: z.array(pluginEntry),
  available: z.array(pluginEntry),
});
const mcpEntry = z.object({ name: z.string(), enabled: z.boolean() });

export type PluginEntry = z.infer<typeof pluginEntry>;
export type McpEntry = z.infer<typeof mcpEntry>;

export interface Invocation {
  readonly home: string;
  readonly cwd: string;
  readonly run: CommandRunner;
}

export interface LocalMarketplace {
  readonly name: string;
  readonly path: string;
}

export interface SelectedPlugin {
  readonly key: string;
  readonly version: string;
}

export interface SelectedPlugins {
  readonly home: string;
  readonly marketplaces: readonly LocalMarketplace[];
  readonly plugins: readonly SelectedPlugin[];
  readonly run: CommandRunner;
}

export async function installSelectedPlugins(options: SelectedPlugins): Promise<void> {
  const home = resolve(options.home);
  const context = { home, cwd: parse(home).root, run: options.run };
  const snapshot = await snapshotConfig(home);
  try {
    for (const marketplace of options.marketplaces) {
      await registerMarketplace({ ...context, marketplace });
    }
    const installed = await listPlugins(context);
    for (const plugin of options.plugins) {
      if (installed.some((entry) => matchesPlugin(entry, plugin))) continue;
      await installPlugin({ ...context, plugin });
    }
    const actual = await listPlugins(context);
    for (const plugin of options.plugins) {
      if (!actual.some((entry) => matchesPlugin(entry, plugin))) {
        throw new Error(
          `Codex registry does not contain ${plugin.key} at version ${plugin.version}`,
        );
      }
    }
  } finally {
    await restoreConfig(snapshot);
  }
}

function matchesPlugin(entry: PluginEntry, plugin: SelectedPlugin): boolean {
  return (
    `${entry.name}@${entry.marketplaceName}` === plugin.key && entry.version === plugin.version
  );
}

interface ConfigSnapshot {
  readonly path: string;
  readonly backup: string;
  readonly contents: Buffer;
}

async function snapshotConfig(home: string): Promise<ConfigSnapshot> {
  const path = join(home, "config.toml");
  if (!(await lstat(path)).isFile()) {
    throw new Error("Codex plugin installation requires a regular config.toml file");
  }
  const contents = await readFile(path);
  const backup = join(home, "config.before-install.toml");
  try {
    await writeFile(backup, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      throw new Error(`Interrupted Codex installation requires recovery from ${backup}`);
    }
    throw error;
  }
  return { path, backup, contents };
}

async function restoreConfig(snapshot: ConfigSnapshot): Promise<void> {
  try {
    const staging = await mkdtemp(join(parse(snapshot.path).dir, ".config-restore-"));
    try {
      const path = join(staging, "config.toml");
      await writeFile(path, snapshot.contents, { flag: "wx", mode: 0o600 });
      await rename(path, snapshot.path);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } catch {
    throw new Error(
      `Codex config restoration failed; recover the private backup at ${snapshot.backup}`,
    );
  }
  await rm(snapshot.backup);
}

export async function listPlugins(context: Invocation): Promise<readonly PluginEntry[]> {
  const result = await readJson({
    ...context,
    args: ["plugin", "list", "--json"],
    operation: "plugin list",
    schema: pluginList,
  });
  return result.installed.filter((entry) => entry.installed);
}

export async function listMcpServers(context: Invocation): Promise<readonly McpEntry[]> {
  return readJson({
    ...context,
    args: ["mcp", "list", "--json"],
    operation: "MCP list",
    schema: z.array(mcpEntry),
  });
}

export async function listMarketplacePlugins(
  options: Invocation & { readonly marketplace: string },
): Promise<readonly PluginEntry[]> {
  const result = await readJson({
    ...options,
    args: ["plugin", "list", "--marketplace", options.marketplace, "--available", "--json"],
    operation: "plugin list",
    schema: pluginList,
  });
  return [...result.installed, ...result.available].filter(
    (entry) => entry.marketplaceName === options.marketplace,
  );
}

export interface GitMarketplace {
  readonly name: string;
  readonly repository: string;
  readonly ref: string;
}

export async function registerMarketplace(
  options: Invocation & { readonly marketplace: LocalMarketplace },
): Promise<void> {
  await addMarketplace(options, {
    name: options.marketplace.name,
    args: [resolve(options.marketplace.path)],
  });
}

export async function registerGitMarketplace(
  options: Invocation & { readonly marketplace: GitMarketplace },
): Promise<void> {
  const { name, repository, ref } = options.marketplace;
  await addMarketplace(options, { name, args: [repository, "--ref", ref] });
}

interface MarketplaceAddition {
  readonly name: string;
  readonly args: readonly string[];
}

async function addMarketplace(context: Invocation, addition: MarketplaceAddition): Promise<void> {
  const result = await readJson({
    ...context,
    args: ["plugin", "marketplace", "add", ...addition.args, "--json"],
    operation: "marketplace add",
    schema: z.object({ marketplaceName: z.string() }),
  });
  if (result.marketplaceName !== addition.name) {
    throw new Error(`Codex registered an unexpected marketplace; expected ${addition.name}`);
  }
}

export async function listMarketplaceNames(options: Invocation): Promise<readonly string[]> {
  const result = await readJson({
    ...options,
    args: ["plugin", "marketplace", "list", "--json"],
    operation: "marketplace list",
    schema: z.object({ marketplaces: z.array(z.object({ name: z.string() })) }),
  });
  return result.marketplaces.map((entry) => entry.name);
}

export async function upgradeMarketplace(
  options: Invocation & { readonly marketplace: string },
): Promise<void> {
  const result = await readJson({
    ...options,
    args: ["plugin", "marketplace", "upgrade", options.marketplace, "--json"],
    operation: "marketplace upgrade",
    schema: z.object({ errors: z.array(z.unknown()) }),
  });
  if (result.errors.length > 0) {
    throw new Error(
      "Codex marketplace upgrade failed; inspect its configured Git source before retrying",
    );
  }
}

export async function installPlugin(
  options: Invocation & { readonly plugin: SelectedPlugin },
): Promise<void> {
  const result = await readJson({
    ...options,
    args: ["plugin", "add", options.plugin.key, "--json"],
    operation: "plugin add",
    schema: z.object({ version: z.string() }),
  });
  if (result.version !== options.plugin.version) {
    throw new Error(
      `Codex installed an unexpected version; expected ${options.plugin.key} at version ${options.plugin.version}`,
    );
  }
}

export async function removePlugin(options: Invocation & { readonly key: string }): Promise<void> {
  await execute({
    ...options,
    args: ["plugin", "remove", options.key, "--json"],
    operation: "plugin remove",
  });
}

export async function removeMarketplace(
  options: Invocation & { readonly marketplace: string },
): Promise<void> {
  await execute({
    ...options,
    args: ["plugin", "marketplace", "remove", options.marketplace, "--json"],
    operation: "marketplace remove",
  });
}

interface CommandRequest extends Invocation {
  readonly args: readonly string[];
  readonly operation: string;
}

async function readJson<T>(
  request: CommandRequest & { readonly schema: z.ZodType<T> },
): Promise<T> {
  const output = await execute(request);
  try {
    return request.schema.parse(JSON.parse(output ?? ""));
  } catch {
    throw new Error(`Codex ${request.operation} did not return the expected native JSON`);
  }
}

async function execute(request: CommandRequest): Promise<void | string> {
  try {
    return await request.run("codex", request.args, {
      env: { CODEX_HOME: resolve(request.home) },
      cwd: resolve(request.cwd),
    });
  } catch {
    throw new Error(`Codex ${request.operation} failed; native output withheld`);
  }
}
