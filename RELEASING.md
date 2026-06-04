# Releasing

**You only tag. CI publishes to npm.** No `npm login`, no `npm publish`, no token — never run those by hand.

To cut a release, from a clean `main`:

```sh
npm version patch        # or minor / major
git push --follow-tags
```

`npm version` bumps `package.json`, commits that bump, and creates the matching `v<version>` tag — all three in lockstep. `--follow-tags` pushes the commit and the tag together. That tag push is the entire release trigger.

> **Tag and `package.json` must agree.** The workflow's first step fails the release if `v<tag>` ≠ `package.json` version. Always bump with `npm version` (which keeps them in sync) — don't hand-tag a commit whose `package.json` wasn't bumped, and don't bump `package.json` without letting `npm version` create the tag.

The `release.yml` workflow fires on any `v*` tag push and does the rest:

1. Verifies the tag matches `package.json` version
2. Runs lint + tests
3. Builds `dist/`
4. `npm publish --access public --provenance` using OIDC

`--provenance` records a supply-chain attestation linking the published tarball to this commit + workflow run. Visible on the package page on npmjs.com.

If a release doesn't appear on npm, check the **Actions** tab for the `release` run — a lint/test/build failure or a tag/version mismatch stops the publish there.

## One-time setup (Trusted Publishing via OIDC)

Configure once on npmjs.com — no token to manage or rotate.

1. https://www.npmjs.com/package/@jean.gnc/harness-kit/access → "Trusted publishers" → "Add"
2. Provider: **GitHub Actions**
3. Organization: `jeangnc`
4. Repository: `harness-kit`
5. Workflow filename: `release.yml`
6. Environment name: *(leave blank)*

The workflow already has `permissions: id-token: write`, so `npm publish` requests an OIDC token from GitHub at publish time, npm verifies it matches the trusted-publisher config, and the package ships.
