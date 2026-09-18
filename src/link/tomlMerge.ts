import { parse, stringify } from "smol-toml";

type Table = Record<string, unknown>;

export type KeyPath = readonly string[];

export interface TomlMergeInput {
  readonly current: string;
  readonly owned: string;
  readonly previouslyOwned: readonly KeyPath[];
}

export interface TomlMerge {
  readonly text: string;
  readonly owned: readonly KeyPath[];
  readonly overwritten: readonly KeyPath[];
}

export function mergeOwnedToml(input: TomlMergeInput): TomlMerge {
  const owned = parse(input.owned);
  const ownedPaths = leafPaths(owned);
  const ownedKeys = new Set(ownedPaths.map(formatKeyPath));
  const released = input.previouslyOwned.filter((path) => !ownedKeys.has(formatKeyPath(path)));
  const current = released.reduce(withoutPath, parse(input.current));
  const overwritten = ownedPaths.filter((path) => {
    const before = valueAt(current, path);
    return before !== undefined && !sameValue(before, valueAt(owned, path));
  });
  const merged = ownedPaths.reduce(
    (table, path) => withValue(table, path, valueAt(owned, path)),
    current,
  );
  return { text: stringify(merged), owned: ownedPaths, overwritten };
}

export function formatKeyPath(path: KeyPath): string {
  return path.map((key) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key))).join(".");
}

function leafPaths(table: Table, prefix: KeyPath = []): readonly KeyPath[] {
  return Object.entries(table).flatMap(([key, value]) => {
    const path = [...prefix, key];
    return isTable(value) ? leafPaths(value, path) : [path];
  });
}

function valueAt(table: Table, path: KeyPath): unknown {
  return path.reduce<unknown>((node, key) => (isTable(node) ? node[key] : undefined), table);
}

function withValue(table: Table, path: KeyPath, value: unknown): Table {
  const [head, ...rest] = path;
  if (head === undefined) return table;
  const child = table[head];
  return {
    ...table,
    [head]: rest.length === 0 ? value : withValue(isTable(child) ? child : {}, rest, value),
  };
}

function withoutPath(table: Table, path: KeyPath): Table {
  const [head, ...rest] = path;
  if (head === undefined || !(head in table)) return table;
  const { [head]: child, ...others } = table;
  if (rest.length === 0 || !isTable(child)) return rest.length === 0 ? others : table;
  const pruned = withoutPath(child, rest);
  return Object.keys(pruned).length === 0 ? others : { ...others, [head]: pruned };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isTable(value: unknown): value is Table {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}
