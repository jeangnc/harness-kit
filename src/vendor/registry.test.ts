import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { resolveVendors } from "./registry.js";
import type { Vendor } from "./schema.js";

const fakeVendor = (name: string): Vendor => ({
  name,
  home: `/tmp/.${name}`,
  pluginManifestPath: `.${name}-plugin/plugin.json`,
  marketplaceManifestPath: `${name}/.${name}-plugin/marketplace.json`,
  vendorOutDir: (outRoot) => join(outRoot, name),
  pluginOutDir: (outRoot, pluginName) => join(outRoot, name, pluginName),
  emitPluginManifest: async () => undefined,
  emitMarketplaceManifest: async () => undefined,
  install: async () => undefined,
  uninstall: async () => undefined,
});

test("resolveVendors returns vendors in declared order when all names are known", () => {
  const alpha = fakeVendor("alpha");
  const beta = fakeVendor("beta");
  const result = resolveVendors(["beta", "alpha"], [alpha, beta]);
  assert.deepEqual(
    result.map((v) => v.name),
    ["beta", "alpha"],
  );
});

test("resolveVendors throws on unknown vendor name", () => {
  const alpha = fakeVendor("alpha");
  assert.throws(
    () => resolveVendors(["alpha", "gamma"], [alpha]),
    /unknown vendor "gamma".*known: alpha/i,
  );
});

test("resolveVendors throws when no vendors declared", () => {
  const alpha = fakeVendor("alpha");
  assert.throws(() => resolveVendors([], [alpha]), /at least one vendor/i);
});

test("resolveVendors throws on duplicate declaration", () => {
  const alpha = fakeVendor("alpha");
  assert.throws(() => resolveVendors(["alpha", "alpha"], [alpha]), /duplicate vendor "alpha"/i);
});
