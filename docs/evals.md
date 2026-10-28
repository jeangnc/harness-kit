# Evals

`harness eval` runs YAML cases in two tiers. A case file declares its `tier`, and the two
tiers carry mutually exclusive keys.

**Routing** — *did the right skill fire?* The session stops at the first `Skill` call (or after
`path.length` calls); the detector scores against an `expect` clause (`first` / `anyOf` / `path` /
`noSkill`). A session that times out counts as a run with no skill; a session that fails for any
other reason counts as an unmatched `(error)` run, so a broken environment never passes `noSkill`.

**Solving** — *did the agent produce the right thing?* The session runs to completion; the
final output, tool trajectory, and written files are graded by **deterministic assertions**
(all must pass) plus an optional **LLM-judge rubric** (one isolated call per dimension).

```yaml
suite: docs
tier: solving
cases:
  - id: writes-a-readme
    prompt: "Create a README.md describing this project."
    expectSkill: dev-tools:typescript      # optional; validated against installed skills
    assert:
      - { kind: wroteFile, path: README.md, contentMatches: "## " }
      - { kind: usedTool, tool: Write }
      - { kind: didNotUseTool, tool: Bash }
      - { kind: outputMatches, pattern: "README", regex: false }
    rubric:
      combine: { combine: fraction, threshold: 0.5 }   # or { combine: all }
      dimensions:
        - { dimension: clarity, criterion: "The README explains what the project does." }
        - { dimension: structure, criterion: "The README has clear sections." }
```

A solving run passes when every assertion passes **and** the rubric meets its combine rule;
across `runs`, the case passes when the pass rate meets `threshold` (default `runs` is 1).

## Grading a delimited answer block

When a skill renders a delimited answer (e.g. a `===REVIEW===…===` block), the model often
prefixes it with narration prose that no prompt reliably suppresses. Declare the delimiter and
the harness grades only the block, discarding the preamble:

```yaml
- id: review-block
  prompt: "Review the diff and emit a ===REVIEW=== block."
  answer: { start: "===REVIEW===", end: "===" }
  rubric:
    dimensions:
      - { dimension: format, criterion: "The verdict line is one short sentence." }
```

`start` and `end` are matched as literal substrings; the graded region runs from the first
`start` through the first `end` after it (markers included), or to end-of-output if no `end`
follows. The region feeds `outputMatches` and the rubric judge. `outputExcludes` still grades
the **full** output, so it can police forbidden text in the preamble or trailer. Text **after**
the close marker is not in the region — assert on it explicitly if it matters. A declared `answer`
whose `start` never appears in the output **fails the run** (the required block is missing).

The engine is [promptfoo](https://www.promptfoo.dev) with its `anthropic:claude-agent-sdk`
provider; the local `dist/` plugins load into every session. No API key needed: the session and
the rubric judge use the `claude` login, or `ANTHROPIC_API_KEY` when it is set. Each session runs
with `bypassPermissions` so it completes unattended regardless of the launcher's mode (a session
in plan mode would otherwise write plan files instead of the code under test). The judge model is separate from the session
model and defaults to the `opus` tier alias — judging a rubric is judgment work, and a pinned id rots:

```sh
harness eval --tier solving --model opus --judge-model fable
```
