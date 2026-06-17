import type { AnswerDelimiter } from "../schema.js";

export type Extraction =
  | { readonly found: true; readonly text: string }
  | { readonly found: false };

export function extractAnswer(answer: AnswerDelimiter | undefined, raw: string): Extraction {
  if (answer === undefined) return { found: true, text: raw };

  const startIdx = raw.indexOf(answer.start);
  if (startIdx === -1) return { found: false };

  const searchFrom = startIdx + answer.start.length;
  const closeIdx = raw.indexOf(answer.end, searchFrom);
  const stop = closeIdx === -1 ? raw.length : closeIdx + answer.end.length;
  return { found: true, text: raw.slice(startIdx, stop) };
}
