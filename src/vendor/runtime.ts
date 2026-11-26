import { join } from "node:path";

import type { Vendor } from "./schema.js";

export function preservedRuntimeFiles(vendor: Vendor): readonly string[] {
  const layout = vendor.runtimeLayout;
  if (layout.kind !== "home") return [];
  return layout.preservedFiles.map((file) => join(vendor.home, file));
}
