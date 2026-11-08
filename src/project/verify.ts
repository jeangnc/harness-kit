import { relative } from "node:path";

import { defaultRunner, type CommandRunner } from "../install/runner.js";
import { listCodexMcp, listCodexPlugins } from "../vendors/codex/native.js";
import { verifyEnvironment } from "./direnv.js";
import { inspectProjectHooks, type HookInspection, type HookInspector } from "./hooks.js";
import { enabledPlugins, table, type ProjectPlan } from "./plan.js";
import { requireReady } from "./state.js";

export interface ProjectInventory {
  readonly path: string;
  readonly plugins: readonly string[];
  readonly mcp: readonly string[];
}

export interface ProjectReport {
  readonly project: string;
  readonly home: string;
  readonly status: "ready" | "verified";
  readonly scopes: readonly ProjectInventory[];
  readonly hooks?: readonly HookInspection[];
}

export async function verifyProject(
  plan: ProjectPlan,
  options: {
    readonly environment: "direnv" | "none";
    readonly run?: CommandRunner;
    readonly inspectHooks?: HookInspector;
  },
): Promise<ProjectReport> {
  requireReady(plan);
  const run = options.run ?? defaultRunner;
  const scopes = await verifyInventory(plan, run);
  if (options.environment === "direnv") await verifyEnvironment(plan, run);
  const hooks = await (options.inspectHooks ?? inspectProjectHooks)({
    home: plan.home,
    cwds: plan.scopes.map(({ cwd }) => cwd),
  });
  if (hooks.some(({ pending }) => pending.length > 0)) {
    throw new Error(
      `Hook approval is pending in ${plan.home}; review /hooks in that project's Codex session`,
    );
  }
  return { project: plan.project, home: plan.home, status: "verified", scopes, hooks };
}

export async function verifyInventory(
  plan: ProjectPlan,
  run: CommandRunner,
): Promise<readonly ProjectInventory[]> {
  const scopes: ProjectInventory[] = [];
  for (const scope of plan.scopes) {
    const listed = await listCodexPlugins({ home: plan.home, cwd: scope.cwd, run });
    const actual = listed
      .filter((entry) => entry.enabled)
      .map((entry) => `${entry.name}@${entry.marketplaceName}`)
      .sort();
    const expected = enabledPlugins(scope.config);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Enabled plugin inventory differs at ${scope.cwd}; expected ${expected.join(", ")}, found ${actual.join(", ")}`,
      );
    }
    const servers = await listCodexMcp({ home: plan.home, cwd: scope.cwd, run });
    for (const [name, config] of Object.entries(table(scope.config["mcp_servers"]))) {
      const server = servers.find((entry) => entry.name === name);
      if (server?.enabled !== (table(config)["enabled"] ?? true)) {
        throw new Error(`MCP ${name} is missing or has different enablement at ${scope.cwd}`);
      }
    }
    scopes.push({
      path: relative(plan.project, scope.cwd) || ".",
      plugins: actual,
      mcp: servers
        .filter((entry) => entry.enabled)
        .map((entry) => entry.name)
        .sort(),
    });
  }
  return scopes;
}
