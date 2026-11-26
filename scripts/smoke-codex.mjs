import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { makeVendor } from "../dist/vendors/codex/index.js";
import { defaultRunner } from "../dist/install/runner.js";
const root = await realpath(await mkdtemp(join(tmpdir(), "harness-native-smoke-")));
const home = join(root, "home");
const distRoot = join(root, ".harness");
const plugin = join(distRoot, "codex/plugins/foo");
await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
await mkdir(join(distRoot, "codex/.agents/plugins"), { recursive: true });
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
  join(distRoot, "codex/.agents/plugins/marketplace.json"),
  JSON.stringify({
    name: "foo-market",
    interface: { displayName: "foo-market" },
    plugins: [
      {
        name: "foo",
        source: { source: "local", path: "./plugins/foo" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  }),
);
const vendor = makeVendor(home);
const ctx = {
  distRoot,
  marketplace: "foo-market",
  plugins: [{ name: "foo", version: "2.0.0", path: plugin }],
  source: { kind: "local" },
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
const logs = [];
await vendor.refresh({
  ...ctx,
  plugins: [{ name: "foo", version: "3.0.0", path: plugin }],
  log: (line) => logs.push(line),
});
assert.ok(logs.some((line) => line.includes("skipped disabled foo@2.0.0")));
assert.equal((await vendor.installedVersions(ctx)).get("foo"), "2.0.0");
assert.match(await readFile(join(home, "config.toml"), "utf8"), /enabled = false/);
console.log("PASS conflicting project/global selection remains globally disabled");
await vendor.uninstall(ctx);
assert.equal(await vendor.isInstalled(ctx), false);
console.log("PASS native install/list/uninstall, isolated home, user setting preserved", root);
