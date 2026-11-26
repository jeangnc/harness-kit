import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import yaml from "js-yaml";

import { consumerWorkflow } from "./workflow.js";

interface Step {
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string | number>>;
}

interface Job {
  readonly if: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress": boolean };
  readonly steps: readonly Step[];
}

interface Workflow {
  readonly jobs: Readonly<Record<string, Job>>;
}

function jobs(): Readonly<Record<string, Job>> {
  return (yaml.load(consumerWorkflow()) as Workflow).jobs;
}

function actionStep(job: Job | undefined): Step | undefined {
  return job?.steps.find((step) => step.uses === "jeangnc/harness-kit@v1");
}

test("consumerWorkflow verifies on pull requests", () => {
  const verify = jobs()["verify"];
  equal(verify?.if, "github.event_name == 'pull_request'");
  equal(actionStep(verify)?.with?.["mode"], "verify");
});

test("consumerWorkflow releases on push with write access and serialized runs", () => {
  const release = jobs()["release"];
  equal(release?.if, "github.event_name == 'push'");
  equal(actionStep(release)?.with?.["mode"], "release");
  deepEqual(release.permissions, { contents: "write" });
  deepEqual(release.concurrency, { group: "harness-release", "cancel-in-progress": false });
});

test("consumerWorkflow checks out full history for release", () => {
  const checkout = jobs()["release"]?.steps.find((step) =>
    step.uses?.startsWith("actions/checkout"),
  );
  equal(checkout?.with?.["fetch-depth"], 0);
});
