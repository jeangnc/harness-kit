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

interface Span {
  readonly start: number;
  readonly end: number;
}

function placeholderSpans(body: string): readonly Span[] {
  return parsePlaceholders(body).map((token) => ({ start: token.start, end: token.end }));
}

function within(offset: number, spans: readonly Span[]): boolean {
  return spans.some((span) => offset >= span.start && offset < span.end);
}
