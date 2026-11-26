import { vendor as claudeVendor } from "../vendors/claude/index.js";
import { vendor as codexVendor } from "../vendors/codex/index.js";
import type { Vendor } from "./schema.js";

export function builtinVendors(): readonly Vendor[] {
  return [claudeVendor, codexVendor];
}

export function overlayVendorNames(selected: readonly Vendor[]): readonly string[] {
  return [...new Set([...builtinVendors(), ...selected].map((vendor) => vendor.name))];
}
