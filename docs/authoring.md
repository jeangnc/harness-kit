# Authoring

How to author skills — their format, composing with includes, the fragment/companion distinction, the TypeScript alternative, and the full placeholder reference.

## Authoring a skill

Skills are auto-discovered by walking `<srcRoot>/plugins/<plugin>/skills/<name>/SKILL.md`. The `name` field in frontmatter must match the skill's folder name.

```md
<!-- SKILL.md -->
---
name: my-skill
description: What the skill does — single line.
companions:
  - file: details.md
    summary: Deeper notes.
---

# My Skill

For type safety conventions, see {{skill:dev-tools:typescript}}.
For TDD discipline, see {{skill:superpowers:test-driven-development}}.
For details, see {{ref:details.md}}.

{{companions}}
```

Compiles to (once per declared vendor):

```md
<!-- dist/<vendor>/plugins/<plugin>/skills/my-skill/SKILL.md -->
---
name: my-skill
description: What the skill does — single line.
companions:
  - file: details.md
    summary: Deeper notes.
---

# My Skill

For type safety conventions, see `dev-tools:typescript`.
For TDD discipline, see `superpowers:test-driven-development`.
For details, see `details.md`.

## Companion files (read on demand)

- `details.md` — Deeper notes.
```

## Composing with includes

Use `{{include:./.fragments/foo.md}}` to inline another file verbatim into the body. Includes expand recursively (an included file may itself contain `{{include:...}}`), and any other placeholders inside the inlined content are resolved against the **host skill**, not the include source.

An include target is named one of three ways:

| Form | Resolves from | Example |
| --- | --- | --- |
| **relative** | the directory of the including file | `{{include:./.fragments/foo.md}}`, `{{include:../shared/foo.md}}` |
| **`#` repo-root anchor** | the repo root (`--repo`, default `.`) — built in, no declaration | `{{include:#src/shared/foo.md}}` |
| **`@name` alias** | a named root declared under `roots:` in `harness.yaml` | `{{include:@shared/foo.md}}` |

`#` is the repo root; `@name` is whatever path you mapped that name to. Both let a deeply-nested skill reach a shared fragment without a fragile `../../../` chain — pick `#` for an ad-hoc repo-relative path, `@name` for a stable alias you reuse across many skills.

Constraints:

- Cycles are detected and fail the compile.
- An `@name` referencing an undeclared root, or a bare `@name` / `#` with no path, fails the compile.
- Included files are not copied into `dist/` and are not flagged as undeclared companions.

There is no skill-directory boundary and no extension restriction: an include reads any file from anywhere the path points, `.md` or not.

## Fragments vs companions

Two kinds of secondary file appear next to skills, plugins, and configs. They have different lifecycles, so harness-kit gives them different conventions.

| Kind | Lifecycle | Convention | Ships to `dist/`? |
| --- | --- | --- | --- |
| **Fragment** | Compile-time only — inlined via `{{include:...}}` | Leading-dot path (e.g. `.fragments/foo.md`) | No |
| **Companion** | Runtime — read by the artifact (skill, hook, command, agent) at execution | No leading dot (e.g. `details.md`, `companions/foo.md`) | Yes |

**The rule is one sentence: leading dot = source-only.** Any source file or directory whose basename starts with `.` is stripped from dist (the vendor manifest dirs like `.claude-plugin/` are still emitted because each vendor writes them separately). Everything else ships as-is.

Example: a skill that inlines a shared snippet at compile time and ships a runtime companion alongside it.

```text
src/plugins/foo/skills/bar/
  SKILL.md                  # uses {{include:./.fragments/snippet.md}} and references details.md
  .fragments/snippet.md     # stripped from dist
  details.md                # ships; consumed at runtime
```

After `harness compile`:

```text
dist/<vendor>/plugins/foo/skills/bar/
  SKILL.md                  # snippet content inlined
  details.md                # ships unchanged
```

## Authoring with TypeScript (alternative)

If you prefer typed metadata, use `SKILL.ts` + sibling `body.md` instead of a single `SKILL.md`:

```ts
// SKILL.ts
import { defineSkill } from "@jean.gnc/harness-kit";

export default defineSkill({
  name: "my-skill",
  description: "What the skill does — single line.",
  companions: [{ file: "details.md", summary: "Deeper notes." }],
});
```

```md
<!-- body.md -->
# My Skill

For type safety conventions, see {{skill:dev-tools:typescript}}.
```

A skill folder must contain exactly one of `SKILL.md` or `SKILL.ts`. Both forms run through the same placeholder pipeline and produce identical `dist/` output.

## Placeholder reference

Three reference kinds — `skill`, `command`, `agent` — each resolve against the **local marketplace ∪ installed plugins** and render the scoped `<plugin>:<name>` handle. The author never picks a prefix based on where a target lives; a single kind covers both local and cross-plugin references.

Both `harness compile` and `harness check` share one rule, keyed on who owns the reference's plugin. An unresolved **internal** reference — one whose plugin is part of this marketplace, but whose artifact is missing — **fails**: it's your own broken link. An unresolved **external** reference — to a vendor, installed, or otherwise-unknown plugin — only **warns**, so the build stays green on a machine without those plugins installed. A malformed value (not `<plugin>:<name>` shape) is always a hard error.

Writing a reference raw — as the rendered `<plugin>:<name>` handle — instead of through its placeholder bypasses all of this; `harness check` warns (without failing) when it spots one. See [cli.md](./cli.md#harness-check).

| Placeholder | Renders to | Validation |
| --- | --- | --- |
| `{{skill:<plugin>:<name>}}` | `` `<plugin>:<name>` `` | Resolves against local marketplace + installed plugins; internal-missing fails, external-missing warns |
| `{{command:<plugin>:<name>}}` | `` `/<plugin>:<name>` `` | Resolves against local marketplace + installed plugins; internal-missing fails, external-missing warns |
| `{{agent:<plugin>:<name>}}` | `` `<plugin>:<name>` `` | Resolves against local marketplace + installed plugins; internal-missing fails, external-missing warns |
| `{{ref:<relative-path>}}` | `` `<relative-path>` `` | Must be a file under the skill directory |
| `{{include:<path>}}` | Inlined content of the target file | Relative, `#`repo-root, or `@name` alias; any extension, anywhere; no cycles |
| `{{companions}}` | Companion files section | Required iff companions are declared |
