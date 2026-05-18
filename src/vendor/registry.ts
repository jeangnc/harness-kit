import { loadHarnessConfig } from "../config/harness.js";
import { builtinVendors } from "./builtins.js";
import type { Vendor } from "./schema.js";

export async function resolveVendorsForRepo(repoRoot: string): Promise<readonly Vendor[]> {
  const config = await loadHarnessConfig(repoRoot);
  return resolveVendors(config.vendors, builtinVendors());
}

export function resolveVendors(
  declared: readonly string[],
  available: readonly Vendor[],
): readonly Vendor[] {
  if (declared.length === 0) {
    throw new Error("harness.yaml must declare at least one vendor");
  }
  const seen = new Set<string>();
  for (const name of declared) {
    if (seen.has(name)) throw new Error(`duplicate vendor "${name}" in harness.yaml`);
    seen.add(name);
  }
  const byName = new Map(available.map((v) => [v.name, v]));
  const known = available.map((v) => v.name).join(", ");
  return declared.map((name) => {
    const vendor = byName.get(name);
    if (!vendor) throw new Error(`unknown vendor "${name}" — known: ${known}`);
    return vendor;
  });
}
