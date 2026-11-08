# Project Codex CLI homes

`harness project` prepares an independent `CODEX_HOME` for each canonical Git checkout, including linked worktrees. Setup uses Git, ripgrep, Node, and the native Codex CLI. Directory entry only needs direnv to export the prepared home's path.

Homes default to `~/.codex/projects/<checkout-directory-name>`. Use `--state-root` for another parent directory or `--home-name foo-feature` for a different readable name. Names must be single directory components without surrounding whitespace or line breaks. If another checkout already owns a name, setup refuses it; choose a different name and use it for subsequent commands.

## Explicit presets

A preset is local JSON configuration with a name, local compiled marketplaces, TOML settings, and optional instruction text. The toolkit supplies no organization choices, credential policy, trust grants, or personal files. Keep paths and project choices in local configuration.

```json
{
  "name": "foo",
  "marketplaces": [
    { "name": "foo-marketplace", "path": "/absolute/path/to/marketplace/dist/codex" }
  ],
  "config": "cli_auth_credentials_store = \"file\"\nmcp_oauth_credentials_store = \"file\"\n[projects.\"/absolute/path/to/foo\"]\ntrust_level = \"trusted\"\n[plugins.\"foo@foo-marketplace\"]\nenabled = true\n",
  "instructions": "Use the project's conventions.\n"
}
```

The example explicitly chooses file credential storage and trusts one checkout. Choose those settings deliberately. Presets may contain private configuration; store them with private permissions. Neither credentials nor previous session history are copied.

## Setup and enrollment

```sh
harness project setup --project /absolute/path/to/foo --preset /absolute/path/to/preset.json --dry-run
harness project setup --project /absolute/path/to/foo --preset /absolute/path/to/preset.json
harness project enroll --project /absolute/path/to/foo
direnv allow /absolute/path/to/foo
harness project verify --project /absolute/path/to/foo --environment direnv
```

Setup seeds a private home outside the checkout, registers marketplaces, and installs the union of plugins enabled at root and nested config scopes. Every existing `.codex/config.toml` stays unchanged. Temporary installer enablement is restored byte for byte so nested selections stay nested. Setup writes a readiness marker after checking native plugin and MCP inventories.

Enrollment checks readiness, appends one `export CODEX_HOME=~/.codex/projects/foo` line to `.envrc`, and locally excludes an untracked `.envrc`. Paths inside the user home use an unquoted `~`; other path characters are quoted when needed. Directory entry runs no toolkit code. Enrollment preserves previous contents in a private home backup and never grants direnv approval. Review the resulting file before running `direnv allow`. Enable direnv's shell hook, then re-enter the directory. Leaving restores the previous environment. Nested `.envrc` files must use `source_up` to load the parent selection.

Verify checks enabled plugins, explicit MCP enablement, and enabled-hook trust in each discovered config scope. `--environment direnv` also checks selection in each scope. It does not connect to MCP endpoints or call a model. Review pending hooks through `/hooks` in that project's Codex session. Sign in separately in each home; external credentials and user-wide skills remain shared. Desktop apps do not inherit a terminal's direnv environment.

## Updates and recovery

Rerun setup after changing plugin selection. Bump each changed plugin's version before compiling its marketplace; same-version native caches are retained. Existing home settings and instructions remain user-owned, including on repeated setup. To change those values later, edit the home directly. Changing a preset name is refused for an existing home.

Moving a checkout creates a new identity. Remove its old `CODEX_HOME` export, then run setup, enrollment, and `direnv allow` for the new location. Choose a fresh `--home-name` if the previous checkout already owns the default name. New worktrees require setup and distinct names. A failed setup clears readiness until a successful retry; an existing `.envrc` still exports its fixed path, so complete setup and verify before using that home. An interrupted setup may leave `.setup-lock`; confirm no installer is running before removing it. An interrupted native install preserves `config.before-install.toml` when restoration is needed; restore that private backup deliberately before retrying.

To stop selection, remove the appended `export CODEX_HOME=...` line from `.envrc`, then run `direnv allow`. Retain the home to keep its sessions and credentials. Its `envrc.before-setup` backup may contain secrets; use it only if restoring it would preserve later edits.

## API

The package exports `locateProject`, `prepareProject`, `setupProject`, `enrollProject`, `verifyProject`, and `selectProject`, plus their project types. `prepareProject` accepts an explicit `ProjectPreset` with a parsed TOML `config` object. The CLI accepts TOML text in JSON for the same settings.

```ts
const location = await locateProject({ project: checkout, stateRoot });
const plan = await prepareProject({ location, preset });
await setupProject(plan);
await enrollProject(plan);
await verifyProject(plan, { environment: "none" });
```

Approval stays with the caller. `selectProject` only returns a ready home's path and never writes or installs. Runtime files stay inside their home; the toolkit delegates plugin lifecycle operations to Codex.
