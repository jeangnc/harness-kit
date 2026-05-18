import { definePlugin } from "#harness-kit";

export default definePlugin({
  name: "foo",
  version: "1.2.3",
  description: "demo plugin used by withPlugin fixture",
  license: "MIT",
  keywords: ["fixture", "demo"],
  dependencies: ["bar-core"],
});
