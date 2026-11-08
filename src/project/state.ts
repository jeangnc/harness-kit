import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { assertRegular, readJson } from "./io.js";
import type { ProjectLocation } from "./location.js";

const MarketplaceSchema = z.object({ name: z.string().min(1), path: z.string().min(1) });
const MetadataSchema = z.object({
  version: z.literal(1),
  project: z.string(),
  preset: z.string().min(1),
  marketplaces: z.array(MarketplaceSchema),
});

export function readMetadata(
  location: ProjectLocation,
): z.infer<typeof MetadataSchema> | undefined {
  assertRegular(location.home, "directory");
  const path = join(location.home, "project.json");
  assertRegular(path, "file");
  if (!existsSync(path)) return undefined;
  const result = MetadataSchema.safeParse(readJson(path));
  if (!result.success || result.data.project !== location.project) {
    throw new Error(`Project home identity conflicts at ${location.home}`);
  }
  return result.data;
}

export function requireReady(location: ProjectLocation): void {
  const metadata = readMetadata(location);
  const ready = join(location.home, "ready");
  assertRegular(ready, "file");
  if (!metadata || !existsSync(ready)) {
    throw new Error(`Project home is not ready; run project setup for ${location.project}`);
  }
}
