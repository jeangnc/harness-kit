import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { pathExists } from "../fs.js";
import { FQ_ID } from "../ids.js";
import type { LocalIds } from "../layout/index.js";
import { offsetToLineCol, parsePlaceholders, type Placeholder } from "../placeholders/index.js";

export interface OwningPlugin {
  readonly name: string;
  readonly dependencies: ReadonlySet<string>;
}

export type ReadmeViolationKind = "placeholder" | "link";

export interface ReadmeViolation {
  readonly kind: ReadmeViolationKind;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface ValidateReadmeOptions {
  readonly filePath: string;
  readonly localIds: LocalIds;
  readonly owner?: OwningPlugin;
}

const SENTINEL = "<!-- harness-kit:validate -->";
const LINK_PATTERN = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const ABSOLUTE_URL_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

export async function validateReadme(
  options: ValidateReadmeOptions,
): Promise<readonly ReadmeViolation[]> {
  const text = await readFile(options.filePath, "utf8");
  if (!text.includes(SENTINEL)) return [];

  const violations: ReadmeViolation[] = [];
  for (const v of validatePlaceholders(text, options)) violations.push(v);
  for (const v of await validateLinks(text, options.filePath)) violations.push(v);
  return violations;
}

function validatePlaceholders(
  text: string,
  options: ValidateReadmeOptions,
): readonly ReadmeViolation[] {
  const violations: ReadmeViolation[] = [];
  for (const token of parsePlaceholders(text)) {
    const message = placeholderViolation(token, options);
    if (!message) continue;
    const { line, column } = offsetToLineCol(text, token.start);
    violations.push({
      kind: "placeholder",
      file: options.filePath,
      line,
      column,
      message: `${token.raw}: ${message}`,
    });
  }
  return violations;
}

function placeholderViolation(token: Placeholder, options: ValidateReadmeOptions): string | null {
  const owner = options.owner ?? null;
  switch (token.prefix) {
    case "skill":
      return localIdViolation(token.value, "skill", options.localIds.skills, owner);
    case "command":
      return localIdViolation(token.value, "command", options.localIds.commands, owner);
    case "agent":
      return localIdViolation(token.value, "agent", options.localIds.agents, owner);
    case "ext":
      return formatViolation(token.value, "ext", "skill");
    case "ext-command":
      return formatViolation(token.value, "ext-command", "command");
    case "ext-agent":
      return formatViolation(token.value, "ext-agent", "agent");
    default:
      return null;
  }
}

function localIdViolation(
  value: string | null,
  kind: "skill" | "command" | "agent",
  haystack: ReadonlySet<string>,
  owner: OwningPlugin | null,
): string | null {
  if (value === null) return `expected \`{{${kind}:<plugin>:<${kind}>}}\``;
  if (!FQ_ID.test(value)) {
    return `${kind} id "${value}" must match <plugin>:<${kind}> (kebab-case)`;
  }
  if (!haystack.has(value)) return `unknown ${kind} id "${value}" — not a local ${kind}`;
  return crossPluginViolation(value, owner);
}

function formatViolation(
  value: string | null,
  prefix: "ext" | "ext-command" | "ext-agent",
  noun: "skill" | "command" | "agent",
): string | null {
  if (value === null) return `expected \`{{${prefix}:<plugin>:<${noun}>}}\``;
  if (!FQ_ID.test(value)) {
    return `${prefix} id "${value}" must match <plugin>:<${noun}> (kebab-case)`;
  }
  return null;
}

function crossPluginViolation(id: string, owner: OwningPlugin | null): string | null {
  if (!owner) return null;
  const idx = id.indexOf(":");
  if (idx === -1) return null;
  const otherPlugin = id.slice(0, idx);
  if (otherPlugin === owner.name) return null;
  if (owner.dependencies.has(otherPlugin)) return null;
  return `cross-plugin reference to "${otherPlugin}" requires "${otherPlugin}" in ${owner.name}'s dependencies`;
}

async function validateLinks(text: string, filePath: string): Promise<readonly ReadmeViolation[]> {
  const dir = dirname(filePath);
  const violations: ReadmeViolation[] = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    const url = match[1];
    if (!url) continue;
    if (ABSOLUTE_URL_PATTERN.test(url)) continue;
    const pathPart = stripAnchor(url);
    if (!pathPart) continue;
    const target = resolve(dir, pathPart);
    if (await pathExists(target)) continue;
    const { line, column } = offsetToLineCol(text, match.index);
    violations.push({
      kind: "link",
      file: filePath,
      line,
      column,
      message: `broken link: ${url}`,
    });
  }
  return violations;
}

function stripAnchor(url: string): string {
  const hashIdx = url.indexOf("#");
  if (hashIdx === -1) return url;
  return url.slice(0, hashIdx);
}
