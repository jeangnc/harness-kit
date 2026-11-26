import { equal, fail, ifError, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { TestContext } from "node:test";
import { parse, stringify, type TomlTable } from "smol-toml";
import type { CommandRunner } from "../install/runner.js";
import { locateProject, prepareProject } from "./index.js";

export const rootPlugin = "foo@foo";
export const appPlugin = "bar@foo";
export const nestedPlugin = "foo@bar";
export const leafPlugin = "bar@bar";

type Preset = NonNullable<Parameters<typeof prepareProject>[0]["preset"]>;

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface Fixture {
  readonly root: string;
  readonly project: string;
  readonly stateRoot: string;
  readonly preset: Preset;
  readonly run: typeof execute;
}

interface CommandCall {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly home: string | undefined;
}

interface MarketplaceManifest {
  readonly name: string;
  readonly plugins: ReadonlyArray<{
    readonly name: string;
    readonly source: { readonly path: string };
  }>;
}

export interface Inventory {
  readonly installed: Array<{
    readonly name: string;
    readonly marketplaceName: string;
    readonly version: string;
    readonly installed: boolean;
    enabled: boolean;
  }>;
  readonly available: readonly unknown[];
}

export async function createFixture(
  t: TestContext,
  { projectName = "foo", stateName = "state" } = {},
): Promise<Fixture> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "harness-project-"));
  const project = join(root, projectName);
  const stateRoot = join(root, stateName);
  const userHome = join(root, "user");
  mkdirSync(userHome);
  const environment = {
    HOME: userHome,
    XDG_CONFIG_HOME: join(userHome, ".config"),
    XDG_DATA_HOME: join(userHome, ".local/share"),
    DIRENV_LOG_FORMAT: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const run = async (program: string, args: readonly string[], options: RunOptions = {}) =>
    execute(program, args, { ...options, env: { ...environment, ...options.env } });
  await run("git", ["init", "--quiet", project]);
  const marketplaces = ["foo", "bar"].map((name) => ({
    name,
    path: createMarketplace(root, name),
  }));
  const preset = {
    name: "foo",
    marketplaces,
    config: {
      cli_auth_credentials_store: "file",
      mcp_oauth_credentials_store: "file",
      projects: { [project]: { trust_level: "trusted" } },
      plugins: { [rootPlugin]: { enabled: true } },
    },
    instructions: "Use foo terms.\n",
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, stateRoot, preset, run };
}

export async function execute(
  program: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout: 30_000,
    ...options,
    env: { ...process.env, ...options.env },
  });
  ifError(result.error);
  equal(result.status, 0, `${program} ${args.join(" ")}\n${result.stderr}`);
  if (program === "direnv" && args[0] === "exec") equal(result.stderr, "");
  return result.stdout;
}

function createMarketplace(root: string, name: string): string {
  const marketplace = join(root, "marketplaces", name);
  const names = ["foo", "bar"];
  mkdirSync(join(marketplace, ".agents/plugins"), { recursive: true });
  writeFileSync(
    join(marketplace, ".agents/plugins/marketplace.json"),
    JSON.stringify({
      name,
      plugins: names.map((plugin) => ({
        name: plugin,
        source: { source: "local", path: `./plugins/${plugin}` },
      })),
    }),
  );
  for (const plugin of names) {
    const path = join(marketplace, "plugins", plugin, ".codex-plugin");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: plugin, version: "1.0.0" }));
  }
  return marketplace;
}

export function createNativeRuntime(
  fixture: Fixture,
  { failPlugin }: { readonly failPlugin?: string } = {},
) {
  const calls: CommandCall[] = [];
  const catalog = new Map<string, string>();
  const installed = new Map<string, string>();
  const writtenConfigs: TomlTable[] = [];
  let pendingFailure = failPlugin;
  const run: CommandRunner = async (program, args, options) => {
    const home = options?.env["CODEX_HOME"];
    calls.push({ program, args: [...args], cwd: options?.cwd, home });
    if (program !== "codex") return fixture.run(program, args, options);
    ok(home, "Native Codex commands require an isolated CODEX_HOME");
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
      const path = args[3]!;
      const marketplace = JSON.parse(
        readFileSync(join(path, ".agents/plugins/marketplace.json"), "utf8"),
      ) as MarketplaceManifest;
      for (const plugin of marketplace.plugins) {
        const manifest = JSON.parse(
          readFileSync(join(path, plugin.source.path, ".codex-plugin/plugin.json"), "utf8"),
        ) as { readonly version: string };
        catalog.set(`${plugin.name}@${marketplace.name}`, manifest.version);
      }
      rewriteConfiguration(home, writtenConfigs, (config) => {
        table(config["marketplaces"])[marketplace.name] = { source_type: "local", source: path };
      });
      return JSON.stringify({ marketplaceName: marketplace.name });
    }
    if (args[0] === "plugin" && args[1] === "add") {
      const identity = args[2]!;
      ok(catalog.has(identity), `Expected a registered marketplace for ${identity}`);
      rewriteConfiguration(home, writtenConfigs, (config) => {
        table(config["plugins"])[identity] = { enabled: true };
      });
      if (pendingFailure === identity) {
        pendingFailure = undefined;
        throw new Error(`Native installation failed for ${identity}`);
      }
      const version = catalog.get(identity)!;
      installed.set(identity, version);
      return JSON.stringify({ version });
    }
    const effective = effectiveEnablement({ home, cwd: options.cwd, project: fixture.project });
    if (args[0] === "plugin" && args[1] === "list") {
      return JSON.stringify({
        installed: [...installed].map(([identity, version]) => {
          const [name, marketplaceName] = identity.split("@");
          return {
            name,
            marketplaceName,
            version,
            installed: true,
            enabled: effective.plugins.get(identity) === true,
          };
        }),
        available: [],
      });
    }
    if (args[0] === "mcp" && args[1] === "list") {
      return JSON.stringify([...effective.servers].map(([name, enabled]) => ({ name, enabled })));
    }
    fail(`Unexpected native command: ${args.join(" ")}`);
  };
  return { run, calls, writtenConfigs, installedPlugins: () => [...installed.keys()].sort() };
}

function rewriteConfiguration(
  home: string,
  writtenConfigs: TomlTable[],
  change: (config: TomlTable) => void,
): void {
  const path = join(home, "config.toml");
  const config = parse(readFileSync(path, "utf8"));
  change(config);
  writeFileSync(path, stringify(config));
  writtenConfigs.push(config);
}

function table(value: unknown): TomlTable {
  ok(value && typeof value === "object" && !Array.isArray(value));
  return value as TomlTable;
}

function effectiveEnablement({
  home,
  cwd,
  project,
}: {
  readonly home: string;
  readonly cwd: string;
  readonly project: string;
}) {
  const ancestors: string[] = [];
  if (cwd === project || cwd.startsWith(`${project}/`)) {
    for (let path = cwd; ; path = dirname(path)) {
      ancestors.unshift(join(path, ".codex/config.toml"));
      if (path === project) break;
    }
  }
  const plugins = new Map<string, boolean>();
  const servers = new Map<string, boolean>();
  for (const path of [join(home, "config.toml"), ...ancestors]) {
    if (!existsSync(path)) continue;
    const config = parse(readFileSync(path, "utf8"));
    for (const [identity, value] of Object.entries(table(config["plugins"] ?? {}))) {
      const enabled = table(value)["enabled"];
      if (typeof enabled === "boolean") plugins.set(identity, enabled);
    }
    for (const [name, value] of Object.entries(table(config["mcp_servers"] ?? {}))) {
      const enabled = table(value)["enabled"] ?? servers.get(name) ?? true;
      ok(typeof enabled === "boolean");
      servers.set(name, enabled);
    }
  }
  return { plugins, servers };
}

export async function prepareFixture(fixture: Fixture) {
  const location = await locateProject(fixture, fixture.run);
  return prepareProject({ location, preset: fixture.preset }, fixture.run);
}

export async function trustedHooks({ cwds }: { readonly cwds: readonly string[] }) {
  return cwds.map((cwd) => ({ cwd, trusted: 1, pending: [] }));
}

export function writeProjectConfig(project: string, contents: string): void {
  mkdirSync(join(project, ".codex"), { recursive: true });
  writeFileSync(join(project, ".codex/config.toml"), contents);
}

export function snapshot(root: string): Readonly<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};
  const visit = (path: string) => {
    const stat = lstatSync(path);
    const key = relative(root, path) || ".";
    if (stat.isSymbolicLink()) {
      entries[key] = { link: readlinkSync(path) };
    } else if (stat.isDirectory()) {
      entries[key] = { directory: true, mode: stat.mode };
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else {
      entries[key] = { contents: readFileSync(path).toString("base64"), mode: stat.mode };
    }
  };
  visit(root);
  return entries;
}

export function pluginEnabled(config: TomlTable, identity: string): boolean {
  const enabled = table(table(config["plugins"])[identity])["enabled"];
  ok(typeof enabled === "boolean");
  return enabled;
}

export function isPluginInstall({ program, args }: CommandCall): boolean {
  return program === "codex" && args[0] === "plugin" && args[1] === "add";
}
