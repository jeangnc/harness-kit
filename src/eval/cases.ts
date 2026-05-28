import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import yaml from "js-yaml";

import { formatZodIssues } from "../errors/zod.js";
import { err, ok, type Result } from "../result.js";
import {
  CaseFileSchema,
  expectedSkills,
  type CaseFile,
  type EvalCase,
  type Tier,
} from "./schema.js";

export interface LoadedCase extends EvalCase {
  readonly suite: string;
  readonly tier: Tier;
  readonly file: string;
}

export interface CaseLoadError {
  readonly file: string;
  readonly message: string;
}

export async function loadCases(casesDir: string): Promise<Result<LoadedCase[], CaseLoadError[]>> {
  const files = await collectYamlFiles(casesDir);
  const loaded: LoadedCase[] = [];
  const errors: CaseLoadError[] = [];
  const seenIds = new Set<string>();

  for (const file of files) {
    const parsed = await parseFile(file);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    for (const evalCase of parsed.value.cases) {
      if (seenIds.has(evalCase.id)) {
        errors.push({ file, message: `duplicate case id "${evalCase.id}"` });
        continue;
      }
      seenIds.add(evalCase.id);
      loaded.push({ ...evalCase, suite: parsed.value.suite, tier: parsed.value.tier, file });
    }
  }

  return errors.length > 0 ? err(errors) : ok(loaded);
}

export function unresolvedSkills(
  cases: readonly LoadedCase[],
  installedIds: ReadonlySet<string>,
): CaseLoadError[] {
  const errors: CaseLoadError[] = [];
  for (const evalCase of cases) {
    for (const id of expectedSkills(evalCase.expect)) {
      if (!installedIds.has(id)) {
        errors.push({
          file: evalCase.file,
          message: `case "${evalCase.id}" expects skill "${id}", which is not installed`,
        });
      }
    }
  }
  return errors;
}

async function parseFile(file: string): Promise<Result<CaseFile, CaseLoadError>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (cause) {
    return err({ file, message: `cannot read file: ${(cause as Error).message}` });
  }
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (cause) {
    return err({ file, message: `invalid YAML: ${(cause as Error).message}` });
  }
  const result = CaseFileSchema.safeParse(doc);
  if (!result.success) {
    return err({ file, message: formatZodIssues(result.error).join("; ") });
  }
  return ok(result.data);
}

async function collectYamlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectYamlFiles(full)));
    } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      files.push(full);
    }
  }
  return files.sort();
}
