import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { parsePlaceholders } from "../placeholders/index.js";
import { err, ok, type Result } from "../result.js";

export type IncludeError =
  | { readonly tag: "include-cycle"; readonly chain: readonly string[] }
  | { readonly tag: "include-missing"; readonly path: string; readonly from: string }
  | { readonly tag: "include-escapes-skill"; readonly path: string; readonly skillDir: string }
  | { readonly tag: "include-not-md"; readonly path: string }
  | { readonly tag: "include-absolute"; readonly raw: string }
  | { readonly tag: "include-empty"; readonly raw: string };

export interface ExpandedBody {
  readonly body: string;
  readonly resolvedIncludes: ReadonlySet<string>;
}

export async function expandIncludes(
  body: string,
  fromFile: string,
  skillDir: string,
): Promise<Result<ExpandedBody, readonly IncludeError[]>> {
  const errors: IncludeError[] = [];
  const resolved = new Set<string>();
  const expanded = await expand(body, fromFile, skillDir, [resolve(fromFile)], errors, resolved);
  if (errors.length > 0) return err(errors);
  return ok({ body: expanded, resolvedIncludes: resolved });
}

export function formatIncludeError(error: IncludeError): string {
  switch (error.tag) {
    case "include-cycle":
      return `include cycle: ${error.chain.join(" → ")}`;
    case "include-missing":
      return `include target not found: ${error.path} (from ${error.from})`;
    case "include-escapes-skill":
      return `include path "${error.path}" escapes the skill directory ${error.skillDir}`;
    case "include-not-md":
      return `include only supports .md files (got ${error.path})`;
    case "include-absolute":
      return `include path must be relative (got ${error.raw})`;
    case "include-empty":
      return `expected {{include:<relative-path>.md}} (got ${error.raw})`;
  }
}

async function expand(
  body: string,
  fromFile: string,
  skillDir: string,
  chain: readonly string[],
  errors: IncludeError[],
  resolved: Set<string>,
): Promise<string> {
  const tokens = parsePlaceholders(body).filter((t) => t.prefix === "include");
  if (tokens.length === 0) return body;

  let out = "";
  let cursor = 0;
  for (const token of tokens) {
    out += body.slice(cursor, token.start);
    cursor = token.end;

    if (token.value === null) {
      errors.push({ tag: "include-empty", raw: token.raw });
      out += token.raw;
      continue;
    }
    const rel = token.value.trim();
    if (isAbsolute(rel)) {
      errors.push({ tag: "include-absolute", raw: token.raw });
      out += token.raw;
      continue;
    }
    if (!rel.endsWith(".md")) {
      errors.push({ tag: "include-not-md", path: rel });
      out += token.raw;
      continue;
    }
    const target = resolve(dirname(fromFile), rel);
    const fromSkill = relative(skillDir, target);
    if (fromSkill.startsWith("..") || isAbsolute(fromSkill)) {
      errors.push({ tag: "include-escapes-skill", path: rel, skillDir });
      out += token.raw;
      continue;
    }
    if (chain.includes(target)) {
      errors.push({ tag: "include-cycle", chain: [...chain, target] });
      out += token.raw;
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch {
      errors.push({ tag: "include-missing", path: rel, from: fromFile });
      out += token.raw;
      continue;
    }
    resolved.add(target);
    const expanded = await expand(raw, target, skillDir, [...chain, target], errors, resolved);
    out += expanded.endsWith("\n") ? expanded.slice(0, -1) : expanded;
  }
  out += body.slice(cursor);
  return out;
}
