const PASSTHROUGH_DOTFILES: ReadonlySet<string> = new Set([".mcp.json"]);

const RELATIVE_NAV: ReadonlySet<string> = new Set([".", ".."]);

export function emitsEntry(name: string): boolean {
  return !name.startsWith(".") || RELATIVE_NAV.has(name) || PASSTHROUGH_DOTFILES.has(name);
}

export function unemittedSegment(path: string): string | undefined {
  return path.split("/").find((segment) => !emitsEntry(segment));
}
