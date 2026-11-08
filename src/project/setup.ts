import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";

import { defaultRunner, type CommandRunner } from "../install/runner.js";
import { installSelectedPlugins } from "../vendors/codex/native.js";
import { assertRegular, privateWrite } from "./io.js";
import type { ProjectPlan } from "./plan.js";
import { verifyInventory, type ProjectReport } from "./verify.js";

export async function setupProject(
  plan: ProjectPlan,
  run: CommandRunner = defaultRunner,
): Promise<ProjectReport> {
  assertRegular(plan.stateRoot, "directory");
  assertRegular(plan.home, "directory");
  mkdirSync(plan.stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(plan.home, { recursive: true, mode: 0o700 });
  const lock = join(plan.home, ".setup-lock");
  try {
    mkdirSync(lock);
  } catch {
    throw new Error(`Setup is already active or interrupted; inspect ${lock}`);
  }
  try {
    const ready = join(plan.home, "ready");
    assertRegular(ready, "file");
    rmSync(ready, { force: true });
    privateWrite(
      join(plan.home, "project.json"),
      JSON.stringify(
        {
          version: 1,
          project: plan.project,
          preset: plan.preset,
          marketplaces: plan.marketplaces,
        },
        null,
        2,
      ) + "\n",
    );
    const configPath = join(plan.home, "config.toml");
    if (!existsSync(configPath)) privateWrite(configPath, stringify(plan.config));
    const agentsPath = join(plan.home, "AGENTS.md");
    assertRegular(agentsPath, "file");
    if (!existsSync(agentsPath) && plan.instructions !== undefined) {
      privateWrite(agentsPath, plan.instructions);
    }
    await installSelectedPlugins({
      home: plan.home,
      marketplaces: plan.marketplaces,
      plugins: plan.plugins.map((key) => {
        const plugin = plan.catalog.get(key);
        if (!plugin) throw new Error(`Missing selected plugin ${key}`);
        return { key, version: plugin.version };
      }),
      run,
    });
    const scopes = await verifyInventory(plan, run);
    privateWrite(ready, "1\n");
    return { project: plan.project, home: plan.home, status: "ready", scopes };
  } finally {
    rmSync(lock, { recursive: true });
  }
}
