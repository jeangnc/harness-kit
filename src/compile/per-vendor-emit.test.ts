import { test } from "node:test";
import { deepEqual, doesNotMatch, doesNotReject, equal, match, rejects } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compilePlugins, verifyEmittedMarketplaceSources } from "./index.js";
import { claudeVendor } from "../vendors/claude/index.js";
import { codexVendor } from "../vendors/codex/index.js";
import { layoutAt, type Layout } from "../layout/index.js";
import { AGENT_PLUGINS_SCHEMA } from "../plugin/index.js";

async function withSandbox(fn: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-per-vendor-emit-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testLayout(repoRoot: string, outRoot: string): Layout {
  return { ...layoutAt(repoRoot), buildDir: outRoot };
}

function seedMinimalPlugin(
  repoRoot: string,
  pluginName: string,
  extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): void {
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(
    join(repoRoot, "harness.yaml"),
    "marketplace: test-marketplace\nowner:\n  name: test\nvendors: [claude, codex]\n",
  );
  const pluginDir = join(repoRoot, "plugins", pluginName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGINS_SCHEMA,
      name: pluginName,
      version: "1.0.0",
      description: "test plugin",
      ...(extensions === undefined ? {} : { extensions }),
    }),
  );
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("compilePlugins emits one subtree per declared vendor under dist/<vendor>/plugins/<name>/", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "alpha");

    await compilePlugins({
      layout: testLayout(repoRoot, outRoot),
      vendors: [claudeVendor, codexVendor],
    });

    equal(existsSync(join(outRoot, "claude/plugins/alpha/.claude-plugin/plugin.json")), true);
    equal(existsSync(join(outRoot, "codex/plugins/alpha/.codex-plugin/plugin.json")), true);
  });
});

test("compilePlugins writes each vendor's plugin manifest at the vendor-declared path", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "beta");

    await compilePlugins({
      layout: testLayout(repoRoot, outRoot),
      vendors: [claudeVendor, codexVendor],
    });

    const claudeManifest = JSON.parse(
      readFileSync(join(outRoot, "claude/plugins/beta/.claude-plugin/plugin.json"), "utf8"),
    ) as { name: string; version: string };
    const codexManifest = JSON.parse(
      readFileSync(join(outRoot, "codex/plugins/beta/.codex-plugin/plugin.json"), "utf8"),
    ) as { name: string; version: string };

    equal(claudeManifest.name, "beta");
    equal(claudeManifest.version, "1.0.0");
    equal(codexManifest.name, "beta");
    equal(codexManifest.version, "1.0.0");
  });
});

test("compilePlugins only emits subtrees for vendors passed in (gemini absent → no gemini dir)", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "gamma");

    await compilePlugins({ layout: testLayout(repoRoot, outRoot), vendors: [claudeVendor] });

    equal(existsSync(join(outRoot, "claude/plugins/gamma")), true);
    equal(existsSync(join(outRoot, "codex")), false);
    equal(existsSync(join(outRoot, "gemini")), false);
  });
});

test("compilePlugins mirrors skills inside each vendor subtree", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "delta");
    const skillDir = join(repoRoot, "plugins/delta/skills/widget");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: widget\ndescription: a widget skill for testing\n---\n\nBody.\n",
    );

    await compilePlugins({
      layout: testLayout(repoRoot, outRoot),
      vendors: [claudeVendor, codexVendor],
    });

    equal(existsSync(join(outRoot, "claude/plugins/delta/skills/widget/SKILL.md")), true);
    equal(existsSync(join(outRoot, "codex/plugins/delta/skills/widget/SKILL.md")), true);
  });
});

test("compilePlugins copies plugin-root .mcp.json verbatim into each vendor subtree", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "zeta");
    const mcpConfig = {
      mcpServers: {
        Example: { type: "stdio", command: "node", args: ["server.js"] },
      },
    };
    writeFileSync(join(repoRoot, "plugins/zeta/.mcp.json"), JSON.stringify(mcpConfig, null, 2));

    await compilePlugins({
      layout: testLayout(repoRoot, outRoot),
      vendors: [claudeVendor, codexVendor],
    });

    for (const vendorDir of ["claude", "codex"]) {
      const emittedPath = join(outRoot, vendorDir, "plugins/zeta/.mcp.json");
      equal(existsSync(emittedPath), true, `${vendorDir}: .mcp.json missing`);
      deepEqual(JSON.parse(readFileSync(emittedPath, "utf8")), mcpConfig);
    }
  });
});

test("compilePlugins skips other plugin-root dotfiles (.DS_Store, editor noise)", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "eta");
    writeFileSync(join(repoRoot, "plugins/eta/.DS_Store"), "noise");
    writeFileSync(join(repoRoot, "plugins/eta/.env.local"), "SECRET=1");

    await compilePlugins({ layout: testLayout(repoRoot, outRoot), vendors: [claudeVendor] });

    equal(existsSync(join(outRoot, "claude/plugins/eta/.DS_Store")), false);
    equal(existsSync(join(outRoot, "claude/plugins/eta/.env.local")), false);
  });
});

const plainMdPlaceholderCases = [
  { placeholder: "include", directive: "{{include:./sibling.md}}", resolved: /shared body/ },
  { placeholder: "ref", directive: "{{ref:./sibling.md}}", resolved: /sibling\.md/ },
] as const;

for (const { placeholder, directive, resolved } of plainMdPlaceholderCases) {
  test(`compilePlugins resolves {{${placeholder}}} in a plain plugin-root .md file`, async () => {
    await withSandbox(async (root) => {
      const repoRoot = join(root, "repo");
      const outRoot = join(root, "dist");
      seedMinimalPlugin(repoRoot, "epsilon");
      const pluginDir = join(repoRoot, "plugins/epsilon");
      writeFileSync(join(pluginDir, "sibling.md"), "shared body\n");
      writeFileSync(join(pluginDir, "doc.md"), `# Doc\n\n${directive}\n`);

      await compilePlugins({ layout: testLayout(repoRoot, outRoot), vendors: [claudeVendor] });

      const rendered = readFileSync(join(outRoot, "claude/plugins/epsilon/doc.md"), "utf8");
      match(rendered, resolved);
      doesNotMatch(rendered, /\{\{/);
    });
  });
}

function emitMarketplaceForVerification(outRoot: string, names: readonly string[]): void {
  const dir = join(outRoot, "claude/.claude-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "marketplace.json"),
    JSON.stringify({
      name: "test-marketplace",
      owner: { name: "test" },
      plugins: names.map((name) => ({ name, source: `./plugins/${name}` })),
    }),
  );
}

function emitPluginManifestForVerification(outRoot: string, name: string): void {
  const dir = join(outRoot, "claude/plugins", name, ".claude-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
}

test("verifyEmittedMarketplaceSources passes when every relative source has an emitted manifest", async () => {
  await withSandbox(async (root) => {
    const outRoot = join(root, "dist");
    emitMarketplaceForVerification(outRoot, ["alpha", "beta"]);
    emitPluginManifestForVerification(outRoot, "alpha");
    emitPluginManifestForVerification(outRoot, "beta");

    await doesNotReject(verifyEmittedMarketplaceSources(outRoot, claudeVendor));
  });
});

test("verifyEmittedMarketplaceSources throws when an emitted source has no plugin manifest", async () => {
  await withSandbox(async (root) => {
    const outRoot = join(root, "dist");
    emitMarketplaceForVerification(outRoot, ["alpha", "ghost"]);
    emitPluginManifestForVerification(outRoot, "alpha");

    await rejects(
      verifyEmittedMarketplaceSources(outRoot, claudeVendor),
      /ghost → \.\/plugins\/ghost/,
    );
  });
});

test("compilePlugins fails when a plain .md file has an unknown placeholder prefix", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "zeta");
    writeFileSync(join(repoRoot, "plugins/zeta", "doc.md"), "see {{ghost:./x.md}}\n");

    await rejects(
      compilePlugins({ layout: testLayout(repoRoot, outRoot), vendors: [claudeVendor] }),
    );
  });
});

test("compilePlugins merges extensions.codex into the codex plugin manifest", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    const pluginInterface = { displayName: "Theta", capabilities: ["Read"] };
    seedMinimalPlugin(repoRoot, "theta", { codex: { interface: pluginInterface } });

    await compilePlugins({ layout: testLayout(repoRoot, outRoot), vendors: [codexVendor] });

    const manifest = readJson(join(outRoot, "codex/plugins/theta/.codex-plugin/plugin.json"));
    deepEqual(manifest["interface"], pluginInterface);
  });
});

test("compilePlugins omits extensions.codex policy and category from the codex plugin manifest", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "theta", {
      codex: { policy: { installation: "INSTALLED_BY_DEFAULT" }, category: "Coding" },
    });

    await compilePlugins({ layout: testLayout(repoRoot, outRoot), vendors: [codexVendor] });

    const manifest = readJson(join(outRoot, "codex/plugins/theta/.codex-plugin/plugin.json"));
    equal("policy" in manifest, false);
    equal("category" in manifest, false);
  });
});

test("compilePlugins keeps extensions.claude keys out of the codex plugin manifest", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "theta", { claude: { dependencies: ["other"] } });

    await compilePlugins({ layout: testLayout(repoRoot, outRoot), vendors: [codexVendor] });

    const manifest = readJson(join(outRoot, "codex/plugins/theta/.codex-plugin/plugin.json"));
    equal("dependencies" in manifest, false);
    equal("$schema" in manifest, false);
    equal("extensions" in manifest, false);
  });
});

test("compilePlugins emits default policy and category in the codex catalog when extensions.codex omits them", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "iota");

    await compilePlugins({ layout: testLayout(repoRoot, outRoot), vendors: [codexVendor] });

    const catalog = readJson(join(outRoot, "codex/.agents/plugins/marketplace.json"));
    deepEqual(catalog, {
      name: "test-marketplace",
      interface: { displayName: "test-marketplace" },
      plugins: [
        {
          name: "iota",
          source: { source: "local", path: "./plugins/iota" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    });
  });
});

test("compilePlugins emits explicit extensions.codex policy and category in the codex catalog", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "iota", {
      codex: {
        policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_USE" },
        category: "Coding",
      },
    });

    await compilePlugins({ layout: testLayout(repoRoot, outRoot), vendors: [codexVendor] });

    const catalog = readJson(join(outRoot, "codex/.agents/plugins/marketplace.json")) as {
      plugins: ReadonlyArray<Record<string, unknown>>;
    };
    deepEqual(catalog.plugins[0]?.["policy"], {
      installation: "INSTALLED_BY_DEFAULT",
      authentication: "ON_USE",
    });
    equal(catalog.plugins[0]?.["category"], "Coding");
  });
});

test("compilePlugins does not copy the source plugin.json verbatim into either vendor tree", async () => {
  await withSandbox(async (root) => {
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "dist");
    seedMinimalPlugin(repoRoot, "kappa");

    await compilePlugins({
      layout: testLayout(repoRoot, outRoot),
      vendors: [claudeVendor, codexVendor],
    });

    equal(existsSync(join(outRoot, "claude/plugins/kappa/plugin.json")), false);
    equal(existsSync(join(outRoot, "codex/plugins/kappa/plugin.json")), false);
  });
});
