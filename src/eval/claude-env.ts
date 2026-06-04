export function scrubEnv(base: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of keys) delete env[key];
  return env;
}

export const SUBPROCESS_ENV_OVERRIDES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDECODE",
] as const;
