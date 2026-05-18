import { claudeVendor } from "../vendors/claude/index.js";
import { codexVendor } from "../vendors/codex/index.js";
import type { Vendor } from "./schema.js";

export function builtinVendors(): readonly Vendor[] {
  return [claudeVendor, codexVendor];
}
