# GitHub Action

`jeangnc/harness-kit` is a composite action that builds, checks, and lints a harness repo. In `release` mode it also regenerates one branch per vendor (`claude`, `codex`) from `.harness/<vendor>/`, so installers can point straight at a branch. `.harness/<vendor>/configs/` is never published.

The action runs the CLI version from its own `package.json`, so `@v1.4.2` of the action always runs `@jean.gnc/harness-kit@1.4.2`. The floating `@v1` tag follows the latest `1.x` release.

## Usage

```yaml
name: harness
on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: jeangnc/harness-kit@v1
        with:
          mode: verify

  release:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    concurrency:
      group: harness-release
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: jeangnc/harness-kit@v1
        with:
          mode: release
```

`harness init` writes this workflow for you.

## Inputs

| Input               | Required | Default | Description                                                                               |
| ------------------- | -------- | ------- | ----------------------------------------------------------------------------------------- |
| `mode`              | yes      | —       | `verify` runs `build`, `check`, and `lint`. `release` also runs `publish`.                |
| `vendors`           | no       | `""`    | Space-separated vendors to publish in `release` mode. Empty publishes every declared one. |
| `working-directory` | no       | `.`     | Directory containing `harness.yaml`.                                                      |

Any other `mode` fails the first step.

## Permissions

`release` mode pushes vendor branches, so the job needs:

- `permissions: contents: write`.
- `actions/checkout` with `fetch-depth: 0`.
- `concurrency: { group: harness-release, cancel-in-progress: false }`, so two pushes to `main` never race on the same branch.

Commits are authored as `github-actions[bot]`. Publishing never force-pushes; a push that would not fast-forward fails the job.

## Installing from the published branches

```sh
claude plugin marketplace add owner/repo#claude
codex plugin marketplace add owner/repo --ref codex
```
