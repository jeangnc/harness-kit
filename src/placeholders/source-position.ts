export interface LineCol {
  readonly line: number;
  readonly column: number;
}

const NEWLINE = 10;

export function offsetToLineCol(text: string, offset: number): LineCol {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastLineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (text.charCodeAt(i) === NEWLINE) {
      line += 1;
      lastLineStart = i + 1;
    }
  }
  return { line, column: clamped - lastLineStart + 1 };
}
