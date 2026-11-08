import { test } from "node:test";
import { deepEqual, equal, fail, ok, rejects } from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { inspectProjectHooks } from "./hooks.js";

test("hook inspection counts enabled trusted and managed hooks as approved", async () => {
  const result = await inspectResponse([
    { key: "foo", enabled: true, trustStatus: "trusted" },
    { key: "bar", enabled: true, trustStatus: "managed" },
    { key: "baz", enabled: false, trustStatus: "trusted" },
  ]);
  deepEqual(result, [{ cwd: "/foo", trusted: 2, pending: [] }]);
});

async function inspectResponse(hooks: readonly unknown[]) {
  return inspectProjectHooks(
    { home: "/foo-home", cwds: ["/foo"] },
    {
      launch: () =>
        startNativeFixture(
          `respond({ data: [{ cwd: "/foo", hooks: ${JSON.stringify(hooks)}, errors: [], warnings: [] }] });`,
        ),
    },
  );
}

function startNativeFixture(hooksResponse: string): ChildProcessByStdio<Writable, Readable, null> {
  return startProcess(`
    import { createInterface } from "node:readline";
    let initialized = false;
    createInterface({ input: process.stdin }).on("line", (line) => {
      const request = JSON.parse(line);
      const respond = (result) => process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
      if (request.method === "initialize") {
        if (request.params.capabilities.experimentalApi !== true) process.exit(23);
        respond({ userAgent: "foo" });
      } else if (request.method === "initialized") {
        initialized = true;
      } else if (request.method === "hooks/list" && initialized) {
        ${hooksResponse}
      } else {
        process.exit(24);
      }
    });
  `);
}

function startProcess(source: string): ChildProcessByStdio<Writable, Readable, null> {
  return spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: "/",
    env: {},
    stdio: ["pipe", "pipe", "ignore"],
  });
}

test("hook inspection lists only enabled untrusted and modified hooks as pending", async () => {
  const result = await inspectResponse([
    { key: "foo", enabled: true, trustStatus: "untrusted" },
    { key: "bar", enabled: true, trustStatus: "modified" },
    { key: "baz", enabled: false, trustStatus: "untrusted" },
    { key: "qux", enabled: false, trustStatus: "modified" },
  ]);
  deepEqual(result, [{ cwd: "/foo", trusted: 0, pending: ["foo", "bar"] }]);
});

test("hook inspection returns requested directory order", async () => {
  const result = await inspectProjectHooks(
    { home: "/foo-home", cwds: ["/foo", "/bar"] },
    {
      launch: (home) => {
        equal(home, "/foo-home");
        return startNativeFixture(`
          if (JSON.stringify(request.params.cwds) !== '["/foo","/bar"]') process.exit(25);
          respond({ data: [
            { cwd: "/bar", hooks: [], errors: [], warnings: [] },
            { cwd: "/foo", hooks: [], errors: [], warnings: [] }
          ] });
        `);
      },
    },
  );
  deepEqual(result, [
    { cwd: "/foo", trusted: 0, pending: [] },
    { cwd: "/bar", trusted: 0, pending: [] },
  ]);
});

test("hook inspection rejects a missing project directory before starting Codex", async () => {
  await rejects(
    inspectProjectHooks(
      { home: "/foo-home", cwds: [] },
      { launch: () => fail("Codex must not start") },
    ),
    { message: "Codex hook inspection requires a home and project directories" },
  );
});

test("hook inspection rejects a missing home before starting Codex", async () => {
  await rejects(
    inspectProjectHooks(
      { home: "", cwds: ["/foo"] },
      { launch: () => fail("Codex must not start") },
    ),
    { message: "Codex hook inspection requires a home and project directories" },
  );
});

test("hook inspection rejects an omitted directory in the native response", async () => {
  await rejects(
    inspectProjectHooks(
      { home: "/foo-home", cwds: ["/foo"] },
      { launch: () => startNativeFixture("respond({ data: [] });") },
    ),
    { message: "Codex hook inspection omitted a requested project directory" },
  );
});

for (const directories of [["/bar"], ["/foo", "/foo"]]) {
  test(`hook inspection rejects unexpected response directories ${directories.join(", ")}`, async () => {
    const data = directories.map((cwd) => ({ cwd, hooks: [], errors: [], warnings: [] }));
    await rejects(
      inspectProjectHooks(
        { home: "/foo-home", cwds: ["/foo"] },
        { launch: () => startNativeFixture(`respond(${JSON.stringify({ data })});`) },
      ),
      { message: "Codex hook inspection received unexpected project directories" },
    );
  });
}

for (const field of ["errors", "warnings"]) {
  test(`hook inspection rejects native ${field} without exposing their contents`, async () => {
    await rejects(
      inspectProjectHooks(
        { home: "/foo-home", cwds: ["/foo"] },
        {
          launch: () =>
            startNativeFixture(
              `respond({ data: [{ cwd: "/foo", hooks: [], errors: [], warnings: [], ${field}: ["secret"] }] });`,
            ),
        },
      ),
      { message: "Codex reported hook configuration problems" },
    );
  });
}

test("hook inspection rejects unknown hook trust states", async () => {
  await rejects(inspectResponse([{ key: "foo", enabled: true, trustStatus: "unknown" }]), {
    message: "Codex hook inspection received an invalid hook list",
  });
});

test("hook inspection rejects missing hook fields", async () => {
  await rejects(inspectResponse([{ key: "secret", trustStatus: "trusted" }]), {
    message: "Codex hook inspection received an invalid hook list",
  });
});

test("hook inspection reads split responses after native notifications", async () => {
  const result = await inspectProjectHooks(
    { home: "/foo-home", cwds: ["/foo"] },
    {
      launch: () =>
        startNativeFixture(`
          process.stdout.write(JSON.stringify({ method: "foo", params: { secret: "value" } }) + "\\n");
          const response = JSON.stringify({ id: request.id, result: { data: [{ cwd: "/foo", hooks: [], errors: [], warnings: [] }] } }) + "\\n";
          process.stdout.write(response.slice(0, 10));
          setImmediate(() => process.stdout.write(response.slice(10)));
        `),
    },
  );
  deepEqual(result, [{ cwd: "/foo", trusted: 0, pending: [] }]);
});

test("hook inspection rejects native RPC errors without exposing their contents", async () => {
  await rejects(
    inspectProjectHooks(
      { home: "/foo-home", cwds: ["/foo"] },
      {
        launch: () =>
          startNativeFixture(
            `process.stdout.write(JSON.stringify({ id: request.id, error: { message: "secret" } }) + "\\n");`,
          ),
      },
    ),
    { message: "Codex could not inspect hook trust" },
  );
});

test("hook inspection rejects malformed JSON without exposing its contents", async () => {
  await rejects(
    inspectProjectHooks(
      { home: "/foo-home", cwds: ["/foo"] },
      { launch: () => startNativeFixture('process.stdout.write("secret\\n");') },
    ),
    { message: "Codex hook inspection received malformed JSON" },
  );
});

test("hook inspection rejects invalid RPC envelopes", async () => {
  await rejects(
    inspectProjectHooks(
      { home: "/foo-home", cwds: ["/foo"] },
      {
        launch: () =>
          startNativeFixture('process.stdout.write(JSON.stringify({ secret: "value" }) + "\\n");'),
      },
    ),
    { message: "Codex hook inspection received an invalid response" },
  );
});

test("hook inspection sanitizes synchronous launch failures", async () => {
  await rejects(
    inspectProjectHooks(
      { home: "/foo-home", cwds: ["/foo"] },
      {
        launch: () => {
          throw new Error("secret");
        },
      },
    ),
    { message: "Codex hook inspection could not start" },
  );
});

test("hook inspection sanitizes asynchronous launch failures", async () => {
  await rejects(
    inspectProjectHooks(
      { home: "/foo-home", cwds: ["/foo"] },
      {
        launch: () => spawn("/missing-secret-codex", [], { stdio: ["pipe", "pipe", "ignore"] }),
      },
    ),
    { message: "Codex hook inspection could not start" },
  );
});

test("hook inspection sanitizes unexpected process exits", async () => {
  await rejects(
    inspectProjectHooks(
      { home: "/foo-home", cwds: ["/foo"] },
      {
        launch: () => startNativeFixture('process.stderr.write("secret"); process.exit(42);'),
      },
    ),
    { message: "Codex hook inspection stopped unexpectedly" },
  );
});

test("hook inspection stops the native process after success", async () => {
  const server = startNativeFixture(
    'respond({ data: [{ cwd: "/foo", hooks: [], errors: [], warnings: [] }] });',
  );
  await inspectProjectHooks({ home: "/foo-home", cwds: ["/foo"] }, { launch: () => server });
  ok(server.exitCode !== null || server.signalCode !== null);
});

test("hook inspection kills a timed out process that ignores termination", async () => {
  const server = startProcess('process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);');
  await rejects(
    inspectProjectHooks(
      { home: "/foo-home", cwds: ["/foo"] },
      { launch: () => server, timeoutMs: 500 },
    ),
    { message: "Codex hook inspection timed out" },
  );
  equal(server.signalCode, "SIGKILL");
});
