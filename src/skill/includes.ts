import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parsePlaceholders } from "../placeholders/index.js";
import { err, ok, type Result } from "../result.js";

export type IncludeError =
  | { readonly tag: "include-cycle"; readonly chain: readonly string[] }
  | { readonly tag: "include-missing"; readonly path: string; readonly from: string }
  | { readonly tag: "include-unknown-root"; readonly raw: string; readonly name: string }
  | { readonly tag: "include-anchor-without-path"; readonly raw: string; readonly name: string }
  | { readonly tag: "include-empty"; readonly raw: string };

export interface IncludeRoots {
  readonly repoRoot: string;
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
    case "include-unknown-root":
      return `include references unknown root "@${error.name}" in ${error.raw}`;
    case "include-anchor-without-path": {
      const example = error.name === "#" ? "#<file>" : `${error.name}/<file>`;
      return `include "${error.name}" is missing a path (expected ${example}) in ${error.raw}`;
    }
    case "include-empty":
      return `expected {{include:<relative-path>}} (got ${error.raw})`;
  }
}

type Resolution =
  | { readonly kind: "target"; readonly target: string }
  | { readonly kind: "unknown-root"; readonly name: string }
  | { readonly kind: "anchor-without-path"; readonly name: string };

function resolveTarget(rel: string, fromFile: string, roots: IncludeRoots): Resolution {
  if (rel.startsWith("#")) {
    const sub = rel.slice(1).replace(/^\//, "");
    if (sub === "") return { kind: "anchor-without-path", name: "#" };
    return { kind: "target", target: resolve(roots.repoRoot, sub) };
  }
  if (rel.startsWith("@")) {
    const slash = rel.indexOf("/");
    const [name, sub] =
      slash === -1 ? [rel.slice(1), ""] : [rel.slice(1, slash), rel.slice(slash + 1)];
    const root = roots.named[name];
    if (root === undefined) return { kind: "unknown-root", name };
    if (sub === "") return { kind: "anchor-without-path", name: `@${name}` };
    return { kind: "target", target: resolve(root, sub) };
  }
  return { kind: "target", target: resolve(dirname(fromFile), rel) };
}

interface ResolvedInclude {
  readonly target: string;
  readonly rel: string;
}

function resolveInclude(
  token: { readonly value: string | null; readonly raw: string },
  fromFile: string,
  roots: IncludeRoots,
): Result<ResolvedInclude, IncludeError> {
  if (token.value === null) {
    return err({ tag: "include-empty", raw: token.raw });
  }
  const rel = token.value.trim();
  const resolution = resolveTarget(rel, fromFile, roots);
  if (resolution.kind === "unknown-root") {
    return err({ tag: "include-unknown-root", raw: token.raw, name: resolution.name });
  }
  if (resolution.kind === "anchor-without-path") {
    return err({ tag: "include-anchor-without-path", raw: token.raw, name: resolution.name });
  }
  return ok({ target: resolution.target, rel });
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

  let out = "";
  let cursor = 0;
  for (const token of tokens) {
    out += body.slice(cursor, token.start);
    cursor = token.end;

    const resolution = resolveInclude(token, fromFile, roots);
    if (!resolution.ok) {
      errors.push(resolution.error);
      out += token.raw;
      continue;
    }
    const { target, rel } = resolution.value;
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
