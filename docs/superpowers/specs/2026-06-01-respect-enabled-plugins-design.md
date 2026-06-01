# `harness install` respects `enabledPlugins`

## Context

`harness install` discovers every plugin under `dist/<vendor>/plugins/` and, for
the claude vendor, unconditionally runs `claude plugin install <name>@<marketplace>`
(`src/vendors/claude/index.ts:61-64`). That command writes
`"<name>@<marketplace>": true` into `~/.claude/settings.json`. When a user
symlinks their compiled `dist/claude/configs/settings.json` to
`~/.claude/settings.json`, the `true` lands back in their repo, overwriting any
`false` they set in source — and newly-built plugins appear as fresh `true`
entries.

Building a plugin and enabling it are orthogonal concerns. harness-kit currently
conflates them: *discovered ⇒ installed ⇒ enabled*. This spec decouples them so
the source `enabledPlugins` is the source of truth for enable/disable.

## Goal

A plugin marked `false` in the vendor's compiled `settings.json` `enabledPlugins`
is **built and its marketplace registered, but not enabled** (no `claude plugin
install`). Everything else installs as before.

## Decisions

- **Rule:** install a plugin unless it is explicitly `false` in `enabledPlugins`.
  **Absent ⇒ enabled** (backward-compatible — existing users see no change).
- **Mechanism:** for a disabled plugin, the marketplace refresh still runs (so the
  plugin is *available*), but `claude plugin install` is **skipped**. Disabled
  means "registered, not enabled".
- **Read source:** the compiled `dist/claude/configs/settings.json`, located via
  the vendor's existing `configsOutDir(distRoot)`. It is the compiled output of
  the user's source intent and is never written by Claude — avoiding the
  self-pollution loop that reading live `~/.claude/settings.json` would cause.
- **Scope:** claude-vendor-only. Codex has no enable/disable concept
  (`src/vendors/codex/index.ts` only caches plugin dirs), so it is untouched.

## Design

### Boundary

The logic is **claude-vendor-local**, not a shared install-pipeline concern. The
settings format (`enabledPlugins`, the `"name@marketplace"` key shape) is
claude-specific; codex's `config.toml` has no equivalent. `VendorInstallContext`
already carries `distRoot`, and the vendor already exposes `configsOutDir`, so
`VendorInstallContext` and the codex vendor are untouched. The only shared-code
change is the dry-run plan (see Dry-run), which must surface disabled plugins
*without* parsing the settings format itself.

### Reading enabled-state

A new helper in the claude vendor module:

```
readEnabledPlugins(configsDir): Map<string, boolean>   // "name@marketplace" → enabled
```

- Missing `settings.json` → empty map (everything enabled).
- Malformed JSON → **throw** with a clear message. Silently enabling everything
  would reintroduce the bug.
- `enabledPlugins` absent or not an object → empty map.
- A plugin is **disabled** iff its key is present and strictly `=== false`.

### Install hook branch (`src/vendors/claude/index.ts`)

The top-of-hook uninstall + cache-clear loop (lines 48-58) is unchanged — a clean
slate is wanted for every plugin regardless of final enabled-state.
`refreshMarketplace(ctx)` is unchanged — it makes *all* plugins available.

The final loop (lines 61-64) changes from "install every plugin" to "install
every **enabled** plugin":

- enabled / absent-from-settings → `claude plugin install <name>@<marketplace>`,
  log `[claude] installed <name>`.
- explicitly `false` → skip, log `[claude] skipped <name> (disabled in settings)`.

### Dry-run

`runDryRun` (`src/install/index.ts:128-147`) must reflect the skip so the plan
does not lie. To keep the format knowledge vendor-local, the partition
(enabled vs disabled) is computed vendor-side and surfaced to the dry-run path
rather than reimplementing settings-parsing in the shared installer. Exact
surfacing (e.g. a vendor `planInstall` accessor vs. annotating discovered
plugins) is an implementation-plan detail; the constraint is **no
settings-format parsing in `install/index.ts`**.

## Edge cases

- Plugin in dist, absent from settings → enabled.
- Plugin `false` in settings but not in dist → not discovered, nothing to do.
- `settings.json` missing entirely → all enabled.
- Key mismatch (`foo@other-marketplace` while installing `foo@this-marketplace`)
  → does not match `foo@<ctx.marketplace>`, so `foo` is treated as absent →
  enabled. A `false` only counts for *this* marketplace.

## Test strategy

Co-located `*.test.ts`, using the existing `CommandRunner` injection seam
(`installWithRunner` accepts a fake runner) and a temp `dist` dir.

- **Unit — `readEnabledPlugins`:** missing file → empty; malformed JSON → throws;
  explicit `false` → disabled; explicit `true` → enabled; absent key → enabled;
  `enabledPlugins` missing/non-object → empty.
- **Vendor install** with fake runner + temp dist containing
  `configs/settings.json`: `claude plugin install` invoked for enabled/absent
  plugins, **not** invoked for `false` ones; marketplace refresh runs regardless.
- **Regression** mirroring the motivating case: `dev-tools` + `brand` both
  `false` → neither installed, marketplace still refreshed.
- **Dry-run:** disabled plugins are marked as skipped in the printed plan.
