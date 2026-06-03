import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { parsePlaceholders } from "../placeholders/index.js";
import { err, ok, type Result } from "../result.js";

export type IncludeError =
  | { readonly tag: "include-cycle"; readonly chain: readonly string[] }
  | { readonly tag: "include-missing"; readonly path: string; readonly from: string }
  | {
      readonly tag: "include-escapes-roots";
      readonly path: string;
      readonly roots: readonly string[];
    }
  | { readonly tag: "include-unknown-root"; readonly raw: string; readonly name: string }
  | { readonly tag: "include-not-md"; readonly path: string }
  | { readonly tag: "include-absolute"; readonly raw: string }
  | { readonly tag: "include-empty"; readonly raw: string };

export interface IncludeRoots {
  readonly self: string;
  readonly named: Readonly<Record<string, string>>;
}

export interface ExpandedBody {
  readonly body: string;
  readonly resolvedIncludes: ReadonlySet<string>;
}

export async function expandIncludes(
  body: string,
  fromFile: string,
  roots: IncludeRoots,
): Promise<Result<ExpandedBody, readonly IncludeError[]>> {
  const errors: IncludeError[] = [];
  const resolved = new Set<string>();
  const expanded = await expand(body, fromFile, roots, [resolve(fromFile)], errors, resolved);
  if (errors.length > 0) return err(errors);
  return ok({ body: expanded, resolvedIncludes: resolved });
}

export function formatIncludeError(error: IncludeError): string {
  switch (error.tag) {
    case "include-cycle":
      return `include cycle: ${error.chain.join(" → ")}`;
    case "include-missing":
      return `include target not found: ${error.path} (from ${error.from})`;
    case "include-escapes-roots":
      return `include path "${error.path}" escapes all allowed roots (${error.roots.join(", ")})`;
    case "include-unknown-root":
      return `include references unknown root "@${error.name}" in ${error.raw}`;
    case "include-not-md":
      return `include only supports .md files (got ${error.path})`;
    case "include-absolute":
      return `include path must be relative (got ${error.raw})`;
    case "include-empty":
      return `expected {{include:<relative-path>.md}} (got ${error.raw})`;
  }
}

interface Resolution {
  readonly target: string;
}

function resolveTarget(
  rel: string,
  fromFile: string,
  roots: IncludeRoots,
): Resolution | { readonly unknownRoot: string } {
  if (!rel.startsWith("@")) {
    return { target: resolve(dirname(fromFile), rel) };
  }
  const slash = rel.indexOf("/");
  const name = slash === -1 ? rel.slice(1) : rel.slice(1, slash);
  const sub = slash === -1 ? "" : rel.slice(slash + 1);
  const rootPath = roots.named[name];
  if (rootPath === undefined || sub === "") {
    return { unknownRoot: name };
  }
  return { target: resolve(rootPath, sub) };
}

function isInsideAnyRoot(target: string, allowed: readonly string[]): boolean {
  return allowed.some((root) => {
    const rel = relative(root, target);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

async function expand(
  body: string,
  fromFile: string,
  roots: IncludeRoots,
  chain: readonly string[],
  errors: IncludeError[],
  resolved: Set<string>,
): Promise<string> {
  const tokens = parsePlaceholders(body).filter((t) => t.prefix === "include");
  if (tokens.length === 0) return body;

  const allowed = [roots.self, ...Object.values(roots.named)];
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
    const resolution = resolveTarget(rel, fromFile, roots);
    if ("unknownRoot" in resolution) {
      errors.push({ tag: "include-unknown-root", raw: token.raw, name: resolution.unknownRoot });
      out += token.raw;
      continue;
    }
    const { target } = resolution;
    if (!isInsideAnyRoot(target, allowed)) {
      errors.push({ tag: "include-escapes-roots", path: rel, roots: allowed });
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
    const expanded = await expand(raw, target, roots, [...chain, target], errors, resolved);
    out += expanded.endsWith("\n") ? expanded.slice(0, -1) : expanded;
  }
  out += body.slice(cursor);
  return out;
}
