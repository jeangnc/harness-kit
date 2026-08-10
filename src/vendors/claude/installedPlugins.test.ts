import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  patchInstalledEntries,
  readInstalledPlugins,
  removeInstalledEntries,
  writeInstalledPlugins,
} from "./installedPlugins.js";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "harness-kit-registry-"));
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeRegistry(home: string, body: unknown): void {
  const dir = join(home, "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify(body));
}

test("readInstalledPlugins returns an empty registry when the file is missing", async () => {
  await withHome(async (home) => {
    const registry = await readInstalledPlugins(home);
    assert.deepEqual(registry, { version: 2, plugins: {} });
  });
});

test("readInstalledPlugins parses entries across multiple scopes", async () => {
  await withHome(async (home) => {
    writeRegistry(home, {
      version: 2,
      plugins: {
        "dev-tools@market": [
          { scope: "user", installPath: "/c/market/dev-tools/3.2.4", version: "3.2.4" },
          {
            scope: "local",
            projectPath: "/repo",
            installPath: "/c/market/dev-tools/3.2.0",
            version: "3.2.0",
          },
        ],
      },
    });
    const registry = await readInstalledPlugins(home);
    assert.equal(registry.plugins["dev-tools@market"]!.length, 2);
    assert.equal(registry.plugins["dev-tools@market"]![1]!.projectPath, "/repo");
  });
});

test("readInstalledPlugins throws on a malformed registry rather than silently dropping data", async () => {
  await withHome(async (home) => {
    writeRegistry(home, { version: 2, plugins: { "x@m": [{ scope: "user" }] } });
    await assert.rejects(async () => readInstalledPlugins(home), /installed_plugins\.json/);
  });
});

test("patchInstalledEntries updates every scope entry for a key in place", () => {
  const registry = {
    version: 2 as const,
    plugins: {
      "dev-tools@market": [
        { scope: "user", installPath: "/old/3.2.0", version: "3.2.0" },
        { scope: "local", projectPath: "/repo", installPath: "/old/3.2.0", version: "3.2.0" },
      ],
    },
  };
  const patched = patchInstalledEntries(registry, "dev-tools@market", {
    installPath: "/new/3.2.4",
    version: "3.2.4",
    lastUpdated: "2026-06-17T00:00:00.000Z",
  });
  for (const entry of patched.plugins["dev-tools@market"]!) {
    assert.equal(entry.version, "3.2.4");
    assert.equal(entry.installPath, "/new/3.2.4");
    assert.equal(entry.lastUpdated, "2026-06-17T00:00:00.000Z");
  }
  assert.equal(
    patched.plugins["dev-tools@market"]![1]!.projectPath,
    "/repo",
    "scope metadata preserved",
  );
});

test("patchInstalledEntries leaves the registry untouched when the key is absent", () => {
  const registry = { version: 2 as const, plugins: {} };
  const patched = patchInstalledEntries(registry, "absent@market", {
    installPath: "/x",
    version: "1.0.0",
    lastUpdated: "2026-06-17T00:00:00.000Z",
  });
  assert.deepEqual(patched, registry);
});

test("removeInstalledEntries drops every scope entry for the removed key", () => {
  const registry = {
    version: 2 as const,
    plugins: {
      "gone@market": [
        { scope: "user" as const, installPath: "/c/market/gone/1.0.0", version: "1.0.0" },
        {
          scope: "local" as const,
          projectPath: "/repo",
          installPath: "/c/market/gone/1.0.0",
          version: "1.0.0",
        },
      ],
      "kept@market": [
        { scope: "user" as const, installPath: "/c/market/kept/2.0.0", version: "2.0.0" },
      ],
    },
  };

  const pruned = removeInstalledEntries(registry, ["gone@market"]);

  assert.deepEqual(Object.keys(pruned.plugins), ["kept@market"]);
});

test("removeInstalledEntries leaves the registry untouched when the key is absent", () => {
  const registry = {
    version: 2 as const,
    plugins: {
      "kept@market": [
        { scope: "user" as const, installPath: "/c/market/kept/2.0.0", version: "2.0.0" },
      ],
    },
  };

  assert.deepEqual(removeInstalledEntries(registry, ["absent@market"]), registry);
});

test("readInstalledPlugins preserves unknown top-level keys claude may add", async () => {
  await withHome(async (home) => {
    writeRegistry(home, {
      version: 2,
      plugins: {},
      futureMeta: { source: "claude" },
    });
    const registry = await readInstalledPlugins(home);
    await writeInstalledPlugins(home, registry);
    const reread = JSON.parse(
      readFileSync(join(home, "plugins/installed_plugins.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(reread["futureMeta"], { source: "claude" }, "unknown key survives round-trip");
  });
});

test("writeInstalledPlugins round-trips through readInstalledPlugins", async () => {
  await withHome(async (home) => {
    const registry = {
      version: 2 as const,
      plugins: {
        "a@m": [{ scope: "user", installPath: "/c/a/1.0.0", version: "1.0.0" }],
      },
    };
    await writeInstalledPlugins(home, registry);
    const reread = await readInstalledPlugins(home);
    assert.deepEqual(reread, registry);
    assert.ok(
      readFileSync(join(home, "plugins/installed_plugins.json"), "utf8").endsWith("\n"),
      "registry file ends with a trailing newline",
    );
  });
});
