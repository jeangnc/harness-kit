import { parseArgs } from "node:util";
import { selectProject } from "./index.js";

try {
  const { values } = parseArgs({
    options: { project: { type: "string" }, "state-root": { type: "string" } },
  });
  if (!values.project || !values["state-root"]) {
    throw new Error("Project selection requires --project and --state-root");
  }
  console.log(await selectProject({ project: values.project, stateRoot: values["state-root"] }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Project selection failed");
  process.exitCode = 1;
}
