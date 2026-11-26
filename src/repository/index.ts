import { tryGit } from "../git/index.js";
import { err, ok, type Result } from "../result.js";

export interface Repository {
  readonly owner: string;
  readonly name: string;
  readonly slug: string;
}

export type RepositoryError =
  | { readonly kind: "no-origin"; readonly cwd: string }
  | { readonly kind: "unrecognized-remote"; readonly url: string }
  | { readonly kind: "invalid-github-repository"; readonly value: string };

export interface RepositoryLookup {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9._-]+$/;
const REMOTE_PATTERNS: readonly RegExp[] = [
  /^git@github\.com:(?<slug>[^/]+\/[^/]+?)(?:\.git)?\/?$/,
  /^https:\/\/(?:[^@/]+@)?github\.com\/(?<slug>[^/]+\/[^/]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/git@github\.com\/(?<slug>[^/]+\/[^/]+?)(?:\.git)?\/?$/,
];

export function formatRepositoryError(e: RepositoryError): string {
  switch (e.kind) {
    case "no-origin":
      return `could not read the 'origin' remote in ${e.cwd}; expected a git repository with an origin pointing at GitHub`;
    case "unrecognized-remote":
      return `origin remote '${e.url}' is not a GitHub repository URL; expected git@github.com:owner/name, https://github.com/owner/name, or ssh://git@github.com/owner/name`;
    case "invalid-github-repository":
      return `GITHUB_REPOSITORY '${e.value}' is not of the form owner/name`;
  }
}

export async function resolveRepository(
  options: RepositoryLookup,
): Promise<Result<Repository, RepositoryError>> {
  const declared = options.env["GITHUB_REPOSITORY"];
  if (declared) return fromGithubRepository(declared);
  const remote = await tryGit(["remote", "get-url", "origin"], { cwd: options.cwd });
  if (remote.code !== 0) return err({ kind: "no-origin", cwd: options.cwd });
  return fromRemoteUrl(remote.stdout.trim());
}

export interface InvalidSlug {
  readonly kind: "invalid-slug";
  readonly slug: string;
}

export function parseRepository(slug: string): Result<Repository, InvalidSlug> {
  const parts = slug.split("/");
  if (parts.length !== 2) return err({ kind: "invalid-slug", slug });
  const [owner, name] = parts as [string, string];
  if (!OWNER.test(owner) || !NAME.test(name) || isDotSegment(name)) {
    return err({ kind: "invalid-slug", slug });
  }
  return ok({ owner, name, slug: `${owner}/${name}` });
}

function fromGithubRepository(value: string): Result<Repository, RepositoryError> {
  const parsed = parseRepository(value);
  if (!parsed.ok) return err({ kind: "invalid-github-repository", value });
  return ok(parsed.value);
}

function fromRemoteUrl(url: string): Result<Repository, RepositoryError> {
  const slug = REMOTE_PATTERNS.map((pattern) => pattern.exec(url)?.groups?.["slug"]).find(
    (match) => match !== undefined,
  );
  if (slug === undefined) return err({ kind: "unrecognized-remote", url });
  const parsed = parseRepository(slug);
  if (!parsed.ok) return err({ kind: "unrecognized-remote", url });
  return ok(parsed.value);
}

function isDotSegment(name: string): boolean {
  return name === "." || name === "..";
}
