# Contributing

Thanks for taking the time. This doc covers the dev workflow only.

## Requirements

- Node ≥ 24
- pnpm (this repo's lockfile is pnpm)
- git
- Optional: `claude` and/or `codex` CLIs on `$PATH` — needed to exercise `install` / `uninstall` end-to-end

## Setup

```sh
git clone https://github.com/jeangnc/harness-kit.git
cd harness-kit
pnpm install --frozen-lockfile
```

`pnpm install` runs the `prepare` script, which wires up `husky`. The pre-commit hook runs `lint-staged` (Prettier + `eslint --fix`) on staged `.ts` files.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm test` | Full test suite via `tsx --test 'src/**/*.test.ts'` |
| `pnpm lint` | `tsc --noEmit` + Prettier check + ESLint |
| `pnpm lint:format` | Prettier check only |
| `pnpm lint:code` | ESLint only |
| `pnpm format` | Prettier `--write` over `src/` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build` | Clean `dist/` and compile via `tsconfig.build.json` |

## Source layout

Production code lives in `src/`:

- `layout/` — repo layout, `plugin.json` discovery, catalog loading
- `overlay/` — per-vendor effective trees
- `plugin/`, `skill/` — Zod schemas for `plugin.json` and `SKILL.md`
- `compile/` — placeholder substitution and plugin emission
- `configs/` — `configs/` emission and the link manifest
- `build.ts` — `harness build` entry
- `publish/` — vendor branch publishing and the consumer workflow
- `install/` — install / update / uninstall
- `vendors/` — Claude and Codex adapters
- `placeholders/` — placeholder lexer + substitution
- `cli.ts` — `harness` bin entry
- `index.ts` — public exports

Tests sit next to their source as `*.test.ts`. Fixture trees live in `src/compile/__fixtures__/`.

## Tests

The test runner is Node's built-in test runner via `tsx`. Any new behaviour needs a test. For pipeline behaviour, mirror the existing fixture pattern (`src/compile/__fixtures__/good`, `src/compile/__fixtures__/companionRender`) — a fully-formed mini repo the test builds.

## Style

- TypeScript strict mode, ESM only.
- Prettier and ESLint are enforced in CI; run `pnpm lint` before pushing.
- Don't add comments unless they encode an invariant the type system genuinely can't.

## Commits

Imperative, terse, sentence-case. Match the existing log: `Add X`, `Improves readability`, `Set linters up`. No conventional-commits prefix required.

## Pull requests

Branch off `main` and open the PR against `main`. CI (`.github/workflows/ci.yml`) runs `pnpm lint`, `pnpm test`, and `pnpm build` on Node 24 with pnpm 10; all jobs must be green.

## Releases

Contributors don't publish. Releases are tag-driven and use OIDC Trusted Publishing — see [RELEASING.md](./RELEASING.md) for the maintainer process.

## License

By contributing you agree your work is released under the [MIT License](./LICENSE).
