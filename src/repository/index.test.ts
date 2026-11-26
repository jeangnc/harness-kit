import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatRepositoryError, parseRepository, resolveRepository } from "./index.js";

async function withRepo<T>(origin: string | null, fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), "harness-repository-"));
  execFileSync("git", ["init", "-q"], { cwd });
  if (origin !== null) execFileSync("git", ["remote", "add", "origin", origin], { cwd });
  return fn(cwd).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

for (const url of [
  "git@github.com:acme/widgets.git",
  "git@github.com:acme/widgets",
  "https://github.com/acme/widgets.git",
  "https://github.com/acme/widgets",
  "https://token@github.com/acme/widgets.git",
  "ssh://git@github.com/acme/widgets.git",
  "ssh://git@github.com/acme/widgets",
]) {
  test(`resolveRepository parses origin ${url} into owner and name`, async () => {
    await withRepo(url, async (cwd) => {
      const result = await resolveRepository({ cwd, env: {} });
      assert.deepEqual(result, {
        ok: true,
        value: { owner: "acme", name: "widgets", slug: "acme/widgets" },
      });
    });
  });
}

test("resolveRepository prefers GITHUB_REPOSITORY over the origin remote", async () => {
  await withRepo("git@github.com:acme/widgets.git", async (cwd) => {
    const result = await resolveRepository({ cwd, env: { GITHUB_REPOSITORY: "other/thing" } });
    assert.deepEqual(result, {
      ok: true,
      value: { owner: "other", name: "thing", slug: "other/thing" },
    });
  });
});

test("resolveRepository ignores an empty GITHUB_REPOSITORY", async () => {
  await withRepo("git@github.com:acme/widgets.git", async (cwd) => {
    const result = await resolveRepository({ cwd, env: { GITHUB_REPOSITORY: "" } });
    if (!result.ok) assert.fail(formatRepositoryError(result.error));
    assert.equal(result.value.slug, "acme/widgets");
  });
});

test("resolveRepository rejects a malformed GITHUB_REPOSITORY", async () => {
  await withRepo(null, async (cwd) => {
    const result = await resolveRepository({ cwd, env: { GITHUB_REPOSITORY: "just-a-name" } });
    assert.deepEqual(result, {
      ok: false,
      error: { kind: "invalid-github-repository", value: "just-a-name" },
    });
  });
});

test("resolveRepository reports no-origin when the repo has no origin remote", async () => {
  await withRepo(null, async (cwd) => {
    const result = await resolveRepository({ cwd, env: {} });
    assert.deepEqual(result, { ok: false, error: { kind: "no-origin", cwd } });
  });
});

test("resolveRepository reports unrecognized-remote for a non-GitHub origin", async () => {
  await withRepo("https://gitlab.com/acme/widgets.git", async (cwd) => {
    const result = await resolveRepository({ cwd, env: {} });
    assert.deepEqual(result, {
      ok: false,
      error: { kind: "unrecognized-remote", url: "https://gitlab.com/acme/widgets.git" },
    });
  });
});

test("parseRepository rejects a slug with extra path segments", () => {
  assert.deepEqual(parseRepository("acme/widgets/extra"), {
    ok: false,
    error: { kind: "invalid-slug", slug: "acme/widgets/extra" },
  });
});

test("parseRepository rejects a dot-segment repository name", () => {
  assert.equal(parseRepository("acme/..").ok, false);
});

test("formatRepositoryError names the offending remote URL", () => {
  const message = formatRepositoryError({ kind: "unrecognized-remote", url: "file:///x" });
  assert.match(message, /file:\/\/\/x/);
});
