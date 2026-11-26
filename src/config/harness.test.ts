import { test } from "node:test";
import { deepEqual, equal, rejects } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadHarnessConfig, resolveRoots } from "./harness.js";

async function withSandbox(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "harness-yaml-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadHarnessConfig parses a valid harness.yaml", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: my-market\nowner: { name: t }\nvendors: { claude: { ref: harness/claude }, codex: { ref: harness/codex } }\n",
    );
    const cfg = await loadHarnessConfig(dir);
    equal(cfg.marketplace, "my-market");
    deepEqual(cfg.vendors, [
      { name: "claude", ref: "harness/claude", catalog: {} },
      { name: "codex", ref: "harness/codex", catalog: {} },
    ]);
  });
});

test("loadHarnessConfig prefers harness.yml when harness.yaml absent", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yml"),
      "marketplace: m\nowner: { name: t }\nvendors: { claude: { ref: harness/claude } }\n",
    );
    const cfg = await loadHarnessConfig(dir);
    equal(cfg.marketplace, "m");
    deepEqual(
      cfg.vendors.map((v) => v.name),
      ["claude"],
    );
  });
});

test("loadHarnessConfig throws when both harness.yaml and harness.yml exist", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: a\nowner: { name: t }\nvendors: { claude: { ref: harness/claude } }\n",
    );
    writeFileSync(
      join(dir, "harness.yml"),
      "marketplace: b\nowner: { name: t }\nvendors: { codex: { ref: harness/codex } }\n",
    );
    await rejects(async () => loadHarnessConfig(dir), /both harness\.yaml and harness\.yml/i);
  });
});

test("loadHarnessConfig throws when no harness file present", async () => {
  await withSandbox(async (dir) => {
    mkdirSync(join(dir, "src"));
    await rejects(async () => loadHarnessConfig(dir), /harness\.yaml not found/i);
  });
});

test("loadHarnessConfig throws when marketplace is missing", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(join(dir, "harness.yaml"), "vendors: { claude: { ref: harness/claude } }\n");
    await rejects(async () => loadHarnessConfig(dir), /marketplace/);
  });
});

test("loadHarnessConfig throws when vendors is empty", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(join(dir, "harness.yaml"), "marketplace: m\nowner: { name: t }\nvendors: {}\n");
    await rejects(async () => loadHarnessConfig(dir), /at least one vendor/i);
  });
});

test("loadHarnessConfig throws when vendors is a list", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nowner: { name: t }\nvendors: [claude]\n",
    );
    await rejects(async () => loadHarnessConfig(dir), /vendors is a map since 2\.0/);
  });
});

test("loadHarnessConfig throws when a vendor declares no ref", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nowner: { name: t }\nvendors: { claude: {} }\n",
    );
    await rejects(async () => loadHarnessConfig(dir), /vendors\.claude\.ref/);
  });
});

test("loadHarnessConfig throws when a ref is not a git branch name", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nowner: { name: t }\nvendors: { claude: { ref: 'a..b' } }\n",
    );
    await rejects(async () => loadHarnessConfig(dir), /git branch name/);
  });
});

for (const ref of ["HEAD", "harness/claude.", "a/.b", "-a", "a.lock/b"]) {
  test(`loadHarnessConfig rejects the ref ${ref}, which git refuses as a branch`, async () => {
    await withSandbox(async (dir) => {
      writeFileSync(
        join(dir, "harness.yaml"),
        `marketplace: m\nowner: { name: t }\nvendors: { claude: { ref: '${ref}' } }\n`,
      );
      await rejects(async () => loadHarnessConfig(dir), /git branch name/);
    });
  });
}

test("loadHarnessConfig throws when two vendors share a ref", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nowner: { name: t }\nvendors: { claude: { ref: out }, codex: { ref: out } }\n",
    );
    await rejects(async () => loadHarnessConfig(dir), /refs "out" and "out" collide/);
  });
});

test("loadHarnessConfig throws when one ref is a folder of another", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nowner: { name: t }\nvendors: { claude: { ref: out }, codex: { ref: out/codex } }\n",
    );
    await rejects(async () => loadHarnessConfig(dir), /refs "out" and "out\/codex" collide/);
  });
});

test("loadHarnessConfig reads each vendor's catalog fields", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nowner: { name: t }\nvendors:\n  claude:\n    ref: harness/claude\n    catalog: { homepage: https://example.com }\n",
    );
    const cfg = await loadHarnessConfig(dir);
    deepEqual(cfg.vendors[0]?.catalog, { homepage: "https://example.com" });
  });
});

test("loadHarnessConfig rejects the top-level extensions key", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nowner: { name: t }\nvendors: { claude: { ref: harness/claude } }\nextensions: {}\n",
    );
    await rejects(async () => loadHarnessConfig(dir), /moved to vendors\.<vendor>\.catalog/);
  });
});

test("loadHarnessConfig throws on malformed YAML", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nowner: { name: t }\n  bad indent: x\n",
    );
    await rejects(async () => loadHarnessConfig(dir), /harness\.yaml/i);
  });
});

test("loadHarnessConfig parses an optional roots map", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nowner: { name: t }\nvendors: { claude: { ref: harness/claude } }\nroots:\n  shared: ./src/shared\n",
    );
    const cfg = await loadHarnessConfig(dir);
    deepEqual(cfg.roots, { shared: "./src/shared" });
  });
});

test("loadHarnessConfig leaves roots undefined when absent", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nowner: { name: t }\nvendors: { claude: { ref: harness/claude } }\n",
    );
    const cfg = await loadHarnessConfig(dir);
    equal(cfg.roots, undefined);
  });
});

test("loadHarnessConfig rejects an empty roots value", async () => {
  await withSandbox(async (dir) => {
    writeFileSync(
      join(dir, "harness.yaml"),
      "marketplace: m\nowner: { name: t }\nvendors: { claude: { ref: harness/claude } }\nroots:\n  shared: ''\n",
    );
    await rejects(async () => loadHarnessConfig(dir), /roots/);
  });
});

test("resolveRoots returns an empty map when nothing is declared", () => {
  deepEqual(resolveRoots("/repo", undefined), {});
});

test("resolveRoots resolves declared paths against the repo root", () => {
  deepEqual(resolveRoots("/repo", { shared: "./src/shared" }), {
    shared: "/repo/src/shared",
  });
});
