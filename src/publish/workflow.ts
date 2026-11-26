const CONSUMER_WORKFLOW = `name: harness
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
`;

export function consumerWorkflow(): string {
  return CONSUMER_WORKFLOW;
}
