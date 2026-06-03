import { dirname, relative, resolve } from "node:path";

import { pathExists } from "../fs.js";
import { unemittedSegment } from "../compile/emit-paths.js";
import { parsePlaceholders } from "../placeholders/index.js";

import { REFERENCE_PREFIXES, type ReferencePrefix } from "./kinds.js";

export type BypassHaystacks = Readonly<Record<ReferencePrefix, ReadonlySet<string>>>;

export interface Bypass {
  readonly prefix: ReferencePrefix;
  readonly id: string;
  readonly offset: number;
}

interface RawReference {
  readonly id: string;
  readonly offset: number;
  readonly kinds: readonly ReferencePrefix[];
}

interface SigilPattern {
  readonly pattern: RegExp;
  readonly kinds: readonly ReferencePrefix[];
}

const SIGIL_PATTERNS: readonly SigilPattern[] = [
  { pattern: /(?<![\w/])\/([a-z0-9-]+:[a-z0-9-]+)/g, kinds: ["command"] },
  { pattern: /(?<![\w@])@([a-z0-9-]+:[a-z0-9-]+)/g, kinds: ["agent"] },
  { pattern: /(?<![\w:/@-])([a-z0-9-]+:[a-z0-9-]+)(?![\w:-])/g, kinds: REFERENCE_PREFIXES },
];

export function detectBypasses(body: string, haystacks: BypassHaystacks): readonly Bypass[] {
  const spans = placeholderSpans(body);
  const bypasses: Bypass[] = [];
  for (const ref of rawReferences(body)) {
    if (within(ref.offset, spans)) continue;
    for (const prefix of ref.kinds) {
      if (haystacks[prefix].has(ref.id)) {
        bypasses.push({ prefix, id: ref.id, offset: ref.offset });
      }
    }
  }
  return bypasses;
}

function rawReferences(body: string): readonly RawReference[] {
  return SIGIL_PATTERNS.flatMap(({ pattern, kinds }) =>
    [...body.matchAll(pattern)].flatMap((match) => {
      const id = match[1];
      return id === undefined ? [] : [{ id, offset: match.index, kinds }];
    }),
  );
}

export interface Span {
  readonly start: number;
  readonly end: number;
}

function placeholderSpans(body: string): readonly Span[] {
  return parsePlaceholders(body).map((token) => ({ start: token.start, end: token.end }));
}

function within(offset: number, spans: readonly Span[]): boolean {
  return spans.some((span) => offset >= span.start && offset < span.end);
}

export interface LeafHandle {
  readonly handle: string;
  readonly prefix: ReferencePrefix;
}

export type LeafIndex = ReadonlyMap<string, readonly LeafHandle[]>;

export function buildLeafIndex(haystacks: BypassHaystacks): LeafIndex {
  const index = new Map<string, LeafHandle[]>();
  for (const prefix of REFERENCE_PREFIXES) {
    for (const handle of haystacks[prefix]) {
      const leaf = handle.slice(handle.indexOf(":") + 1);
      const bucket = index.get(leaf) ?? [];
      bucket.push({ handle, prefix });
      index.set(leaf, bucket);
    }
  }
  return index;
}

export interface BarewordBypass {
  readonly leaf: string;
  readonly candidates: readonly LeafHandle[];
  readonly offset: number;
}

export interface BarewordContext {
  readonly ownLeaf: string | null;
}

const LANG_SKILL_LEAVES: ReadonlySet<string> = new Set([
  "ruby",
  "rails",
  "rspec",
  "typescript",
  "react",
]);

const BACKTICK_LEAF = /`([a-z][a-z0-9-]*)`/g;

export function nonReferenceSpans(body: string): readonly Span[] {
  return [...placeholderSpans(body), ...codeSpans(body)];
}

export function detectBarewordBypasses(
  body: string,
  index: LeafIndex,
  context: BarewordContext,
  skip: readonly Span[] = nonReferenceSpans(body),
): readonly BarewordBypass[] {
  const out: BarewordBypass[] = [];
  for (const match of body.matchAll(BACKTICK_LEAF)) {
    const leaf = match[1];
    if (leaf === undefined) continue;
    if (within(match.index, skip)) continue;
    if (LANG_SKILL_LEAVES.has(leaf)) continue;
    if (context.ownLeaf !== null && leaf === context.ownLeaf) continue;
    const candidates = index.get(leaf);
    if (candidates === undefined) continue;
    out.push({
      leaf,
      candidates: sortCandidates(candidates),
      offset: match.index,
    });
  }
  return out;
}

function sortCandidates(candidates: readonly LeafHandle[]): readonly LeafHandle[] {
  return [...candidates].sort(
    (a, b) => a.prefix.localeCompare(b.prefix) || a.handle.localeCompare(b.handle),
  );
}

export interface RefBypass {
  readonly path: string;
  readonly suggestion: string;
  readonly offset: number;
}

const BACKTICK_MD = /`([a-z0-9][a-z0-9.-]*\.md)`/gi;

export async function detectRefBypasses(
  body: string,
  sourceDir: string,
  rootDir: string,
  skip: readonly Span[] = nonReferenceSpans(body),
): Promise<readonly RefBypass[]> {
  const out: RefBypass[] = [];
  for (const match of body.matchAll(BACKTICK_MD)) {
    const path = match[1];
    if (path === undefined) continue;
    if (within(match.index, skip)) continue;
    const [suggestion, ...rest] = await reachableTargets(path, sourceDir, rootDir);
    if (suggestion === undefined || rest.length > 0) continue;
    out.push({ path, suggestion, offset: match.index });
  }
  return out;
}

async function reachableTargets(
  filename: string,
  sourceDir: string,
  rootDir: string,
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const dir of [sourceDir, ...ancestorDirs(sourceDir, rootDir)]) {
    const candidate = resolve(dir, filename);
    if (!(await pathExists(candidate))) continue;
    const rel = relative(sourceDir, candidate);
    if (unemittedSegment(rel) === undefined) found.push(rel);
  }
  return found;
}

function ancestorDirs(sourceDir: string, rootDir: string): readonly string[] {
  const dirs: string[] = [];
  let dir = dirname(sourceDir);
  let prev = sourceDir;
  while (dir !== prev && dir.startsWith(rootDir)) {
    dirs.push(dir);
    prev = dir;
    dir = dirname(dir);
  }
  return dirs;
}

const FENCE = /^[ \t]*(`{3,}|~{3,})/;

function codeSpans(body: string): readonly Span[] {
  const spans: Span[] = [];
  let fenceStart: number | null = null;
  let offset = 0;
  for (const line of body.split("\n")) {
    const lineEnd = Math.min(offset + line.length + 1, body.length);
    if (FENCE.test(line)) {
      if (fenceStart === null) {
        fenceStart = offset;
      } else {
        spans.push({ start: fenceStart, end: lineEnd });
        fenceStart = null;
      }
    }
    offset = lineEnd;
  }
  if (fenceStart !== null) spans.push({ start: fenceStart, end: body.length });
  return spans;
}
