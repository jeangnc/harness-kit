import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

export interface HookInspection {
  readonly cwd: string;
  readonly trusted: number;
  readonly pending: readonly string[];
}

interface InspectionOptions {
  readonly home: string;
  readonly cwds: readonly string[];
}

export type HookInspector = (options: InspectionOptions) => Promise<readonly HookInspection[]>;

type AppServer = ChildProcessByStdio<Writable, Readable, null>;

interface InspectionDependencies {
  readonly launch?: (home: string) => AppServer;
  readonly timeoutMs?: number;
}

export async function inspectProjectHooks(
  options: InspectionOptions,
  dependencies: InspectionDependencies = {},
): Promise<readonly HookInspection[]> {
  const parsed = InspectionOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new Error("Codex hook inspection requires a home and project directories");
  }
  const { home, cwds } = parsed.data;
  const { launch = launchAppServer, timeoutMs = 15_000 } = dependencies;
  const session = connect(startServer(launch, home), timeoutMs);
  try {
    await session.request("initialize", {
      clientInfo: { name: "harness-kit", version: "1" },
      capabilities: { experimentalApi: true },
    });
    session.notify("initialized", {});
    const result = await session.request("hooks/list", { cwds });
    return inspectionsFrom(result, cwds);
  } finally {
    await session.close();
  }
}

function launchAppServer(home: string): AppServer {
  return spawn("codex", ["app-server", "--stdio"], {
    cwd: "/",
    env: { ...process.env, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "ignore"],
  });
}

function startServer(launch: (home: string) => AppServer, home: string): AppServer {
  try {
    return launch(home);
  } catch {
    throw new Error("Codex hook inspection could not start");
  }
}

function connect(server: AppServer, timeoutMs: number) {
  const lines = createInterface({ input: server.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const closed = new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });
  const failure = new Promise<never>((_resolve, reject) => {
    server.once("error", () => {
      reject(new Error("Codex hook inspection could not start"));
    });
    server.once("close", () => {
      reject(new Error("Codex hook inspection stopped unexpectedly"));
    });
    server.stdin.on("error", () => {
      reject(new Error("Codex hook inspection could not write a request"));
    });
    server.stdout.on("error", () => {
      reject(new Error("Codex hook inspection could not read a response"));
    });
  });
  let sequence = 0;
  return {
    request: async (method: string, params: unknown): Promise<unknown> => {
      const id = ++sequence;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Codex hook inspection timed out"));
        }, timeoutMs);
      });
      try {
        send(server.stdin, { id, method, params });
        return await Promise.race([responseFrom(iterator, id), failure, expired]);
      } finally {
        clearTimeout(timeout);
      }
    },
    notify: (method: string, params: unknown): void => {
      send(server.stdin, { method, params });
    },
    close: async (): Promise<void> => {
      lines.close();
      server.stdin.end();
      const timeout = setTimeout(() => server.kill("SIGKILL"), 250);
      server.kill("SIGTERM");
      try {
        await closed;
      } finally {
        clearTimeout(timeout);
        server.stdin.destroy();
        server.stdout.destroy();
      }
    },
  };
}

function send(stdin: Writable, message: unknown): void {
  try {
    stdin.write(JSON.stringify(message) + "\n");
  } catch {
    throw new Error("Codex hook inspection could not write a request");
  }
}

async function responseFrom(iterator: AsyncIterator<string>, id: number): Promise<unknown> {
  for (;;) {
    const next = await nextLine(iterator);
    if (next.done) throw new Error("Codex hook inspection stopped unexpectedly");
    const message = parseMessage(next.value);
    if (message.id !== id) continue;
    if ("error" in message) throw new Error("Codex could not inspect hook trust");
    return message.result;
  }
}

async function nextLine(iterator: AsyncIterator<string>): Promise<IteratorResult<string>> {
  try {
    return await iterator.next();
  } catch {
    throw new Error("Codex hook inspection could not read a response");
  }
}

function parseMessage(line: string) {
  let input: unknown;
  try {
    input = JSON.parse(line);
  } catch {
    throw new Error("Codex hook inspection received malformed JSON");
  }
  const parsed = MessageSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Codex hook inspection received an invalid response");
  }
  return parsed.data;
}

function inspectionsFrom(result: unknown, cwds: readonly string[]): readonly HookInspection[] {
  const parsed = HooksListSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error("Codex hook inspection received an invalid hook list");
  }
  const expected = new Set(cwds);
  const inspections = new Map<string, HookInspection>();
  for (const { cwd, hooks, errors, warnings } of parsed.data.data) {
    if (!expected.has(cwd) || inspections.has(cwd)) {
      throw new Error("Codex hook inspection received unexpected project directories");
    }
    if (errors.length > 0 || warnings.length > 0) {
      throw new Error("Codex reported hook configuration problems");
    }
    const enabled = hooks.filter((hook) => hook.enabled);
    const pending = enabled.filter((hook) => !isApproved(hook.trustStatus)).map((hook) => hook.key);
    inspections.set(cwd, { cwd, trusted: enabled.length - pending.length, pending });
  }
  return cwds.map((cwd) => {
    const inspection = inspections.get(cwd);
    if (!inspection) {
      throw new Error("Codex hook inspection omitted a requested project directory");
    }
    return inspection;
  });
}

function isApproved(status: string): boolean {
  return status === "trusted" || status === "managed";
}

const InspectionOptionsSchema = z.object({
  home: z.string().min(1),
  cwds: z.array(z.string().min(1)).min(1),
});

const MessageSchema = z
  .object({
    id: z.number().int().optional(),
    method: z.string().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .refine((message) =>
    message.id === undefined
      ? message.method !== undefined
      : "result" in message !== "error" in message,
  );

const HooksListSchema = z.object({
  data: z.array(
    z.object({
      cwd: z.string().min(1),
      hooks: z.array(
        z.object({
          key: z.string().min(1),
          enabled: z.boolean(),
          trustStatus: z.enum(["trusted", "managed", "untrusted", "modified"]),
        }),
      ),
      errors: z.array(z.unknown()),
      warnings: z.array(z.unknown()),
    }),
  ),
});
