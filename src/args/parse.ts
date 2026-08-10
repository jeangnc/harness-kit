import { TIERS, type Tier } from "../eval/schema.js";

export function commaSeparated(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseTier(value: string): Tier {
  if ((TIERS as readonly string[]).includes(value)) return value as Tier;
  throw new Error(`Unknown tier "${value}". Valid: ${TIERS.join(", ")}`);
}

export function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}
