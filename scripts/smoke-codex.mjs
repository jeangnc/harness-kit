import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { makeCodexVendor } from "../dist/vendors/codex/index.js";
import { defaultRunner } from "../dist/install/runner.js";
const root = await realpath(await mkdtemp(join(tmpdir(), "harness-native-smoke-")));
const home = join(root, "home");
const distRoot = join(root, "dist");
const plugin = join(distRoot, "codex/plugins/foo");
await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
await mkdir(join(distRoot, "codex/.claude-plugin"), { recursive: true });
await mkdir(home, { recursive: true });
await writeFile(
  join(home, "config.toml"),
  'model_verbosity = "low"\n[plugins]\n"foo@foo-market".enabled = true\n',
);
await writeFile(
  join(plugin, ".codex-plugin/plugin.json"),
  JSON.stringify({ name: "foo", version: "2.0.0", description: "foo" }),
);
await writeFile(
  join(distRoot, "codex/.claude-plugin/marketplace.json"),
  JSON.stringify({
    name: "foo-market",
    owner: { name: "foo" },
    plugins: [{ name: "foo", source: "./plugins/foo" }],
  }),
);
const vendor = makeCodexVendor(home);
const ctx = {
  distRoot,
  marketplace: "foo-market",
  plugins: [{ name: "foo", version: "2.0.0", path: plugin }],
  mode: "local",
  run: defaultRunner,
  log: console.log,
};
await vendor.install(ctx);
assert.equal((await vendor.installedVersions(ctx)).get("foo"), "2.0.0");
assert.match(await readFile(join(home, "config.toml"), "utf8"), /model_verbosity = "low"/);
const project = join(root, "project");
await mkdir(join(project, ".git"), { recursive: true });
await mkdir(join(project, ".codex"), { recursive: true });
await writeFile(
  join(project, ".codex/config.toml"),
  '[plugins]\n"foo@foo-market".enabled = true\n',
);
const current = await readFile(join(home, "config.toml"), "utf8");
await writeFile(
  join(home, "config.toml"),
  current.replace("enabled = true", "enabled = false") +
    "\n[projects." +
    JSON.stringify(project) +
    ']\ntrust_level = "trusted"\n',
);
process.chdir(project);
const effective = JSON.parse(
  await defaultRunner(
    "codex",
    ["plugin", "list", "--marketplace", "foo-market", "--available", "--json"],
    { env: { CODEX_HOME: home }, cwd: project },
  ),
);
assert.equal(effective.installed[0].enabled, true);
await assert.rejects(
  vendor.refresh({ ...ctx, plugins: [{ name: "foo", version: "3.0.0", path: plugin }] }),
  /disabled plugin foo/,
);
assert.match(await readFile(join(home, "config.toml"), "utf8"), /enabled = false/);
console.log("PASS conflicting project/global selection remains globally disabled");
await vendor.uninstall(ctx);
assert.equal(await vendor.isInstalled(ctx), false);
console.log("PASS native install/list/uninstall, isolated home, user setting preserved", root);
