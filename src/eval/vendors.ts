export interface AgentSession {
  readonly label: string;
  readonly cwd: string;
  readonly model?: string;
  readonly pluginRoots: readonly string[];
  readonly enabledPlugins: ReadonlySet<string>;
  readonly stopAfterSkills?: number;
}

export interface ProviderSpec<Config> {
  readonly id: string;
  readonly label?: string;
  readonly config: Config;
}

export interface EvalVendor<AgentConfig = unknown, JudgeConfig = unknown> {
  readonly name: string;
  readonly agent: (session: AgentSession) => ProviderSpec<AgentConfig>;
  readonly judge: (model: string) => ProviderSpec<JudgeConfig>;
}

interface ClaudeAgentConfig {
  readonly apiKeyRequired: false;
  readonly allow_all_tools: true;
  readonly permission_mode: "bypassPermissions";
  readonly allow_dangerously_skip_permissions: true;
  readonly setting_sources: readonly string[];
  readonly working_dir: string;
  readonly plugins: ReadonlyArray<{ readonly type: "local"; readonly path: string }>;
  readonly model?: string;
  readonly settings?: { readonly enabledPlugins: Record<string, true> };
  readonly hooks?: { readonly PreToolUse: readonly SkillStopHook[] };
}

interface ClaudeJudgeConfig {
  readonly apiKeyRequired: false;
  readonly setting_sources: readonly string[];
  readonly custom_allowed_tools: readonly string[];
  readonly model: string;
}

const CLAUDE_AGENT_PROVIDER = "anthropic:claude-agent-sdk";

export const claude: EvalVendor<ClaudeAgentConfig, ClaudeJudgeConfig> = {
  name: "claude",
  agent: (session) => ({
    id: CLAUDE_AGENT_PROVIDER,
    label: session.label,
    config: {
      apiKeyRequired: false,
      allow_all_tools: true,
      permission_mode: "bypassPermissions",
      allow_dangerously_skip_permissions: true,
      setting_sources: ["user", "project", "local"],
      working_dir: session.cwd,
      plugins: session.pluginRoots.map((path) => ({ type: "local", path })),
      ...(session.model !== undefined && { model: session.model }),
      ...(session.enabledPlugins.size > 0 && {
        settings: { enabledPlugins: enabledPluginsSetting(session.enabledPlugins) },
      }),
      ...(session.stopAfterSkills !== undefined && {
        hooks: { PreToolUse: [stopAfterSkillCalls(session.stopAfterSkills)] },
      }),
    },
  }),
  judge: (model) => ({
    id: CLAUDE_AGENT_PROVIDER,
    config: { apiKeyRequired: false, setting_sources: [], custom_allowed_tools: [], model },
  }),
};

function enabledPluginsSetting(keys: ReadonlySet<string>): Record<string, true> {
  return Object.fromEntries([...keys].map((key) => [key, true]));
}

interface PreToolUseInput {
  readonly session_id: string;
}

type HookOutput = { readonly continue: false; readonly stopReason: string } | Record<string, never>;

interface SkillStopHook {
  readonly matcher: "Skill";
  readonly hooks: ReadonlyArray<(input: PreToolUseInput) => Promise<HookOutput>>;
}

export function stopAfterSkillCalls(limit: number): SkillStopHook {
  const calls = new Map<string, number>();
  const stopAtLimit = (input: PreToolUseInput): HookOutput => {
    const count = (calls.get(input.session_id) ?? 0) + 1;
    calls.set(input.session_id, count);
    return count >= limit ? { continue: false, stopReason: "routing observed" } : {};
  };
  return { matcher: "Skill", hooks: [async (input) => Promise.resolve(stopAtLimit(input))] };
}
