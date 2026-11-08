import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { parse } from "smol-toml";
import { z } from "zod";

import {
  enrollProject,
  locateProject,
  prepareProject,
  selectProject,
  setupProject,
  verifyProject,
} from "./index.js";
import type { ProjectPreset } from "./index.js";

const locationArgs = {
  project: { type: "string", required: true, description: "Git checkout path" },
  "state-root": {
    type: "string",
    required: true,
    description: "Directory for independent Codex homes",
  },
} as const;

const PresetSchema = z.object({
  name: z.string().min(1),
  marketplaces: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })),
  config: z.string(),
  instructions: z.string().optional(),
});

export const projectCmd = defineCommand({
  meta: { name: "project", description: "Prepare and select independent Codex CLI project homes" },
  subCommands: {
    setup: defineCommand({
      meta: { description: "Initialize a project home from an explicit preset" },
      args: {
        ...locationArgs,
        preset: {
          type: "string",
          required: true,
          description: "JSON preset path; config contains TOML",
        },
        "dry-run": {
          type: "boolean",
          default: false,
          description: "Print selection without writing",
        },
      },
      run: async ({ args }) => {
        const location = await locateProject({
          project: args.project,
          stateRoot: args["state-root"],
        });
        const plan = await prepareProject({ location, preset: readPreset(args.preset) });
        console.log(
          JSON.stringify(
            args["dry-run"]
              ? {
                  project: plan.project,
                  home: plan.home,
                  preset: plan.preset,
                  plugins: plan.plugins,
                  scopes: plan.scopes.map(({ cwd }) => cwd),
                }
              : await setupProject(plan),
          ),
        );
      },
    }),
    enroll: defineCommand({
      meta: { description: "Append a direnv selector; approval remains explicit" },
      args: locationArgs,
      run: async ({ args }) => {
        const location = await locateProject({
          project: args.project,
          stateRoot: args["state-root"],
        });
        await enrollProject(await prepareProject({ location }));
        console.log(`Enrolled ${location.project}; review .envrc and run direnv allow`);
      },
    }),
    verify: defineCommand({
      meta: { description: "Check native plugins, MCP, hooks, and optional direnv selection" },
      args: {
        ...locationArgs,
        environment: {
          type: "string",
          default: "none",
          description: "Environment to verify: none | direnv",
        },
      },
      run: async ({ args }) => {
        const environment = z.enum(["none", "direnv"]).parse(args.environment);
        const location = await locateProject({
          project: args.project,
          stateRoot: args["state-root"],
        });
        console.log(
          JSON.stringify(await verifyProject(await prepareProject({ location }), { environment })),
        );
      },
    }),
    select: defineCommand({
      meta: { description: "Print a ready project home without modifying it" },
      args: locationArgs,
      run: async ({ args }) => {
        console.log(await selectProject({ project: args.project, stateRoot: args["state-root"] }));
      },
    }),
  },
});

function readPreset(path: string): ProjectPreset {
  try {
    const preset = PresetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return {
      name: preset.name,
      marketplaces: preset.marketplaces,
      config: parse(preset.config),
      ...(preset.instructions !== undefined ? { instructions: preset.instructions } : {}),
    };
  } catch {
    throw new Error(`Unable to read preset ${path}; expected name, marketplaces, and TOML config`);
  }
}
