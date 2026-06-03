import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildLeafIndex,
  detectBarewordBypasses,
  detectBypasses,
  detectRefBypasses,
  type BarewordContext,
  type BypassHaystacks,
} from "./bypass.js";

const haystacks: BypassHaystacks = {
  skill: new Set(["dev-tools:typescript"]),
  command: new Set(["dev-tools:open-pr"]),
  agent: new Set(["pr-review:reviewer"]),
};

const NO_OWN_LEAF: BarewordContext = { ownLeaf: null };

const barewordHaystacks: BypassHaystacks = {
  skill: new Set(["gq-dev:ship-bugfix", "gq-support:triage", "gq-dev:rspec", "gq-dev:verify"]),
  command: new Set(["gq-support:triage"]),
  agent: new Set(["gq-dev:code-reviewer"]),
};

const leafIndex = buildLeafIndex(barewordHaystacks);

test("a slash reference to a known command outside a placeholder is flagged as a bypass", () => {
  const found = detectBypasses("run /dev-tools:open-pr to ship\n", haystacks);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, "dev-tools:open-pr");
  assert.equal(found[0]!.prefix, "command");
  assert.equal(found[0]!.offset, "run ".length);
});

test("a bare fully-qualified id matching a known skill is flagged as a bypass", () => {
  const found = detectBypasses("see dev-tools:typescript for types\n", haystacks);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, "dev-tools:typescript");
  assert.equal(found[0]!.prefix, "skill");
});

test("an @ mention of a known agent outside a placeholder is flagged as a bypass", () => {
  const found = detectBypasses("ask @pr-review:reviewer to look\n", haystacks);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, "pr-review:reviewer");
  assert.equal(found[0]!.prefix, "agent");
});

test("a sanctioned placeholder reference is not flagged as a bypass", () => {
  const found = detectBypasses("see {{skill:dev-tools:typescript}}\n", haystacks);
  assert.deepEqual(found, []);
});

test("a bare id that matches no known artifact is left alone as ordinary prose", () => {
  const found = detectBypasses("the ratio was 16:9 and time 10:30\n", haystacks);
  assert.deepEqual(found, []);
});

test("the slash sigil resolves to a command even when the id also names a skill", () => {
  const both: BypassHaystacks = {
    skill: new Set(["dev-tools:open-pr"]),
    command: new Set(["dev-tools:open-pr"]),
    agent: new Set(),
  };
  const found = detectBypasses("/dev-tools:open-pr\n", both);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.prefix, "command");
});

test("a bare id matching both a skill and a command is reported once per resolved kind", () => {
  const both: BypassHaystacks = {
    skill: new Set(["dev-tools:open-pr"]),
    command: new Set(["dev-tools:open-pr"]),
    agent: new Set(),
  };
  const found = detectBypasses("see dev-tools:open-pr\n", both);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((b) => b.prefix).sort(), ["command", "skill"]);
});

test("buildLeafIndex splits plugin:name to leaf and groups multi-handle leaves", () => {
  const candidates = leafIndex.get("triage");
  assert.ok(candidates);
  assert.equal(candidates.length, 2);
  assert.deepEqual([...candidates].map((c) => c.prefix).sort(), ["command", "skill"]);
  assert.equal(leafIndex.get("ship-bugfix")?.length, 1);
  assert.equal(leafIndex.get("ship-bugfix")?.[0]?.handle, "gq-dev:ship-bugfix");
});

test("a backticked known leaf in prose is flagged as a bareword bypass", () => {
  const found = detectBarewordBypasses("see `ship-bugfix` to fix\n", leafIndex, NO_OWN_LEAF);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.leaf, "ship-bugfix");
  assert.equal(found[0]!.candidates[0]!.prefix, "skill");
  assert.equal(found[0]!.offset, "see ".length);
});

test("a backticked leaf inside a placeholder is not flagged", () => {
  const found = detectBarewordBypasses(
    "see {{skill:gq-dev:ship-bugfix}}\n",
    leafIndex,
    NO_OWN_LEAF,
  );
  assert.deepEqual(found, []);
});

test("a backticked leaf inside a fenced code block is not flagged", () => {
  const body = "```\nrun `ship-bugfix` here\n```\n";
  const found = detectBarewordBypasses(body, leafIndex, NO_OWN_LEAF);
  assert.deepEqual(found, []);
});

test("an indented line is treated as prose, not code — a bareword there is still flagged", () => {
  const body = "text\n\n    a nested-bullet continuation mentioning `ship-bugfix`\n";
  const found = detectBarewordBypasses(body, leafIndex, NO_OWN_LEAF);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.leaf, "ship-bugfix");
});

test("a backticked lang-skill leaf is not flagged even when in the index", () => {
  const found = detectBarewordBypasses("run `rspec` to test\n", leafIndex, NO_OWN_LEAF);
  assert.deepEqual(found, []);
});

test("a skill backticking its own leaf is not flagged as self-reference", () => {
  const found = detectBarewordBypasses("`verify` runs the suite\n", leafIndex, {
    ownLeaf: "verify",
  });
  assert.deepEqual(found, []);
});

test("the self-reference exemption does not leak to other leaves", () => {
  const found = detectBarewordBypasses("`ship-bugfix` ships it\n", leafIndex, {
    ownLeaf: "verify",
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.leaf, "ship-bugfix");
});

test("a multi-candidate leaf emits candidates sorted by prefix then handle", () => {
  const found = detectBarewordBypasses("use `triage` now\n", leafIndex, NO_OWN_LEAF);
  assert.equal(found.length, 1);
  assert.deepEqual(
    found[0]!.candidates.map((c) => c.prefix),
    ["command", "skill"],
  );
});

test("a backticked word matching no known leaf is left alone", () => {
  const found = detectBarewordBypasses("the `widget` is here\n", leafIndex, NO_OWN_LEAF);
  assert.deepEqual(found, []);
});

test("a scoped backtick is left to detectBypasses, not matched as a bareword leaf", () => {
  const found = detectBarewordBypasses("see `gq-dev:ship-bugfix`\n", leafIndex, NO_OWN_LEAF);
  assert.deepEqual(found, []);
});

function withRefSandbox(build: (root: string) => void, run: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-kit-ref-"));
    try {
      build(root);
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "a backticked sibling .md is flagged with a {{ref:name}} suggestion",
  withRefSandbox(
    (root) => {
      mkdirSync(join(root, "skill"));
      writeFileSync(join(root, "skill", "procedure.md"), "steps\n");
    },
    async (root) => {
      const dir = join(root, "skill");
      const found = await detectRefBypasses("full detail in `procedure.md`\n", dir, root);
      assert.equal(found.length, 1);
      assert.equal(found[0]!.path, "procedure.md");
      assert.equal(found[0]!.suggestion, "procedure.md");
    },
  ),
);

test(
  "a backticked cross-dir .md resolving to one shipped target is flagged with a relative suggestion",
  withRefSandbox(
    (root) => {
      writeFileSync(join(root, "principles.md"), "principles\n");
      mkdirSync(join(root, "skills", "audit-fix"), { recursive: true });
    },
    async (root) => {
      const dir = join(root, "skills", "audit-fix");
      const found = await detectRefBypasses("see `principles.md`\n", dir, root);
      assert.equal(found.length, 1);
      assert.equal(found[0]!.suggestion, "../../principles.md");
    },
  ),
);

test(
  "a backticked .md matching no reachable file is not flagged",
  withRefSandbox(
    (root) => {
      mkdirSync(join(root, "skill"));
    },
    async (root) => {
      const found = await detectRefBypasses(
        "each skill's own `rationalizations.md`\n",
        join(root, "skill"),
        root,
      );
      assert.deepEqual(found, []);
    },
  ),
);

test(
  "a backticked .md inside a fence is not flagged",
  withRefSandbox(
    (root) => {
      mkdirSync(join(root, "skill"));
      writeFileSync(join(root, "skill", "procedure.md"), "steps\n");
    },
    async (root) => {
      const body = "```\nsee `procedure.md`\n```\n";
      const found = await detectRefBypasses(body, join(root, "skill"), root);
      assert.deepEqual(found, []);
    },
  ),
);

test(
  "an already-templated {{ref:…}} is not re-flagged",
  withRefSandbox(
    (root) => {
      mkdirSync(join(root, "skill"));
      writeFileSync(join(root, "skill", "procedure.md"), "steps\n");
    },
    async (root) => {
      const found = await detectRefBypasses(
        "see {{ref:procedure.md}}\n",
        join(root, "skill"),
        root,
      );
      assert.deepEqual(found, []);
    },
  ),
);
