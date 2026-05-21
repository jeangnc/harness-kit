export interface Placeholder {
  readonly prefix: string;
  readonly value: string | null;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

export type ValidatorResult =
  | { ok: true; rendered: string; warnings?: readonly string[] }
  | { ok: false; error: string };

export type Validator = (value: string | null) => ValidatorResult;

export type ValidatorRegistry = Readonly<Record<string, Validator>>;

export type SubstituteResult =
  | { ok: true; rendered: string; warnings: readonly string[] }
  | { ok: false; errors: string[] };

const TOKEN_PATTERN = /\{\{([a-z][a-z0-9-]*)(?::([^{}\n]+?))?\}\}/g;

export function parsePlaceholders(body: string): Placeholder[] {
  const tokens: Placeholder[] = [];
  for (const match of body.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    const prefix = match[1];
    if (prefix === undefined) continue;
    const start = match.index;
    tokens.push({
      prefix,
      value: match[2] ?? null,
      raw,
      start,
      end: start + raw.length,
    });
  }
  return tokens;
}

export function substitute(body: string, registry: ValidatorRegistry): SubstituteResult {
  const tokens = parsePlaceholders(body);
  const errors: string[] = [];
  const warnings: string[] = [];
  const knownPrefixes = Object.keys(registry).sort().join(", ");

  let rendered = "";
  let cursor = 0;
  for (const token of tokens) {
    rendered += body.slice(cursor, token.start);
    const validator = registry[token.prefix];
    if (!validator) {
      errors.push(
        `unknown placeholder prefix "${token.prefix}" in ${token.raw} (valid: ${knownPrefixes})`,
      );
      rendered += token.raw;
      cursor = token.end;
      continue;
    }
    const result = validator(token.value);
    if (!result.ok) {
      errors.push(`${token.raw}: ${result.error}`);
      rendered += token.raw;
    } else {
      rendered += result.rendered;
      for (const warning of result.warnings ?? []) {
        warnings.push(`${token.raw}: ${warning}`);
      }
    }
    cursor = token.end;
  }
  rendered += body.slice(cursor);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rendered, warnings };
}
